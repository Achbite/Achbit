use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LlmProviderErrorLayer {
    Transport,
    HttpStatus,
    JsonDecode,
    SchemaDecode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderDiagnostic {
    pub reason: String,
    pub error_layer: LlmProviderErrorLayer,
    pub message: String,
    pub provider: String,
    pub profile_id: String,
    pub profile_name: String,
    pub model: String,
    pub status: Option<u16>,
    pub content_type: String,
    pub is_stream: bool,
    pub body_preview: String,
    pub body_hash: Option<String>,
    pub expected_schema: String,
}

impl fmt::Display for LlmProviderDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.reason, self.message)
    }
}
