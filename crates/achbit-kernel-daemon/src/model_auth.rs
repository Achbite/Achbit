use crate::model_connections::{self, ModelConnection};
use crate::prelude::*;
use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::future::IntoFuture;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

// Public OAuth client and callback contract used by the independent Pi Codex adapter.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ORIGIN: &str = "https://auth.openai.com";
const REDIRECT: &str = "http://localhost:1455/auth/callback";
const DEVICE_REDIRECT: &str = "https://auth.openai.com/deviceauth/callback";
const LOGIN_LIFETIME: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Credential {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub account_id: String,
    pub label: String,
    pub plan: Option<String>,
}

pub(crate) fn decode_credential(value: &str) -> Result<Credential, String> {
    serde_json::from_str(value).map_err(|_| "订阅凭据格式无效，请重新登录。".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthFlow {
    id: String,
    connection_id: String,
    status: String,
    method: String,
    verification_url: Option<String>,
    user_code: Option<String>,
    expires_at: u64,
    error: Option<String>,
}

struct LiveFlow {
    state: AuthFlow,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub(crate) struct AuthService {
    flows: Mutex<HashMap<String, LiveFlow>>,
    refresh: AsyncMutex<()>,
}

impl Drop for AuthService {
    fn drop(&mut self) {
        for flow in self.flows.get_mut().expect("auth flows").values_mut() {
            if let Some(task) = flow.task.take() {
                task.abort();
            }
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as u64
}

fn random_code() -> Result<String, String> {
    let mut value = [0_u8; 32];
    getrandom::fill(&mut value).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn jwt_payload(token: &str) -> Result<Value, String> {
    let encoded = token.split('.').nth(1).ok_or("授权响应缺少账号信息。")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "无法读取授权账号信息。")?;
    serde_json::from_slice(&bytes).map_err(|_| "无法读取授权账号信息。".into())
}

async fn checked_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("OpenAI 认证请求失败（HTTP {status}）。"));
    }
    response
        .json()
        .await
        .map_err(|_| "OpenAI 认证响应格式无效。".into())
}

fn credential_from_token(
    value: Value,
    previous: Option<&Credential>,
) -> Result<Credential, String> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("授权响应缺少 access token。")?;
    let access_claims = jwt_payload(access)?;
    let id_claims = value["id_token"].as_str().map(jwt_payload).transpose()?;
    let auth = access_claims
        .get("https://api.openai.com/auth")
        .ok_or("授权响应缺少账号身份。")?;
    let account_id = auth["chatgpt_account_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("授权响应缺少账号 ID。")?
        .to_owned();
    if previous.is_some_and(|credential| credential.account_id != account_id) {
        return Err("刷新返回了不同账号，请重新登录。".into());
    }
    let refresh = value["refresh_token"]
        .as_str()
        .or_else(|| previous.map(|c| c.refresh_token.as_str()))
        .filter(|s| !s.is_empty())
        .ok_or("授权响应缺少 refresh token。")?;
    let expires = value["expires_in"].as_u64().ok_or("授权响应缺少有效期。")?;
    let label = id_claims
        .as_ref()
        .and_then(|v| v["email"].as_str())
        .or_else(|| access_claims["email"].as_str())
        .or_else(|| previous.map(|c| c.label.as_str()))
        .unwrap_or(&account_id)
        .to_owned();
    Ok(Credential {
        access_token: access.into(),
        refresh_token: refresh.into(),
        expires_at: now_ms() + expires * 1000,
        account_id,
        label,
        plan: auth["chatgpt_plan_type"].as_str().map(str::to_owned),
    })
}

async fn exchange(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<Credential, String> {
    let response = client
        .post(format!("{AUTH_ORIGIN}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ])
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    credential_from_token(checked_json(response).await?, None)
}

fn write_credential(gui: &mut GuiState, id: &str, credential: &Credential) -> Result<(), String> {
    let mut next = model_connections::document(gui)?;
    let item = next["connections"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == id)
        .ok_or("连接已被移除。")?;
    if item["adapterId"] != "openai-codex" {
        return Err("连接的认证类型已经改变。".into());
    }
    let key = item["credentialRef"]
        .as_str()
        .and_then(local_secret_ref_key)
        .unwrap_or(id)
        .to_owned();
    item["credentialRef"] = json!(format!("local-secret:{key}"));
    let mut secrets = model_connections::secrets(gui)?;
    secrets[&key] = json!(serde_json::to_string(credential).map_err(|_| "无法保存授权凭据。")?);
    model_connections::store(gui, next, Some(secrets))
}

impl AuthService {
    pub(crate) async fn credential(
        &self,
        gui: &Arc<Mutex<GuiState>>,
        bound: &ModelConnection,
        account: Option<&str>,
        client: &reqwest::Client,
    ) -> Result<Credential, String> {
        let _refresh = self.refresh.lock().await;
        let credential = {
            let gui = gui.lock().expect("gui state");
            let current = model_connections::connection(&gui, &bound.id)?;
            if current.credential_ref != bound.credential_ref {
                return Err("连接凭据已改变，请开始新的对话轮次。".into());
            }
            decode_credential(
                &model_connections::read_secret(&gui, &current)?.ok_or("订阅需要登录。")?,
            )?
        };
        if account.is_some_and(|id| id != credential.account_id) {
            return Err("运行中的账号绑定已改变，请开始新的对话轮次。".into());
        }
        if credential.expires_at > now_ms() + 60_000 {
            return Ok(credential);
        }
        let response = client
            .post(format!("{AUTH_ORIGIN}/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", credential.refresh_token.as_str()),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let refreshed = credential_from_token(checked_json(response).await?, Some(&credential))?;
        let mut gui = gui.lock().expect("gui state");
        let current = model_connections::connection(&gui, &bound.id)?;
        let stored = model_connections::read_secret(&gui, &current)?.ok_or("订阅已退出登录。")?;
        if decode_credential(&stored)?.refresh_token != credential.refresh_token {
            return Err("授权状态已改变，请重试当前操作。".into());
        }
        write_credential(&mut gui, &bound.id, &refreshed)?;
        Ok(refreshed)
    }

    pub(crate) async fn cancel_connection(&self, id: &str) {
        let tasks = {
            let mut flows = self.flows.lock().expect("auth flows");
            flows
                .values_mut()
                .filter(|f| f.state.connection_id == id && f.state.status == "pending")
                .filter_map(|flow| {
                    flow.state.status = "cancelled".into();
                    flow.task.take()
                })
                .collect::<Vec<_>>()
        };
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartAuth {
    connection_id: String,
    method: String,
}

#[derive(Clone)]
struct CallbackState {
    state: String,
    sender: Arc<Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
}

async fn callback(
    State(state): State<CallbackState>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if query.get("state") != Some(&state.state) {
        return (StatusCode::BAD_REQUEST, "授权请求不匹配。");
    }
    let code = query
        .get("code")
        .cloned()
        .ok_or_else(|| "授权未完成。".to_owned());
    if let Some(sender) = state.sender.lock().expect("auth callback").take() {
        let _ = sender.send(code);
    }
    (StatusCode::OK, "已收到授权，请返回 DeepCode。")
}

pub(crate) async fn start(
    State(state): State<AppState>,
    Json(input): Json<StartAuth>,
) -> Json<ApiResponse> {
    match start_flow(state, input).await {
        Ok(flow) => ApiResponse::ok(json!(flow)),
        Err(error) => ApiResponse::error("authentication_start_failed", error),
    }
}

async fn start_flow(state: AppState, input: StartAuth) -> Result<AuthFlow, String> {
    {
        let gui = state.gui.lock().expect("gui state");
        let connection = model_connections::connection(&gui, &input.connection_id)?;
        if connection.adapter_id != "openai-codex" {
            return Err("该连接不支持订阅登录。".into());
        }
    }
    if !matches!(input.method.as_str(), "browser" | "deviceCode") {
        return Err("登录方式无效。".into());
    }
    state
        .model_auth
        .cancel_connection(&input.connection_id)
        .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut flow = AuthFlow {
        id: new_runtime_ref("auth")?,
        connection_id: input.connection_id,
        method: input.method,
        status: "pending".into(),
        verification_url: None,
        user_code: None,
        expires_at: now_ms() + LOGIN_LIFETIME.as_millis() as u64,
        error: None,
    };
    let verifier = random_code()?;
    let mut listener = None;
    let mut callback_rx = None;
    let mut callback_app = None;
    let mut device_id = None;
    let mut interval = 5;
    if flow.method == "browser" {
        let tcp = tokio::net::TcpListener::bind(("127.0.0.1", 1455))
            .await
            .map_err(|e| format!("无法监听 OAuth 回调端口 1455：{e}"))?;
        let nonce = random_code()?;
        let (sender, receiver) = oneshot::channel();
        callback_app = Some(
            Router::new()
                .route("/auth/callback", axum::routing::get(callback))
                .with_state(CallbackState {
                    state: nonce.clone(),
                    sender: Arc::new(Mutex::new(Some(sender))),
                }),
        );
        listener = Some(tcp);
        callback_rx = Some(receiver);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = reqwest::Url::parse(&format!("{AUTH_ORIGIN}/oauth/authorize"))
            .map_err(|e| e.to_string())?;
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT),
            ("scope", "openid profile email offline_access"),
            ("state", &nonce),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "deepcode"),
        ]);
        flow.verification_url = Some(url.into());
    } else {
        let response = client
            .post(format!("{AUTH_ORIGIN}/api/accounts/deviceauth/usercode"))
            .json(&json!({"client_id":CLIENT_ID}))
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let value = checked_json(response).await?;
        device_id = Some(
            value["device_auth_id"]
                .as_str()
                .ok_or("授权响应缺少设备 ID。")?
                .to_owned(),
        );
        flow.user_code = Some(
            value["user_code"]
                .as_str()
                .ok_or("授权响应缺少设备码。")?
                .to_owned(),
        );
        interval = value["interval"]
            .as_u64()
            .or_else(|| value["interval"].as_str().and_then(|s| s.parse().ok()))
            .ok_or("授权响应缺少轮询间隔。")?
            .max(1);
        flow.verification_url = Some(format!("{AUTH_ORIGIN}/codex/device"));
    }
    let task_flow = flow.clone();
    let weak_auth = Arc::downgrade(&state.model_auth);
    let gui = state.gui.clone();
    let mut flows = state.model_auth.flows.lock().expect("auth flows");
    flows.retain(|_, value| value.state.connection_id != flow.connection_id);
    flows.insert(
        flow.id.clone(),
        LiveFlow {
            state: flow.clone(),
            task: None,
        },
    );
    let task = tokio::spawn(async move {
        let operation = async {
            if let (Some(listener), Some(app), Some(receiver)) =
                (listener, callback_app, callback_rx)
            {
                let server = axum::serve(listener, app).into_future();
                let code = tokio::select! {
                    result = receiver => result.map_err(|_| "授权回调已关闭。".to_owned())??,
                    result = server => return Err(format!("授权回调服务已停止：{result:?}")),
                };
                exchange(&client, &code, &verifier, REDIRECT).await
            } else {
                loop {
                    tokio::time::sleep(Duration::from_secs(interval)).await;
                    let response = client
                        .post(format!("{AUTH_ORIGIN}/api/accounts/deviceauth/token"))
                        .json(
                            &json!({"device_auth_id": device_id, "user_code": task_flow.user_code}),
                        )
                        .send()
                        .await
                        .map_err(|e| e.without_url().to_string())?;
                    if matches!(response.status().as_u16(), 403 | 404) {
                        continue;
                    }
                    if response.status().is_success() {
                        let value = checked_json(response).await?;
                        let code = value["authorization_code"]
                            .as_str()
                            .ok_or("授权响应缺少 code。")?;
                        let verifier = value["code_verifier"]
                            .as_str()
                            .ok_or("授权响应缺少 verifier。")?;
                        return exchange(&client, code, verifier, DEVICE_REDIRECT).await;
                    }
                    let status = response.status();
                    let value: Value = response
                        .json()
                        .await
                        .map_err(|_| format!("设备码认证失败（HTTP {status}）。"))?;
                    let code = value["error"]
                        .as_str()
                        .or_else(|| value["error"]["code"].as_str());
                    match code {
                        Some("deviceauth_authorization_pending") => continue,
                        Some("slow_down") => {
                            interval += 5;
                            continue;
                        }
                        _ => return Err(format!("设备码认证失败（HTTP {status}）。")),
                    }
                }
            }
        };
        let result = tokio::time::timeout(LOGIN_LIFETIME, operation)
            .await
            .unwrap_or_else(|_| Err("登录已过期，请重新发起。".into()));
        if let Some(auth) = weak_auth.upgrade() {
            let mut flows = auth.flows.lock().expect("auth flows");
            if let Some(flow) = flows
                .get_mut(&task_flow.id)
                .filter(|f| f.state.status == "pending")
            {
                let result = result.and_then(|credential| {
                    write_credential(
                        &mut gui.lock().expect("gui state"),
                        &task_flow.connection_id,
                        &credential,
                    )
                });
                match result {
                    Ok(()) => flow.state.status = "complete".into(),
                    Err(error) => {
                        flow.state.status = "failed".into();
                        flow.state.error = Some(error);
                    }
                }
            }
        }
    });
    flows.get_mut(&flow.id).unwrap().task = Some(task);
    Ok(flow)
}

pub(crate) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<ApiResponse> {
    match state.model_auth.flows.lock().expect("auth flows").get(&id) {
        Some(flow) => ApiResponse::ok(json!(flow.state)),
        None => ApiResponse::error("auth_flow_missing", "登录流程不存在或已被替换。"),
    }
}

pub(crate) async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<ApiResponse> {
    let result = {
        let mut flows = state.model_auth.flows.lock().expect("auth flows");
        flows.get_mut(&id).map(|flow| {
            let task = if flow.state.status == "pending" {
                flow.state.status = "cancelled".into();
                flow.task.take()
            } else {
                None
            };
            (flow.state.clone(), task)
        })
    };
    match result {
        Some((flow, task)) => {
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
            ApiResponse::ok(json!(flow))
        }
        None => ApiResponse::error("auth_flow_missing", "登录流程不存在。"),
    }
}

pub(crate) async fn logout(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<ApiResponse> {
    state.model_auth.cancel_connection(&id).await;
    let _refresh = state.model_auth.refresh.lock().await;
    let mut gui = state.gui.lock().expect("gui state");
    let result = (|| -> Result<(), String> {
        let connection = model_connections::connection(&gui, &id)?;
        let mut next = model_connections::document(&gui)?;
        let mut secrets = model_connections::secrets(&gui)?;
        if let Some(key) = connection
            .credential_ref
            .as_deref()
            .and_then(local_secret_ref_key)
        {
            secrets.as_object_mut().unwrap().remove(key);
        }
        if let Some(item) = next["connections"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["id"] == id)
        {
            item.as_object_mut().unwrap().remove("credentialRef");
        }
        model_connections::store(&mut gui, next, Some(secrets))
    })();
    match result {
        Ok(()) => ApiResponse::ok(json!({})),
        Err(error) => ApiResponse::error("logout_failed", error),
    }
}

pub(crate) async fn quota(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<ApiResponse> {
    match read_quota(&state, &id).await {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => ApiResponse::error("quota_read_failed", error),
    }
}

async fn read_quota(state: &AppState, id: &str) -> Result<Value, String> {
    let connection = model_connections::connection(&state.gui.lock().expect("gui state"), id)?;
    if connection.adapter_id != "openai-codex" {
        return Err("此服务未提供套餐额度接口。".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let credential = state
        .model_auth
        .credential(&state.gui, &connection, None, &client)
        .await?;
    let response = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(credential.access_token)
        .header("ChatGPT-Account-Id", credential.account_id)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("套餐额度查询失败（HTTP {status}）。"));
    }
    let raw: Value = response.json().await.map_err(|_| "额度响应格式无效。")?;
    let mut windows = Vec::new();
    append_windows(&mut windows, "codex", "Codex", &raw["rate_limit"])?;
    if let Some(additional) = raw["additional_rate_limits"].as_array() {
        for limit in additional {
            let id = limit["metered_feature"]
                .as_str()
                .ok_or("额度缺少分类标识。")?;
            append_windows(
                &mut windows,
                id,
                limit["limit_name"].as_str().unwrap_or(id),
                &limit["rate_limit"],
            )?;
        }
    }
    if windows.is_empty() {
        return Err("服务方未返回可用额度窗口。".into());
    }
    let mut result = json!({"connectionId": id, "capturedAt": now_ms(), "windows":windows});
    if raw["credits"]["has_credits"].as_bool() == Some(true) {
        result["credits"] =
            json!({"unlimited": raw["credits"]["unlimited"], "balance":raw["credits"]["balance"]});
    }
    Ok(result)
}

fn append_windows(
    output: &mut Vec<Value>,
    id: &str,
    label: &str,
    limit: &Value,
) -> Result<(), String> {
    for name in ["primary_window", "secondary_window"] {
        let window = &limit[name];
        if window.is_null() {
            continue;
        }
        let used = window["used_percent"]
            .as_f64()
            .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
            .ok_or("额度比例无效。")?;
        let duration = window["limit_window_seconds"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("额度窗口无效。")?;
        let mut value = json!({"id":format!("{id}:{name}"), "label":label, "usedPercent":used, "windowDurationSeconds":duration});
        if let Some(reset) = window["reset_at"].as_u64() {
            value["resetsAt"] = json!(reset * 1000);
        }
        output.push(value);
    }
    Ok(())
}

/// Refresh only the credential; connection, model and account remain bound to the run.
pub(crate) async fn authorize(
    state: &AppState,
    profile: &mut ResolvedLlmProfile,
) -> Result<(), String> {
    if profile.connection.credential_kind == "oauth" {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let credential = state
            .model_auth
            .credential(
                &state.gui,
                &profile.connection,
                profile.account_id.as_deref(),
                &client,
            )
            .await?;
        profile.api_key = Some(credential.access_token);
    }
    Ok(())
}
