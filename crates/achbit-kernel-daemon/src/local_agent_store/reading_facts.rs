//! Optional wire representation for a full, service-authenticated projection replay. No persisted index.
use super::JournalEvent;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, Write};
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
    messages: Vec<&'a RawValue>,
}

fn element_ranges(payload: &str) -> Option<Vec<Range<usize>>> {
    if !payload.trim_start().starts_with('{') {
        return None;
    }
    let field: ContextField = serde_json::from_str(payload).ok()?;
    Some(
        field
            .messages
            .into_iter()
            .map(|element| {
                let value = element.get();
                let start = value.as_ptr() as usize - payload.as_ptr() as usize;
                start..start + value.len()
            })
            .collect(),
    )
}

// The payload was validated on read. Only remove whole elements and the comma
// before the surviving suffix; pass the original JSON fragments to the writer.
struct OmitMessages<'a> {
    payload: &'a str,
    omit: Range<usize>,
}

impl serde_json::ser::Formatter for OmitMessages<'_> {
    fn write_raw_fragment<W: ?Sized + Write>(
        &mut self,
        writer: &mut W,
        fragment: &str,
    ) -> io::Result<()> {
        if std::ptr::eq(self.payload, fragment) {
            writer.write_all(&fragment.as_bytes()[..self.omit.start])?;
            writer.write_all(&fragment.as_bytes()[self.omit.end..])
        } else {
            writer.write_all(fragment.as_bytes())
        }
    }
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
    pub(crate) fn write(&mut self, out: &mut Vec<u8>, event: Event) -> serde_json::Result<()> {
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
        let Some(elements) = element_ranges(raw) else {
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
        let omit = (count > 0).then(|| {
            // JSON arrays may contain space, tab, CR or LF before the first and after the last element.
            let whitespace = [' ', '\t', '\r', '\n'];
            let start = raw[..elements[0].start].trim_end_matches(whitespace).len();
            let end = elements.get(count).map_or_else(
                || {
                    let tail = &raw[elements[count - 1].end..];
                    raw.len() - tail.trim_start_matches(whitespace).len()
                },
                |next| next.start,
            );
            start..end
        });
        if let (Some(base), Some(omit)) = (&base, omit.filter(|r| r.len() > 96)) {
            let wrapper = Prefix {
                reading_prefix: 1,
                base_sequence: base.sequence,
                prefix_count: count,
                event: &event,
            };
            wrapper.serialize(&mut serde_json::Serializer::with_formatter(
                out,
                OmitMessages { payload: raw, omit },
            ))?;
        } else {
            serde_json::to_writer(out, &event)?;
        }
        self.previous = Some(ContextBase {
            session_id: event.session_id,
            sequence: event.sequence,
            payload: event.payload,
            elements,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn encode(encoder: &mut ReadingFactsEncoder, id: &str, seq: i64, raw: String) -> String {
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
        String::from_utf8(output).unwrap()
    }

    fn write(encoder: &mut ReadingFactsEncoder, id: &str, seq: i64, raw: String) -> Value {
        serde_json::from_str(&encode(encoder, id, seq, raw)).unwrap()
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
    #[test]
    fn omission_keeps_the_original_suffix_and_resets_after_a_non_array() {
        let first = format!(r#""{}""#, "persist ˙".repeat(20));
        let mut encoder = ReadingFactsEncoder::default();
        let payload = |remaining: &str| {
            format!("{{\"messages\": [  \t{first}{remaining} \r\n ], \"extension\":1e+2}}")
        };
        let _ = encode(&mut encoder, "s", 1, payload(", 42"));
        let second = encode(&mut encoder, "s", 2, payload(", \n { \"n\":-0 }"));
        assert!(second.contains(r#""prefixCount":1"#));
        assert!(second.contains("{\"messages\": [{ \"n\":-0 } \r\n ], \"extension\":1e+2}"));
        let shorter = encode(&mut encoder, "s", 3, payload(""));
        assert!(shorter.contains("{\"messages\": [], \"extension\":1e+2}"));

        let wrong_shape = r#"{"messages":{"embedded":["arbitrary"]}}"#;
        assert!(encode(&mut encoder, "s", 4, wrong_shape.into()).contains(wrong_shape));
        assert!(write(&mut encoder, "s", 5, payload(""))
            .get("readingPrefix")
            .is_none());
        let empty = r#"{"messages": []}"#;
        assert!(encode(&mut encoder, "s", 6, empty.into()).contains(empty));
        assert!(write(&mut encoder, "s", 7, payload(""))
            .get("readingPrefix")
            .is_none());
    }
}
