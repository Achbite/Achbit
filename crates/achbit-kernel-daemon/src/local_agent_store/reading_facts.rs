//! Optional wire representation for a full, service-authenticated projection replay. No persisted index.
use super::JournalEvent;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::ops::Range;

pub(crate) const READING_FACTS_V1: &str = "application/vnd.achbit.reading-facts-v1+json-seq";

type Event = JournalEvent<Box<RawValue>>;
struct ContextBase {
    session_id: String,
    sequence: i64,
    payload: Box<RawValue>,
    elements: Vec<Range<usize>>,
}

#[derive(Default)]
pub(crate) struct ReadingFactsEncoder {
    previous: Option<ContextBase>,
}

// Borrow the actual array at this specific object field. Duplicate keys, non-arrays and
// unknown context shapes remain ordinary raw records; never search for a textual marker.
#[derive(Deserialize)]
struct ContextField<'a> {
    #[serde(borrow)]
    messages: &'a RawValue,
}

fn element_ranges(payload: &str) -> Option<(Range<usize>, Vec<Range<usize>>)> {
    if !payload.trim_start().starts_with('{') {
        return None;
    }
    let messages = serde_json::from_str::<ContextField>(payload)
        .ok()?
        .messages
        .get();
    let elements: Vec<&RawValue> = serde_json::from_str(messages).ok()?;
    let range = |value: &str| {
        let start = value.as_ptr() as usize - payload.as_ptr() as usize;
        start..start + value.len()
    };
    Some((
        range(messages),
        elements
            .into_iter()
            .map(|value| range(value.get()))
            .collect(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Prefix<'a> {
    reading_prefix: u8,
    base_sequence: i64,
    prefix_count: usize,
    event: &'a Event,
}

impl ReadingFactsEncoder {
    /// Writes a single logical event, without RS/LF. Only the preceding *context* in this
    /// stream can supply a base, and only whole, byte-identical leading elements are copied.
    pub(crate) fn write(&mut self, out: &mut Vec<u8>, mut event: Event) -> serde_json::Result<()> {
        if self
            .previous
            .as_ref()
            .is_some_and(|b| b.session_id != event.session_id)
        {
            self.previous = None;
        }
        if event.event_type != "context.composed" {
            return serde_json::to_writer(out, &event);
        }
        let raw = event.payload.get();
        let Some((array, elements)) = element_ranges(raw) else {
            self.previous = None;
            return serde_json::to_writer(out, &event);
        };
        let base = self.previous.take();
        let count = base.as_ref().map_or(0, |b| {
            b.elements
                .iter()
                .zip(&elements)
                .take_while(|(left, right)| {
                    b.payload.get()[(*left).clone()] == raw[(*right).clone()]
                })
                .count()
        });
        let cut = elements.get(count).map_or(array.end - 1, |r| r.start);
        // Never inflate a small record. Replace only the original array prefix; all sibling
        // fields and the suffix (including unknown values, escapes and numeric spellings) survive.
        let original = if count > 0 && cut - (array.start + 1) > 96 {
            let mut suffix = String::with_capacity(raw.len() - (cut - array.start - 1));
            suffix.push_str(&raw[..array.start + 1]);
            suffix.push_str(&raw[cut..]);
            let original = std::mem::replace(&mut event.payload, RawValue::from_string(suffix)?);
            serde_json::to_writer(
                out,
                &Prefix {
                    reading_prefix: 1,
                    base_sequence: base.as_ref().unwrap().sequence,
                    prefix_count: count,
                    event: &event,
                },
            )?;
            original
        } else {
            serde_json::to_writer(out, &event)?;
            event.payload
        };
        self.previous = Some(ContextBase {
            session_id: event.session_id,
            sequence: event.sequence,
            payload: original,
            elements,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn write(encoder: &mut ReadingFactsEncoder, id: &str, seq: i64, raw: String) -> Value {
        let mut output = Vec::new();
        encoder
            .write(
                &mut output,
                JournalEvent {
                    schema_version: "v",
                    event_id: format!("e:{seq}"),
                    session_id: id.into(),
                    sequence: seq,
                    occurred_at: "t".into(),
                    event_type: "context.composed".into(),
                    run_id: Some(format!("r:{seq}")),
                    call_id: None,
                    payload: RawValue::from_string(raw).unwrap(),
                },
            )
            .unwrap();
        serde_json::from_slice(&output).unwrap()
    }

    #[test]
    fn only_byte_identical_prefix_elements_of_the_previous_context_are_omitted() {
        let e = json!({"utf8": "🙂 [index],\"messages\"".repeat(20), "extensions": [1, null, {"a": false}]});
        let payload = |v: Value| {
            json!({"outer":{"messages":[42]}, "messages":v, "unknown":"unchanged"}).to_string()
        };
        let first = payload(json!([e, {"name":"old"}, e]));
        let mut enc = ReadingFactsEncoder::default();
        let a = write(&mut enc, "s", 1, first.clone());
        assert_eq!(a["payload"]["messages"].as_array().unwrap().len(), 3);
        let current = payload(json!([e,{"name":"different"},e]));
        let b = write(&mut enc, "s", 2, current.clone());
        assert_eq!(
            (b["baseSequence"].as_i64(), b["prefixCount"].as_u64()),
            (Some(1), Some(1))
        );
        let mut reconstructed = b["event"]["payload"].clone();
        reconstructed["messages"]
            .as_array_mut()
            .unwrap()
            .insert(0, a["payload"]["messages"][0].clone());
        assert_eq!(
            reconstructed,
            serde_json::from_str::<Value>(&current).unwrap()
        );
        let shorter = write(&mut enc, "s", 3, payload(json!([e])));
        assert_eq!(shorter["event"]["payload"]["messages"], json!([]));
        let foreign = write(&mut enc, "other", 1, first.clone());
        assert!(foreign.get("readingPrefix").is_none());
        // Different source byte spellings of an equal decoded element are not claims of equality.
        let escaped = first.replace('🙂', "\\ud83d\\ude42");
        assert!(write(&mut enc, "other", 2, escaped)
            .get("readingPrefix")
            .is_none());
        let ambiguous = format!(r#"{{"messages":[{}],"messages":[{}]}}"#, e, e);
        assert!(write(&mut enc, "other", 3, ambiguous)
            .get("readingPrefix")
            .is_none());
        assert!(write(&mut enc, "other", 4, first)
            .get("readingPrefix")
            .is_none());
    }
}
