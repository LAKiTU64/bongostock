use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::command;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 8_000;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct MarketRequest {
    pub base_url: String,
    pub path: String,
    pub method: String,
    pub body: Option<Value>,
    pub bearer_token: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct MarketResponse {
    pub status: u16,
    pub body: String,
}

#[command]
pub async fn market_request(request: MarketRequest) -> Result<MarketResponse, String> {
    let base_url = Url::parse(request.base_url.trim())
        .map_err(|_| "外接行情地址不是有效的 URL".to_string())?;

    match base_url.scheme() {
        "http" | "https" => {}
        _ => return Err("外接行情只支持 http:// 或 https://".to_string()),
    }

    if base_url.host_str().is_none() {
        return Err("外接行情地址缺少主机名".to_string());
    }

    let path = request.path.trim();
    if !path.starts_with("/v1/") || path.contains("..") {
        return Err("外接行情路径必须是 /v1/ 下的接口".to_string());
    }

    let url = base_url
        .join(path)
        .map_err(|_| "外接行情接口路径无效".to_string())?;
    if url.scheme() != base_url.scheme() || url.host_str() != base_url.host_str() {
        return Err("外接行情接口不能跳转到其他主机".to_string());
    }

    let method = match request.method.trim().to_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err("外接行情只支持 GET 和 POST".to_string()),
    };

    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建外接行情客户端失败：{error}"))?;

    let mut builder = client.request(method, url);
    builder = builder.header("Accept", "application/json");

    if let Some(token) = request.bearer_token.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        builder = builder.bearer_auth(token);
    }

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("外接行情连接失败：{error}"))?;
    let status = response.status();

    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("外接行情响应过大，已拒绝读取".to_string());
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取外接行情响应失败：{error}"))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("外接行情响应过大，已拒绝读取".to_string());
    }

    let body = String::from_utf8(body.to_vec())
        .map_err(|_| "外接行情响应不是 UTF-8 文本".to_string())?;

    Ok(MarketResponse {
        status: status.as_u16(),
        body,
    })
}
