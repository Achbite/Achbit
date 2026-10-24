use super::*;
use achbit_kernel_client::{ModelConnection, ModelProfile};

pub async fn connections(client: &HttpKernelClient) -> Result<Outcome, String> {
    let catalog = client
        .model_connections()
        .await
        .map_err(|e| e.to_string())?;
    let profiles = client.model_profiles().await.map_err(|e| e.to_string())?;
    for c in catalog.connections {
        println!(
            "{}  {}  {}  {}",
            c.connection.id, c.connection.name, c.connection.billing_mode, c.auth_status
        );
        for p in profiles
            .profiles
            .iter()
            .filter(|p| p.connection_id == c.connection.id)
        {
            println!(
                "  {}  {}  {}{}",
                p.id,
                p.parameters.name,
                p.parameters.model,
                if p.parameters.enabled {
                    ""
                } else {
                    " [disabled]"
                }
            );
        }
    }
    Ok(Outcome::Done)
}

pub async fn login(
    client: &HttpKernelClient,
    selector: &str,
    device_code: bool,
) -> Result<Outcome, String> {
    let catalog = client
        .model_connections()
        .await
        .map_err(|e| e.to_string())?;
    let connection_id = if let Some(c) = catalog
        .connections
        .iter()
        .find(|c| c.connection.id == selector)
    {
        if c.connection.credential_kind != "oauth" {
            return Err("此连接使用 API Key 或无需认证，请在模型与服务中配置；账号登录仅适用于 OAuth 服务。".into());
        }
        c.connection.id.clone()
    } else {
        let adapter = catalog
            .adapters
            .iter()
            .find(|a| a.id == selector && a.auth_methods.iter().any(|m| m == "browser" || m == "deviceCode"))
            .ok_or("请指定支持账号登录的连接 ID 或服务 ID（openai-codex）；API Key 套餐请在模型与服务中配置。")?;
        let connection = ModelConnection {
            id: new_id("connection"),
            name: adapter.name.clone(),
            adapter_id: adapter.id.clone(),
            billing_mode: "subscription".into(),
            base_url: adapter.default_base_url.clone(),
            credential_kind: "oauth".into(),
            credential_ref: None,
        };
        let profile = adapter.models.first().map(|m| ModelProfile {
            id: new_id("model"),
            connection_id: connection.id.clone(),
            parameters: m.clone(),
        });
        client
            .create_model_connection(&connection, profile.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        println!("连接：{}", connection.id);
        if let Some(profile) = profile {
            println!("模型：{}", profile.id);
        }
        connection.id
    };
    let flow = client
        .start_model_auth(&connection_id, device_code)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(url) = &flow.verification_url {
        println!("在浏览器中打开：\n{url}");
    }
    if let Some(code) = &flow.user_code {
        println!("设备码：{code}");
    }
    println!("等待授权；Ctrl+C 取消。");
    let operation = async {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let current = client
                .model_auth_status(&flow.id)
                .await
                .map_err(|e| e.to_string())?;
            match current.status.as_str() {
                "complete" => {
                    println!("登录完成：{connection_id}");
                    return Ok(Outcome::Done);
                }
                "failed" => return Err(current.error.unwrap_or_else(|| "登录失败".into())),
                "cancelled" => return Ok(Outcome::Cancelled),
                "pending" => {}
                _ => return Err("未知认证状态。".into()),
            }
        }
    };
    let result = tokio::select! { result = operation => result, _ = tokio::signal::ctrl_c() => Ok(Outcome::Interrupted) };
    if !matches!(result, Ok(Outcome::Done)) {
        client
            .cancel_model_auth(&flow.id)
            .await
            .map_err(|e| e.to_string())?;
    }
    result
}

pub async fn usage(
    client: &HttpKernelClient,
    id: Option<&str>,
    days: u64,
    session_id: Option<&str>,
) -> Result<Outcome, String> {
    // CLI's explicit UTC calendar range; GUI supplies its local IANA timezone.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let to = (now / 86_400_000 + 1) * 86_400_000;
    let result = client
        .model_usage(&json!({"from":to-days*86_400_000,"to":to,"timeZone":"UTC",
        "granularity":if days==1 {"hour"} else {"day"},"connectionId":id,"sessionId":session_id}))
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(Outcome::Done)
}
