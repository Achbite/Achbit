use crate::prelude::*;
use crate::*;
use chrono::{DateTime, Datelike, Days, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPrice {
    model: String,
    adapter_id: String,
    input: f64,
    cache_read: f64,
    cache_write: Option<f64>,
    output: f64,
    source: String,
    effective_from: String,
    long_context: Option<LongContextPrice>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongContextPrice {
    threshold: u64,
    input_multiplier: f64,
    output_multiplier: f64,
}

pub(crate) fn prices() -> Vec<ModelPrice> {
    // Reviewed official Standard rates. Each call retains its own price snapshot.
    serde_json::from_str(include_str!("../../../config/defaults/model-prices.json"))
        .expect("bundled model prices")
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ObservedUsage {
    pub usage: Option<ProviderUsage>,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRecord {
    id: String,
    connection_id: String,
    profile_id: Option<String>,
    session_id: Option<String>,
    run_id: Option<String>,
    request_id: Option<String>,
    provider_attempt_id: Option<String>,
    purpose: String,
    started_at: u64,
    completed_at: Option<u64>,
    duration_ms: Option<f64>,
    billing_mode: String,
    requested_model: String,
    actual_model: Option<String>,
    service_tier: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    estimated_cost: Option<f64>,
    price_complete: bool,
    price: Option<ModelPrice>,
}

pub(crate) struct UsageStore {
    db: Mutex<Connection>,
    pub coverage_from: u64,
}
impl UsageStore {
    pub fn open(path: &FsPath) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS provider_usage (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
                connection_id TEXT NOT NULL, session_id TEXT, model TEXT, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS usage_time ON provider_usage(started_at);
            CREATE INDEX IF NOT EXISTS usage_connection ON provider_usage(connection_id, started_at);")
            .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO usage_meta VALUES ('coverageFrom', ?1)",
            [crate::model_auth::now_ms() as i64],
        )
        .map_err(|e| e.to_string())?;
        let coverage_from = db
            .query_row(
                "SELECT value FROM usage_meta WHERE key='coverageFrom'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            db: Mutex::new(db),
            coverage_from,
        })
    }

    pub fn begin(
        self: &Arc<Self>,
        profile: &ResolvedLlmProfile,
        identity: &Value,
    ) -> Result<UsageCall, String> {
        // A physical HTTP attempt is counted once. Retrying creates another attempt, not another Session fact.
        let started = std::time::Instant::now();
        let record = CallRecord {
            id: new_runtime_ref("usage")?,
            connection_id: profile.connection.id.clone(),
            profile_id: identity["profileId"].as_str().map(str::to_owned),
            session_id: identity["sessionId"].as_str().map(str::to_owned),
            run_id: identity["runId"].as_str().map(str::to_owned),
            request_id: identity["requestId"].as_str().map(str::to_owned),
            provider_attempt_id: identity["providerAttemptId"].as_str().map(str::to_owned),
            purpose: identity["purpose"].as_str().unwrap_or("probe").into(),
            started_at: crate::model_auth::now_ms(),
            completed_at: None,
            duration_ms: None,
            billing_mode: profile.connection.billing_mode.clone(),
            requested_model: profile.model.clone(),
            actual_model: None,
            service_tier: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            estimated_cost: None,
            price_complete: false,
            price: None,
        };
        self.save(&record)?;
        Ok(UsageCall {
            started,
            store: self.clone(),
            record,
            adapter_id: profile.connection.adapter_id.clone(),
            official_endpoint: reqwest::Url::parse(&profile.connection.base_url)
                .ok()
                .is_some_and(|url| {
                    url.scheme() == "https"
                        && match profile.connection.adapter_id.as_str() {
                            "openai" => url.host_str() == Some("api.openai.com"),
                            "deepseek" => url.host_str() == Some("api.deepseek.com"),
                            _ => false,
                        }
                }),
            price_catalog: prices(),
            observed: None,
        })
    }

    fn save(&self, record: &CallRecord) -> Result<(), String> {
        let json = serde_json::to_string(record).map_err(|e| e.to_string())?;
        self.db
            .lock()
            .expect("usage store")
            .execute(
                "INSERT INTO provider_usage VALUES (?1,?2,?3,?4,?5,?6)
            ON CONFLICT(id) DO UPDATE SET model=excluded.model, record=excluded.record",
                params![
                    record.id,
                    record.started_at as i64,
                    record.connection_id,
                    record.session_id,
                    record.requested_model,
                    json
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn query(&self, query: &UsageQuery) -> Result<Value, String> {
        let tz: Tz = query.time_zone.parse().map_err(|_| "统计时区无效。")?;
        if query.to > i64::MAX as u64
            || query.to <= query.from
            || query.to - query.from > 366 * 86_400_000
            || !matches!(query.granularity.as_str(), "hour" | "day")
        {
            return Err("统计范围或粒度无效。".into());
        }
        let mut buckets = make_buckets(query, tz)?;
        let mut totals = Totals::default();
        let mut connections = BTreeMap::<String, Totals>::new();
        let mut sessions = BTreeMap::<String, Totals>::new();
        let db = self.db.lock().expect("usage store");
        let mut statement = db.prepare("SELECT record FROM provider_usage WHERE started_at>=?1 AND started_at<?2
            AND (?3 IS NULL OR connection_id=?3) AND (?4 IS NULL OR model=?4) AND (?5 IS NULL OR session_id=?5)
            ORDER BY started_at").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(
                params![
                    query.from as i64,
                    query.to as i64,
                    query.connection_id,
                    query.model_id,
                    query.session_id
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            let record: CallRecord = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            totals.add(&record);
            connections
                .entry(record.connection_id.clone())
                .or_default()
                .add(&record);
            if let Some(id) = &record.session_id {
                sessions.entry(id.clone()).or_default().add(&record);
            }
            if let Some(bucket) = buckets
                .iter_mut()
                .find(|b| record.started_at >= b.start && record.started_at < b.end)
            {
                bucket.totals.add(&record);
            }
        }
        Ok(
            json!({"query":query,"currency":"USD","coverageFrom":self.coverage_from,"totals":totals,"buckets":buckets,
            "connections":connections.into_iter().map(|(id,t)| { let mut v=json!(t);v["connectionId"]=json!(id);v }).collect::<Vec<_>>(),
            "sessions":sessions.into_iter().map(|(id,t)| { let mut v=json!(t);v["sessionId"]=json!(id);v }).collect::<Vec<_>>() }),
        )
    }
}

pub(crate) struct UsageCall {
    started: std::time::Instant,
    store: Arc<UsageStore>,
    record: CallRecord,
    adapter_id: String,
    official_endpoint: bool,
    price_catalog: Vec<ModelPrice>,
    observed: Option<ObservedUsage>,
}
impl UsageCall {
    /// Called only by an owner that observed the request end; Drop never invents completion.
    pub fn finish_timing(&mut self) -> Result<(), String> {
        if self.record.completed_at.is_none() {
            self.record.completed_at = Some(crate::model_auth::now_ms());
            self.record.duration_ms = Some(self.started.elapsed().as_secs_f64() * 1000.0);
        }
        self.store.save(&self.record)
    }

    pub fn observe(&mut self, observed: ObservedUsage) -> Result<(), String> {
        if self.observed.as_ref() == Some(&observed) {
            return Ok(());
        }
        self.record.actual_model = observed.model.clone();
        self.record.service_tier = observed.service_tier.clone();
        if let Some(usage) = observed.usage {
            self.record.input_tokens = Some(usage.input_tokens);
            self.record.output_tokens = Some(usage.output_tokens);
            self.record.cache_read_tokens = usage.cache_read_input_tokens;
            self.record.cache_write_tokens = observed.cache_write_tokens;
            if self.record.billing_mode == "metered" && self.official_endpoint {
                self.record.price = self
                    .price_catalog
                    .iter()
                    .find(|price| {
                        price.adapter_id == self.adapter_id
                            && Some(&price.model) == observed.model.as_ref()
                    })
                    .cloned()
                    .map(|price| price_at_request_start(price, self.record.started_at));
                if let Some(price) = &self.record.price {
                    let (cost, complete) = estimate(price, &observed);
                    self.record.estimated_cost = cost;
                    self.record.price_complete = complete;
                }
            }
        }
        self.store.save(&self.record)?;
        self.observed = Some(observed);
        Ok(())
    }
}

// The local estimate uses the physical request start, in UTC. Each call stores
// the actual rates selected here, so later price edits do not reprice history.
fn price_at_request_start(mut price: ModelPrice, started_at: u64) -> ModelPrice {
    if price.adapter_id == "deepseek" {
        let time = DateTime::<Utc>::from_timestamp_millis(started_at as i64)
            .expect("recorded request timestamp");
        let weekday = time.weekday().num_days_from_monday() < 5;
        let peak = weekday && ((1..4).contains(&time.hour()) || (6..10).contains(&time.hour()));
        if !peak {
            price.input *= 0.5;
            price.cache_read *= 0.5;
            price.output *= 0.5;
        }
    }
    price
}

/// Pure calculation. Unknown cache-write usage never becomes zero or ordinary input.
fn estimate(price: &ModelPrice, observed: &ObservedUsage) -> (Option<f64>, bool) {
    let Some(usage) = observed.usage else {
        return (None, false);
    };
    let multiplier = match observed.service_tier.as_deref() {
        None | Some("default" | "standard") => 1.0,
        Some("flex") if price.adapter_id == "openai" => 0.5,
        Some("fast" | "priority")
            if price.model.starts_with("gpt-6-") || price.model.starts_with("gpt-5.6-") =>
        {
            2.0
        }
        _ => return (None, false),
    };
    let (input_multiplier, output_multiplier) = price
        .long_context
        .as_ref()
        .filter(|p| usage.input_tokens > p.threshold)
        .map(|p| (p.input_multiplier, p.output_multiplier))
        .unwrap_or((1.0, 1.0));
    let mut cost = usage.output_tokens as f64 * price.output * output_multiplier;
    let mut complete = false;
    if let Some(read) = usage.cache_read_input_tokens {
        cost += read as f64 * price.cache_read * input_multiplier;
        let writes = if price.cache_write.is_none() {
            Some(0)
        } else {
            observed.cache_write_tokens
        };
        if let Some(write) = writes {
            if let Some(ordinary) = usage
                .input_tokens
                .checked_sub(read)
                .and_then(|v| v.checked_sub(write))
            {
                cost += (ordinary as f64 * price.input
                    + write as f64 * price.cache_write.unwrap_or(0.0))
                    * input_multiplier;
                complete = true;
            }
        }
    }
    (Some(cost * multiplier / 1_000_000.0), complete)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UsageQuery {
    from: u64,
    to: u64,
    time_zone: String,
    granularity: String,
    connection_id: Option<String>,
    model_id: Option<String>,
    session_id: Option<String>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    calls: u64,
    reported_calls: u64,
    priced_calls: u64,
    cache_reported_calls: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    estimated_cost: Option<f64>,
}
impl Totals {
    fn add(&mut self, record: &CallRecord) {
        self.calls += 1;
        if let (Some(input), Some(output)) = (record.input_tokens, record.output_tokens) {
            self.reported_calls += 1;
            self.input_tokens += input;
            self.output_tokens += output;
        }
        if let Some(cache) = record.cache_read_tokens {
            self.cache_reported_calls += 1;
            self.cache_read_tokens += cache;
        }
        if let Some(cost) = record.estimated_cost {
            *self.estimated_cost.get_or_insert(0.0) += cost;
        }
        if record.price_complete {
            self.priced_calls += 1;
        }
    }
}
#[derive(Serialize)]
struct Bucket {
    start: u64,
    end: u64,
    label: String,
    #[serde(flatten)]
    totals: Totals,
}
fn make_buckets(query: &UsageQuery, tz: Tz) -> Result<Vec<Bucket>, String> {
    let mut cursor = DateTime::<Utc>::from_timestamp_millis(
        query.from.try_into().map_err(|_| "统计时间越界。")?,
    )
    .ok_or("统计时间越界。")?
    .with_timezone(&tz);
    let mut buckets = Vec::new();
    while (cursor.timestamp_millis() as u64) < query.to {
        let next = if query.granularity == "hour" {
            cursor
                .checked_add_signed(chrono::Duration::hours(1))
                .ok_or("统计时间越界。")?
        } else {
            let day = cursor
                .date_naive()
                .checked_add_days(Days::new(1))
                .ok_or("统计时间越界。")?;
            tz.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or("统计日期没有本地午夜。")?
        };
        buckets.push(Bucket {
            start: cursor.timestamp_millis() as u64,
            end: (next.timestamp_millis() as u64).min(query.to),
            label: if query.granularity == "hour" {
                format!("{:02}:00", cursor.hour())
            } else {
                format!("{}/{}", cursor.month(), cursor.day())
            },
            totals: Totals::default(),
        });
        cursor = next;
    }
    Ok(buckets)
}
pub(crate) async fn query(
    State(state): State<AppState>,
    Json(query): Json<UsageQuery>,
) -> Json<ApiResponse> {
    match state.model_usage.query(&query) {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::error("usage_read_failed", e),
    }
}
pub(crate) async fn catalog() -> Json<ApiResponse> {
    ApiResponse::ok(json!(prices()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deepseek_local_estimate_uses_request_time_and_preserves_missing_usage() {
        let price = prices()
            .into_iter()
            .find(|price| price.model == "deepseek-flash")
            .unwrap();
        let at = |time: &str| {
            DateTime::parse_from_rfc3339(time)
                .unwrap()
                .timestamp_millis() as u64
        };
        let peak = price_at_request_start(price.clone(), at("2026-09-22T01:00:00Z"));
        let off_peak = price_at_request_start(price.clone(), at("2026-09-22T04:00:00Z"));
        let weekend = price_at_request_start(price, at("2026-09-20T01:00:00Z"));
        assert_eq!(
            (peak.input, peak.cache_read, peak.output),
            (0.3, 0.006, 1.2)
        );
        assert_eq!(
            (off_peak.input, off_peak.cache_read, off_peak.output),
            (0.15, 0.003, 0.6)
        );
        assert_eq!(weekend.input, off_peak.input);
        let missing = ObservedUsage {
            usage: None,
            model: Some("deepseek-flash".into()),
            service_tier: None,
            cache_write_tokens: None,
        };
        assert_eq!(estimate(&peak, &missing), (None, false));
    }

    #[test]
    fn price_requires_reported_cache_counts_and_retains_partial_costs() {
        let price = prices()
            .into_iter()
            .find(|p| p.model == "gpt-6-astra")
            .unwrap();
        let mut observed = ObservedUsage {
            usage: Some(ProviderUsage {
                input_tokens: 1_280_000,
                output_tokens: 176_000,
                cache_read_input_tokens: Some(896_000),
                cache_miss_input_tokens: Some(384_000),
            }),
            model: Some(price.model.clone()),
            service_tier: Some("default".into()),
            cache_write_tokens: Some(0),
        };
        let (cost, complete) = estimate(&price, &observed);
        assert!(complete);
        assert!(
            (cost.unwrap() - (384_000.0 * 20.0 + 896_000.0 * 2.0 + 176_000.0 * 75.0) / 1_000_000.0)
                .abs()
                < 1e-10
        );
        observed.cache_write_tokens = None;
        let (partial, complete) = estimate(&price, &observed);
        assert!(!complete);
        assert!(partial.unwrap() < cost.unwrap());
        observed.usage = None;
        assert_eq!(estimate(&price, &observed), (None, false));
    }
    #[test]
    fn local_day_buckets_follow_daylight_saving_instead_of_fixed_day_lengths() {
        let from = DateTime::parse_from_rfc3339("2026-03-08T00:00:00-05:00")
            .unwrap()
            .timestamp_millis() as u64;
        let to = DateTime::parse_from_rfc3339("2026-03-10T00:00:00-04:00")
            .unwrap()
            .timestamp_millis() as u64;
        let query = UsageQuery {
            from,
            to,
            time_zone: "America/New_York".into(),
            granularity: "day".into(),
            connection_id: None,
            model_id: None,
            session_id: None,
        };
        let buckets = make_buckets(&query, "America/New_York".parse().unwrap()).unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].end - buckets[0].start, 23 * 3_600_000);
        assert_eq!(buckets[0].end, buckets[1].start);
    }
}
