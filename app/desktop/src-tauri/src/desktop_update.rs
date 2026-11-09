//! Native owner of desktop update check, download and install.
//!
//! The downloaded bytes live in Rust so Kordi can install a staged update
//! when it quits, not only when the user clicks "Restart to update".

use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::cloud_session;

const OS_VERSION_HEADER: &str = "X-Kordi-OS-Version";
const UNKNOWN_COMPATIBILITY: &str = "Unable to determine this Mac’s compatibility with updates.";
const MOVE_TO_APPLICATIONS: &str = "Move Kordi to Applications to update it.";
const NO_CHECKED_UPDATE: &str = "No Kordi update is available to download.";
const DOWNLOAD_RUNNING: &str = "A Kordi update is already downloading.";
const NO_DOWNLOADED_UPDATE: &str = "No downloaded Kordi update is ready.";
const INSTALL_RUNNING: &str = "A Kordi update is already installing.";
#[cfg(target_os = "macos")]
const NOT_IN_APP_BUNDLE: &str = "Kordi is not running from an app bundle.";
#[cfg(not(target_os = "macos"))]
const UNSUPPORTED_PLATFORM: &str = "Kordi updates are only available on macOS.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InstallLocation {
    Applications,
    Elsewhere,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateMetadata {
    current_version: String,
    version: String,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateCheck {
    update: Option<DesktopUpdateMetadata>,
    location: InstallLocation,
}

/// Matches the updater plugin's JS download events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum DesktopUpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        #[serde(skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

struct DownloadedUpdate {
    version: String,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    downloaded: Option<DownloadedUpdate>,
    downloading: bool,
    installing: bool,
}

impl PendingUpdate {
    /// The checked update and its bytes, when both are for the same version.
    fn staged(&self) -> Option<(Update, Arc<Vec<u8>>)> {
        let update = self.update.as_ref()?;
        let downloaded = self.downloaded.as_ref()?;
        (downloaded.version == update.version).then(|| (update.clone(), downloaded.bytes.clone()))
    }
}

#[derive(Default)]
pub(crate) struct DesktopUpdateState(Mutex<PendingUpdate>);

impl DesktopUpdateState {
    fn lock(&self) -> MutexGuard<'_, PendingUpdate> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tauri::command]
pub(crate) async fn desktop_update_check(app: AppHandle) -> Result<DesktopUpdateCheck, String> {
    let system = tauri::async_runtime::spawn_blocking(cloud_session::cloud_device_system_metadata)
        .await
        .map_err(|_| UNKNOWN_COMPATIBILITY.to_string())?;
    if system.platform != "macos" || !is_supported_os_version(&system.os_version) {
        return Err(UNKNOWN_COMPATIBILITY.to_string());
    }
    let updater = app
        .updater_builder()
        .header(OS_VERSION_HEADER, system.os_version)
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?;
    let found = updater.check().await.map_err(|err| err.to_string())?;
    let location = current_install_location(&app);

    let state = app.state::<DesktopUpdateState>();
    let mut pending = state.lock();
    let metadata = match found {
        Some(update) => {
            let metadata = DesktopUpdateMetadata {
                current_version: update.current_version.clone(),
                version: update.version.clone(),
                body: update.body.clone(),
                date: update.date.and_then(|date| {
                    rfc3339(DateParts {
                        year: date.year(),
                        month: u8::from(date.month()),
                        day: date.day(),
                        hour: date.hour(),
                        minute: date.minute(),
                        second: date.second(),
                        nanosecond: date.nanosecond(),
                        offset: date.offset().as_hms(),
                    })
                }),
            };
            if pending
                .downloaded
                .as_ref()
                .is_some_and(|downloaded| downloaded.version != update.version)
            {
                pending.downloaded = None;
            }
            pending.update = Some(update);
            Some(metadata)
        }
        None => {
            pending.update = None;
            pending.downloaded = None;
            None
        }
    };
    Ok(DesktopUpdateCheck {
        update: metadata,
        location,
    })
}

#[tauri::command]
pub(crate) async fn desktop_update_download(
    app: AppHandle,
    on_event: Channel<DesktopUpdateDownloadEvent>,
) -> Result<(), String> {
    let location = current_install_location(&app);
    let update = {
        let state = app.state::<DesktopUpdateState>();
        let mut pending = state.lock();
        let Some(update) = pending.update.clone() else {
            return Err(NO_CHECKED_UPDATE.to_string());
        };
        if location != InstallLocation::Applications {
            return Err(MOVE_TO_APPLICATIONS.to_string());
        }
        if pending.downloading {
            return Err(DOWNLOAD_RUNNING.to_string());
        }
        if let Some((_, bytes)) = pending.staged() {
            drop(pending);
            let _ = on_event.send(DesktopUpdateDownloadEvent::Started {
                content_length: Some(bytes.len() as u64),
            });
            let _ = on_event.send(DesktopUpdateDownloadEvent::Finished);
            return Ok(());
        }
        pending.downloading = true;
        update
    };

    let mut first_chunk = true;
    let result = update
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(DesktopUpdateDownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DesktopUpdateDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DesktopUpdateDownloadEvent::Finished);
            },
        )
        .await;

    let state = app.state::<DesktopUpdateState>();
    let mut pending = state.lock();
    pending.downloading = false;
    let bytes = result.map_err(|err| err.to_string())?;
    // A newer check may have replaced the update while this one downloaded.
    if pending
        .update
        .as_ref()
        .is_some_and(|current| current.version == update.version)
    {
        pending.downloaded = Some(DownloadedUpdate {
            version: update.version.clone(),
            bytes: Arc::new(bytes),
        });
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn desktop_update_install(app: AppHandle) -> Result<(), String> {
    let location = current_install_location(&app);
    let (update, bytes) = {
        let state = app.state::<DesktopUpdateState>();
        let mut pending = state.lock();
        let Some(staged) = pending.staged() else {
            return Err(NO_DOWNLOADED_UPDATE.to_string());
        };
        if location != InstallLocation::Applications {
            return Err(MOVE_TO_APPLICATIONS.to_string());
        }
        if pending.installing {
            return Err(INSTALL_RUNNING.to_string());
        }
        pending.installing = true;
        staged
    };

    let result =
        tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice())).await;

    let state = app.state::<DesktopUpdateState>();
    let mut pending = state.lock();
    pending.installing = false;
    match result {
        Ok(Ok(())) => {
            // Nothing is left for the quit hook to install.
            *pending = PendingUpdate::default();
            Ok(())
        }
        Ok(Err(err)) => Err(err.to_string()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub(crate) fn desktop_update_reveal_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = current_app_bundle(&app).ok_or_else(|| NOT_IN_APP_BUNDLE.to_string())?;
        crate::run_external_command(Command::new("/usr/bin/open").arg("-R").arg(bundle))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED_PLATFORM.to_string())
    }
}

/// Installs a downloaded update while Kordi quits. Runs at most once.
pub(crate) fn install_downloaded_update_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopUpdateState>() else {
        return;
    };
    let staged = {
        let mut pending = state.lock();
        if pending.installing || pending.downloaded.is_none() {
            return;
        }
        std::mem::take(&mut *pending).staged()
    };
    let Some((update, bytes)) = staged else {
        return;
    };
    if current_install_location(app) != InstallLocation::Applications {
        eprintln!("[kordi] Skipped the downloaded update because Kordi is not in Applications.");
        return;
    }
    let installed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        update.install(bytes.as_slice())
    }));
    match installed {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("[kordi] Unable to install the downloaded update on quit: {err}"),
        Err(_) => eprintln!("[kordi] Installing the downloaded update on quit panicked."),
    }
}

#[cfg(target_os = "macos")]
fn current_app_bundle(app: &AppHandle) -> Option<PathBuf> {
    let executable = tauri::process::current_binary(&app.env()).ok()?;
    crate::window_lifecycle::macos_app_bundle_path(&executable)
}

fn current_install_location(app: &AppHandle) -> InstallLocation {
    #[cfg(target_os = "macos")]
    {
        let bundle = current_app_bundle(app);
        let home = std::env::var_os("HOME").map(PathBuf::from);
        classify_install_location(bundle.as_deref(), home.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        InstallLocation::Elsewhere
    }
}

/// Only `/Applications` and `~/Applications` (and their subfolders) can be
/// updated in place. A mounted DMG, Downloads, or a translocated copy cannot.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn classify_install_location(bundle: Option<&Path>, home: Option<&Path>) -> InstallLocation {
    use std::path::Component;

    let Some(bundle) = bundle else {
        return InstallLocation::Elsewhere;
    };
    if !bundle.has_root()
        || bundle.components().any(|component| match component {
            Component::ParentDir | Component::CurDir => true,
            Component::Normal(name) => name == "AppTranslocation",
            _ => false,
        })
    {
        return InstallLocation::Elsewhere;
    }
    let system_root = Path::new("/Applications").to_path_buf();
    let user_root = home
        .filter(|home| home.has_root())
        .map(|home| home.join("Applications"));
    let inside = |root: &Path| {
        bundle
            .strip_prefix(root)
            .is_ok_and(|rest| rest.components().next().is_some())
    };
    if inside(&system_root) || user_root.as_deref().is_some_and(inside) {
        InstallLocation::Applications
    } else {
        InstallLocation::Elsewhere
    }
}

/// Mirrors the frontend check: `major.minor[.patch]`, no leading zeros, each
/// part at most 65535.
fn is_supported_os_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    if !(2..=3).contains(&parts.len()) {
        return false;
    }
    parts.iter().enumerate().all(|(index, part)| {
        let digits_only = !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
        let leading_zero = part.len() > 1 && part.starts_with('0');
        let zero_major = index == 0 && *part == "0";
        digits_only
            && !leading_zero
            && !zero_major
            && part.parse::<u32>().is_ok_and(|value| value <= 65535)
    })
}

struct DateParts {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    nanosecond: u32,
    offset: (i8, i8, i8),
}

/// RFC 3339 text for the release date, like the updater plugin's JS metadata.
fn rfc3339(parts: DateParts) -> Option<String> {
    let (offset_hours, offset_minutes, offset_seconds) = parts.offset;
    if !(0..=9999).contains(&parts.year) || offset_seconds != 0 {
        return None;
    }
    let fraction = if parts.nanosecond == 0 {
        String::new()
    } else {
        let digits = format!("{:09}", parts.nanosecond);
        format!(".{}", digits.trim_end_matches('0'))
    };
    let offset = if offset_hours == 0 && offset_minutes == 0 {
        "Z".to_string()
    } else {
        let sign = if offset_hours < 0 || offset_minutes < 0 {
            '-'
        } else {
            '+'
        };
        format!(
            "{sign}{:02}:{:02}",
            offset_hours.unsigned_abs(),
            offset_minutes.unsigned_abs()
        )
    };
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{fraction}{offset}",
        parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second
    ))
}

#[cfg(test)]
mod tests;
