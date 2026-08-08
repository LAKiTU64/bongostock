use serde::{Deserialize, Serialize};
use serde_json::from_str;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, command};
use zip::ZipArchive;

const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILES: usize = 32;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)] #[serde(rename_all = "camelCase")]
struct SkinManifest {
    schema_version: u32,
    id: String,
    name: String,
    author: String,
    engine: String,
    preview: String,
    assets: SkinAssets,
    #[serde(default)]
    layout: SkinLayout,
}

#[derive(Debug, Clone, Deserialize)] #[serde(rename_all = "camelCase")]
struct SkinAssets {
    left_idle: String,
    left_punch: String,
    right_idle: String,
    right_punch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)] #[serde(rename_all = "camelCase")]
pub struct SkinLayout {
    #[serde(default = "default_top")]
    top: String,
    #[serde(default = "default_left")]
    left: String,
    #[serde(default = "default_width")]
    width: String,
}

fn default_top() -> String { "-49%".to_string() }
fn default_left() -> String { "-12%".to_string() }
fn default_width() -> String { "107%".to_string() }

impl Default for SkinLayout {
    fn default() -> Self {
        Self {
            top: default_top(),
            left: default_left(),
            width: default_width(),
        }
    }
}

#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct ImportedSkin {
    pub id: String,
    pub name: String,
    pub author: String,
    pub engine: String,
    pub preview_path: String,
    pub left_idle_path: String,
    pub left_punch_path: String,
    pub right_idle_path: String,
    pub right_punch_path: String,
    pub layout: SkinLayout,
}

#[command]
pub async fn import_skin_pack(app: AppHandle, source_path: String) -> Result<ImportedSkin, String> {
    let source = PathBuf::from(source_path);
    let metadata = fs::metadata(&source).map_err(|error| format!("无法读取皮肤包：{error}"))?;
    if !metadata.is_file() {
        return Err("皮肤包不是文件".to_string());
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("皮肤包超过 20 MB 限制".to_string());
    }

    let file = File::open(&source).map_err(|error| format!("无法打开皮肤包：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("皮肤包不是有效的 ZIP：{error}"))?;
    if archive.len() == 0 || archive.len() > MAX_FILES {
        return Err("皮肤包文件数量不符合要求".to_string());
    }

    let mut total_uncompressed = 0_u64;
    let manifest = {
        let mut entry = archive.by_name("manifest.json").map_err(|_| "皮肤包缺少 manifest.json".to_string())?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|error| format!("读取皮肤清单失败：{error}"))?;
        from_str::<SkinManifest>(&text).map_err(|error| format!("皮肤清单格式无效：{error}"))?
    };

    validate_manifest(&manifest)?;
    let app_data = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let skin_root = app_data.join("skins");
    fs::create_dir_all(&skin_root).map_err(|error| format!("创建皮肤目录失败：{error}"))?;
    let destination = skin_root.join(&manifest.id);
    if destination.exists() {
        return Err("同 ID 皮肤已经导入".to_string());
    }

    let temp_name = format!(".{}.tmp-{}", manifest.id, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let temp = skin_root.join(temp_name);
    fs::create_dir_all(temp.join("assets")).map_err(|error| format!("创建临时皮肤目录失败：{error}"))?;

    let result = (|| {
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| format!("读取皮肤文件失败：{error}"))?;
            if entry.is_dir() { continue; }
            // ZIP uses `/` as its canonical separator, but a few Windows ZIP
            // writers store `\\` instead. Normalize first, then run the same
            // traversal and absolute-path checks on the canonical path.
            let name = normalize_entry_name(entry.name())?;
            let size = entry.size();
            total_uncompressed = total_uncompressed.saturating_add(size);
            if size > MAX_ENTRY_BYTES || total_uncompressed > MAX_UNCOMPRESSED_BYTES {
                return Err("皮肤包解压后过大".to_string());
            }
            if name != "manifest.json" && name != "preview.png" && !name.starts_with("assets/") && name != "NOTICE.txt" {
                return Err(format!("皮肤包包含不允许的文件：{name}"));
            }

            let destination_path = temp.join(&name);
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建皮肤文件夹失败：{error}"))?;
            }
            let mut bytes = Vec::with_capacity(size.min(MAX_ENTRY_BYTES) as usize);
            entry.read_to_end(&mut bytes).map_err(|error| format!("读取皮肤图片失败：{error}"))?;
            let mut output = OpenOptions::new().write(true).create_new(true).open(&destination_path)
                .map_err(|error| format!("写入皮肤文件失败：{error}"))?;
            output.write_all(&bytes).map_err(|error| format!("保存皮肤文件失败：{error}"))?;
        }

        for required in [&manifest.preview, &manifest.assets.left_idle, &manifest.assets.left_punch, &manifest.assets.right_idle, &manifest.assets.right_punch] {
            if !temp.join(required).is_file() {
                return Err(format!("皮肤包缺少文件：{required}"));
            }
        }

        fs::rename(&temp, &destination).map_err(|error| format!("安装皮肤包失败：{error}"))?;
        Ok::<(), String>(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result?;

    Ok(to_imported_skin(&destination, &manifest))
}

#[command]
pub async fn list_imported_skins(app: AppHandle) -> Result<Vec<ImportedSkin>, String> {
    let root = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?.join("skins");
    if !root.is_dir() { return Ok(Vec::new()); }

    let mut result = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("读取皮肤目录失败：{error}"))? {
        let entry = entry.map_err(|error| format!("读取皮肤目录项失败：{error}"))?;
        let path = entry.path();
        if !path.is_dir() { continue; }
        let manifest_path = path.join("manifest.json");
        let text = match fs::read_to_string(&manifest_path) { Ok(value) => value, Err(_) => continue };
        let manifest = match from_str::<SkinManifest>(&text) { Ok(value) => value, Err(_) => continue };
        if validate_manifest(&manifest).is_err() { continue; }
        if [&manifest.preview, &manifest.assets.left_idle, &manifest.assets.left_punch, &manifest.assets.right_idle, &manifest.assets.right_punch]
            .iter().any(|value| !path.join(value).is_file()) { continue; }
        result.push(to_imported_skin(&path, &manifest));
    }
    result.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(result)
}

#[command]
pub async fn delete_imported_skin(app: AppHandle, skin_id: String) -> Result<(), String> {
    validate_id(&skin_id)?;
    let root = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?.join("skins");
    let target = root.join(&skin_id);
    if !target.starts_with(&root) || !target.is_dir() { return Err("找不到要删除的导入皮肤".to_string()); }
    fs::remove_dir_all(target).map_err(|error| format!("删除皮肤失败：{error}"))
}

fn validate_manifest(manifest: &SkinManifest) -> Result<(), String> {
    if manifest.schema_version != 1 { return Err("不支持的皮肤包版本".to_string()); }
    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 80 || manifest.author.len() > 80 {
        return Err("皮肤名称或作者信息无效".to_string());
    }
    if manifest.engine != "layered-png-v1" { return Err("不支持的皮肤渲染引擎".to_string()); }
    for path in [&manifest.preview, &manifest.assets.left_idle, &manifest.assets.left_punch, &manifest.assets.right_idle, &manifest.assets.right_punch] {
        validate_entry_name(path)?;
        if !path.ends_with(".png") { return Err("皮肤图片必须是 PNG".to_string()); }
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 64 || !value.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') {
        return Err("皮肤 ID 只能包含字母、数字、短横线和下划线".to_string());
    }
    Ok(())
}

fn validate_entry_name(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err("皮肤包包含不安全的路径".to_string());
    }
    Ok(())
}

fn normalize_entry_name(value: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/");
    validate_entry_name(&normalized)?;
    Ok(normalized)
}

fn to_imported_skin(root: &Path, manifest: &SkinManifest) -> ImportedSkin {
    ImportedSkin {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        author: manifest.author.clone(),
        engine: manifest.engine.clone(),
        preview_path: root.join(&manifest.preview).to_string_lossy().into_owned(),
        left_idle_path: root.join(&manifest.assets.left_idle).to_string_lossy().into_owned(),
        left_punch_path: root.join(&manifest.assets.left_punch).to_string_lossy().into_owned(),
        right_idle_path: root.join(&manifest.assets.right_idle).to_string_lossy().into_owned(),
        right_punch_path: root.join(&manifest.assets.right_punch).to_string_lossy().into_owned(),
        layout: manifest.layout.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_entry_name;

    #[test]
    fn normalizes_windows_zip_separators() {
        assert_eq!(
            normalize_entry_name("assets\\CatLeft.png").unwrap(),
            "assets/CatLeft.png"
        );
    }

    #[test]
    fn rejects_parent_directory_after_normalization() {
        assert!(normalize_entry_name("assets\\..\\outside.png").is_err());
    }
}
