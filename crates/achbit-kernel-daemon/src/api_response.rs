use crate::prelude::*;

pub(crate) const LARGE_JSON_BODY_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiResponse<T = Value> {
    pub(crate) ok: bool,
    pub(crate) data: Option<T>,
    pub(crate) error: Option<String>,
    pub(crate) message: Option<String>,
}

impl ApiResponse {
    pub(crate) fn ok(data: Value) -> Json<Self> {
        Json(Self {
            ok: true,
            data: Some(data),
            error: None,
            message: None,
        })
    }

    pub(crate) fn error(code: impl Into<String>, message: impl Into<String>) -> Json<Self> {
        Json(Self {
            ok: false,
            data: None,
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }

    pub(crate) fn error_with_data(
        code: impl Into<String>,
        message: impl Into<String>,
        data: Value,
    ) -> Json<Self> {
        Json(Self {
            ok: false,
            data: Some(data),
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }
}
