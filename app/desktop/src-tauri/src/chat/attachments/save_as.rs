use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

use super::{ensure_attachment_file_path, safe_attachment_name};

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Opens the native Save As dialog with a suggested file name. `Ok(None)`
/// means the person cancelled it.
#[cfg(target_os = "macos")]
async fn choose_save_path(default_name: &str) -> Result<Option<PathBuf>, String> {
    let script = format!(
        "POSIX path of (choose file name with prompt \"Save As\" default name {})",
        applescript_string(default_name)
    );
    let output = tauri::async_runtime::spawn_blocking(move || {
        Command::new("osascript").arg("-e").arg(script).output()
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| format!("Unable to open the save dialog: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") {
            return Ok(None);
        }
        return Err(format!("Save dialog failed: {}", stderr.trim()));
    }
    let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if target.is_empty() {
        return Ok(None);
    }
    let target_path = PathBuf::from(&target);
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    Ok(Some(target_path))
}

/// Writes text to a file, creating its folder when needed.
fn write_text_file(target: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(target, contents).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn desktop_save_attachment_as(
    path: String,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let source = ensure_attachment_file_path(Path::new(&path))?;
    let fallback_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin");
    let requested_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name);
    let save_name = safe_attachment_name(requested_name);

    #[cfg(target_os = "macos")]
    {
        let Some(target_path) = choose_save_path(&save_name).await? else {
            return Ok(None);
        };
        std::fs::copy(&source, &target_path).map_err(|err| err.to_string())?;
        Ok(Some(target_path.display().to_string()))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let target = super::unique_download_path(&save_name)?;
        std::fs::copy(&source, &target).map_err(|err| err.to_string())?;
        Ok(Some(target.display().to_string()))
    }
}

/// Saves generated text, such as an exported session trace, where the person
/// chooses. `Ok(None)` means the dialog was cancelled.
#[tauri::command]
pub async fn desktop_save_text_file_as(
    name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let save_name = safe_attachment_name(&name);

    #[cfg(target_os = "macos")]
    {
        let Some(target_path) = choose_save_path(&save_name).await? else {
            return Ok(None);
        };
        write_text_file(&target_path, &contents)?;
        Ok(Some(target_path.display().to_string()))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let target = super::unique_download_path(&save_name)?;
        write_text_file(&target, &contents)?;
        Ok(Some(target.display().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_text_file_creates_the_folder_and_replaces_existing_text() {
        let root = std::env::temp_dir().join(format!("kordi-save-text-{}", uuid::Uuid::new_v4()));
        let target = root
            .join("nested")
            .join("kordi-trace-alex-20261114-0930.jsonl");

        write_text_file(&target, "{\"type\":\"session\"}\n").expect("first write");
        write_text_file(&target, "{\"type\":\"message\"}\n").expect("second write");

        assert_eq!(
            std::fs::read_to_string(&target).expect("read back"),
            "{\"type\":\"message\"}\n"
        );
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn text_file_names_keep_only_the_final_path_component() {
        assert_eq!(
            safe_attachment_name("../../kordi-trace-maya-20261114-0930.jsonl"),
            "kordi-trace-maya-20261114-0930.jsonl"
        );
        assert_eq!(safe_attachment_name(""), "attachment.bin");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_string_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }
}
