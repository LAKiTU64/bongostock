use keyring::Entry;
use tauri::command;

/// 服务名固定为 bundle identifier，账户名固定为 gateway-token。
/// Windows 会把两者拼成 `com.bongostock.desktop/gateway-token` 的凭据条目，
/// 因此两个值都必须保持纯 ASCII、不含空格，避免跨平台条目名不一致。
const SERVICE: &str = "com.bongostock.desktop";
const ACCOUNT: &str = "gateway-token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| format!("无法访问系统凭据存储：{error}"))
}

/// 把 Bearer Token 写入系统凭据库。写入前做一次 trim，避免用户粘贴时带上换行。
#[command]
pub fn save_gateway_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token 不能为空".to_string());
    }

    entry()?
        .set_password(token)
        .map_err(|error| format!("写入系统凭据失败：{error}"))
}

/// 读取已保存的 Token。从未保存过是正常状态，返回 None 而不是报错。
#[command]
pub fn load_gateway_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => {
            let token = token.trim().to_string();
            Ok(if token.is_empty() { None } else { Some(token) })
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取系统凭据失败：{error}")),
    }
}

/// 清除已保存的 Token。本来就没有时视为成功，便于前端无脑调用。
#[command]
pub fn clear_gateway_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("清除系统凭据失败：{error}")),
    }
}
