use super::{decode_json, LocalAgentStoreError};
use crate::local_agent_authorities::KernelAuthorityModel;
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use std::fmt;

// Serde's IgnoredAny skips some number, Unicode and depth checks. Visit discarded
// values with the normal JSON decoder, without allocating their arrays or maps.
struct Discard;
impl<'de> Visitor<'de> for Discard {
    type Value = Self;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self, A::Error> {
        while seq.next_element::<Self>()?.is_some() {}
        Ok(self)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        while map.next_entry::<Self, Self>()?.is_some() {}
        Ok(self)
    }
}
impl<'de> Deserialize<'de> for Discard {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(Self)
    }
}
struct ProviderFact(Map<String, Value>);
impl<'de> Deserialize<'de> for ProviderFact {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = ProviderFact;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a provider fact")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if KernelAuthorityModel::PROVIDER_FACT_FIELDS.contains(&key.as_str()) {
                        fields.insert(key, map.next_value()?);
                    } else {
                        map.next_value::<Discard>()?;
                    }
                }
                Ok(ProviderFact(fields))
            }
        }
        d.deserialize_map(Fields)
    }
}

pub(super) fn provider_fact(encoded: &str) -> Result<Value, LocalAgentStoreError> {
    match serde_json::from_str::<ProviderFact>(encoded) {
        Ok(fact) => Ok(Value::Object(fact.0)),
        // Historical non-object payloads and invalid data retain the original
        // decoder's result, including its location and localized error.
        Err(_) => decode_json(encoded, "permission_model_restore_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_provider_fact_preserves_full_decoder_semantics() {
        let deep = format!(r#"{{"unused":{}0{}}}"#, "[".repeat(150), "]".repeat(150));
        for input in [
            r#"{"purpose":"old","unused":[-1,0.5,{"a":"\u263a"}],"purpose":"agent","providerRequestId":{"id":2},"outcome":null}"#,
            "{}",
            "null",
            "[]",
            "42",
            r#"{"unused":1e999}"#,
            r#"{"unused":"\uD800"}"#,
            r#"{"unused":{"\uD800":4}}"#,
            r#"{"outcome":[],"x":true} trailing"#,
            &deep,
        ] {
            let select = |v: Value| {
                KernelAuthorityModel::PROVIDER_FACT_FIELDS
                    .iter()
                    .map(|k| v.get(*k).cloned().unwrap_or(Value::Null))
                    .collect::<Vec<_>>()
            };
            let outcome = |v: Result<Value, LocalAgentStoreError>| {
                v.map(select).map_err(|e| (e.code, e.message))
            };
            assert_eq!(
                outcome(provider_fact(input)),
                outcome(decode_json(input, "permission_model_restore_failed"))
            );
        }
    }
}
