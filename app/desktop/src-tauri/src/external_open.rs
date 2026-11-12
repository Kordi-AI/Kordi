use std::process::Command;

pub(crate) fn run_external_command(command: &mut Command) -> Result<(), String> {
    let status = command.status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("External open command failed with status {status}"))
    }
}

/// Opens a file on this machine in the app the system assigns to its type.
pub(crate) fn open_with_default_app(path: &std::path::Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        run_external_command(Command::new("open").arg(path))
    } else if cfg!(target_os = "windows") {
        run_external_command(Command::new("explorer").arg(path))
    } else {
        run_external_command(Command::new("xdg-open").arg(path))
    }
}

#[tauri::command]
pub(crate) fn desktop_open_external_url(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }
    if cfg!(target_os = "macos") {
        run_external_command(Command::new("open").arg(trimmed))?;
    } else if cfg!(target_os = "windows") {
        run_external_command(Command::new("explorer").arg(trimmed))?;
    } else {
        run_external_command(Command::new("xdg-open").arg(trimmed))?;
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub(crate) fn desktop_reveal_in_finder(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }
    if cfg!(target_os = "macos") {
        run_external_command(Command::new("open").arg("-R").arg(trimmed))?;
    } else if cfg!(target_os = "windows") {
        run_external_command(Command::new("explorer").arg(format!("/select,{trimmed}")))?;
    } else {
        let target = std::path::Path::new(trimmed)
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(trimmed));
        run_external_command(Command::new("xdg-open").arg(target))?;
    }
    Ok(trimmed.to_string())
}
