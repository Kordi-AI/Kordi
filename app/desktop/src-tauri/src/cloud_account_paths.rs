use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Account folders live in `APP_DATA_DIR/accounts/<hash>`.
const ACCOUNTS_DIR: &str = "accounts";
/// One empty file per account folder to remove at the next start, named by
/// the folder's hash. It sits outside `accounts/` so that a folder removed
/// only in part keeps its marker until a later start finishes the removal.
const REMOVAL_MARKERS_DIR: &str = "accounts-pending-removal";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountStorageActivation {
    pub account_id: String,
    pub storage_root: String,
    pub requires_reload: bool,
}

fn active_storage() -> &'static Mutex<Option<CloudAccountStorageActivation>> {
    static ACTIVE: OnceLock<Mutex<Option<CloudAccountStorageActivation>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn normalize_account_id(account_id: &str) -> Result<String, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() || !trimmed.starts_with("acct_") {
        return Err("invalid_account_id".to_string());
    }
    Ok(trimmed.to_string())
}

fn account_dir_name(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let hash = hasher.finalize();
    hash[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn app_data_root() -> Result<PathBuf, String> {
    std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "app_data_dir_unavailable".to_string())
}

fn account_storage_parent(account_id: &str) -> Result<PathBuf, String> {
    Ok(app_data_root()?
        .join(ACCOUNTS_DIR)
        .join(account_dir_name(account_id)))
}

/// Whether `name` is an account folder name: 32 lowercase hex characters,
/// so it can never name a parent, a nested path, or anything outside
/// `accounts/`.
fn is_account_dir_name(name: &str) -> bool {
    name.len() == 32
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Marks the account's folder for removal at the next start. The folder is
/// in use while the app runs, so it is never removed here.
pub(crate) fn mark_account_storage_for_removal(account_id: &str) -> Result<(), String> {
    let account_id = normalize_account_id(account_id)?;
    let markers = app_data_root()?.join(REMOVAL_MARKERS_DIR);
    std::fs::create_dir_all(&markers)
        .map_err(|err| format!("cloud_account_storage_mark_failed: {err}"))?;
    std::fs::write(markers.join(account_dir_name(&account_id)), b"")
        .map_err(|err| format!("cloud_account_storage_mark_failed: {err}"))
}

/// Removes one account folder. A symbolic link is removed itself, never
/// what it points to; a folder that is already gone counts as removed.
fn remove_account_folder(folder: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(folder) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(folder),
        Ok(_) => std::fs::remove_file(folder),
    }
}

/// Removes the account folders marked for removal under `root`, and their
/// markers. A marker whose folder could not be removed stays for the next
/// start. Returns how many folders were removed.
fn remove_marked_account_storage_in(root: &Path) -> usize {
    let Ok(markers) = std::fs::read_dir(root.join(REMOVAL_MARKERS_DIR)) else {
        return 0;
    };
    let accounts = root.join(ACCOUNTS_DIR);
    let mut removed = 0;
    for marker in markers.flatten() {
        let name = marker.file_name();
        let Some(name) = name.to_str().filter(|name| is_account_dir_name(name)) else {
            continue;
        };
        if !marker.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        match remove_account_folder(&accounts.join(name)) {
            Ok(()) => {
                let _ = std::fs::remove_file(marker.path());
                removed += 1;
            }
            Err(err) => eprintln!("[kordi] Unable to remove a deleted account's data: {err}"),
        }
    }
    removed
}

/// Removes the folders of deleted accounts. Runs at start, before any
/// account folder is activated.
pub(crate) fn remove_marked_account_storage() -> usize {
    app_data_root()
        .map(|root| remove_marked_account_storage_in(&root))
        .unwrap_or(0)
}

/// Marks a deleted account's folder for removal at the next start, and
/// stops this Mac's unfinished agent turns with the `signed_out` reason a
/// sign-out gives, when that account's storage is the active one.
#[tauri::command]
pub async fn cloud_account_storage_mark_for_removal(
    manager: tauri::State<'_, crate::chat::DesktopChatManager>,
    account_id: String,
) -> Result<(), String> {
    mark_account_storage_for_removal(&account_id)?;
    let active = cloud_account_storage_current()?;
    if active.is_none_or(|active| active.account_id == account_id.trim()) {
        crate::chat::turns::cancel_unfinished_turns(
            manager.inner(),
            crate::chat::DesktopTurnStopReason::of_kind("signed_out"),
        )
        .await;
    }
    Ok(())
}

#[tauri::command]
pub fn cloud_account_storage_root(account_id: String) -> Result<String, String> {
    let account_id = normalize_account_id(&account_id)?;
    let root = account_storage_parent(&account_id)?.join("kordi");
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cloud_account_storage_activate(
    account_id: String,
) -> Result<CloudAccountStorageActivation, String> {
    let account_id = normalize_account_id(&account_id)?;
    let parent = account_storage_parent(&account_id)?;
    let storage_root = parent.join("kordi");
    std::fs::create_dir_all(&storage_root)
        .map_err(|err| format!("cloud_account_storage_create_failed: {err}"))?;

    let current = active_storage()
        .lock()
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())?
        .clone();
    let requires_reload = current
        .as_ref()
        .is_some_and(|active| active.account_id != account_id);
    let activation = CloudAccountStorageActivation {
        account_id,
        storage_root: storage_root.to_string_lossy().to_string(),
        requires_reload,
    };
    unsafe { std::env::set_var("KORDI_STORAGE_ROOT", parent) };
    *active_storage()
        .lock()
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())? = Some(activation.clone());
    Ok(activation)
}

#[tauri::command]
pub fn cloud_account_storage_current() -> Result<Option<CloudAccountStorageActivation>, String> {
    active_storage()
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn with_app_data_dir<T>(test: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::lock_process_environment();
        let previous_app_data_dir = std::env::var_os("APP_DATA_DIR");
        let previous_storage_root = std::env::var_os("KORDI_STORAGE_ROOT");
        let dir = std::env::temp_dir().join(format!(
            "kordi-cloud-account-paths-test-{}",
            uuid::Uuid::new_v4()
        ));

        std::env::set_var("APP_DATA_DIR", &dir);
        std::env::remove_var("KORDI_STORAGE_ROOT");
        *active_storage().lock().expect("active storage lock") = None;
        let output = test(dir.clone());
        let _ = std::fs::remove_dir_all(&dir);
        match previous_app_data_dir {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
        match previous_storage_root {
            Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
            None => std::env::remove_var("KORDI_STORAGE_ROOT"),
        }
        *active_storage().lock().expect("active storage lock") = None;
        output
    }

    #[test]
    fn same_account_resolves_to_same_stable_root() {
        with_app_data_dir(|dir| {
            let first = cloud_account_storage_root("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_root(" acct_alpha ".to_string()).unwrap();

            assert_eq!(first, second);
            assert!(PathBuf::from(&first).starts_with(dir.join("accounts")));
            assert!(first.ends_with("/kordi") || first.ends_with("\\kordi"));
        });
    }

    #[test]
    fn different_accounts_resolve_to_different_roots() {
        with_app_data_dir(|_| {
            let first = cloud_account_storage_root("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_root("acct_beta".to_string()).unwrap();

            assert_ne!(first, second);
        });
    }

    #[test]
    fn invalid_account_ids_are_rejected() {
        with_app_data_dir(|_| {
            assert_eq!(
                cloud_account_storage_root("".to_string()).unwrap_err(),
                "invalid_account_id"
            );
            assert_eq!(
                cloud_account_storage_root("human_123".to_string()).unwrap_err(),
                "invalid_account_id"
            );
        });
    }

    #[test]
    fn activation_sets_current_storage_root() {
        with_app_data_dir(|dir| {
            let activation = cloud_account_storage_activate("acct_alpha".to_string()).unwrap();
            let current = cloud_account_storage_current()
                .unwrap()
                .expect("active storage");

            assert_eq!(activation.account_id, "acct_alpha");
            assert_eq!(activation.storage_root, current.storage_root);
            let env_root = PathBuf::from(std::env::var("KORDI_STORAGE_ROOT").unwrap());
            assert_eq!(
                env_root.join("kordi"),
                PathBuf::from(&activation.storage_root)
            );
            assert!(PathBuf::from(&activation.storage_root).starts_with(dir.join("accounts")));
            assert!(!activation.requires_reload);
        });
    }

    fn account_folder(dir: &Path, account_id: &str) -> PathBuf {
        dir.join(ACCOUNTS_DIR).join(account_dir_name(account_id))
    }

    #[test]
    fn marked_account_folders_are_removed_at_start_and_others_kept() {
        with_app_data_dir(|dir| {
            let deleted = cloud_account_storage_activate("acct_deleted".to_string()).unwrap();
            std::fs::write(PathBuf::from(&deleted.storage_root).join("chat.db"), b"x").unwrap();
            let kept = cloud_account_storage_activate("acct_kept".to_string()).unwrap();

            mark_account_storage_for_removal("acct_deleted").unwrap();
            // Marking never removes a folder that is in use.
            assert!(account_folder(&dir, "acct_deleted").exists());

            assert_eq!(remove_marked_account_storage(), 1);
            assert!(!account_folder(&dir, "acct_deleted").exists());
            assert!(PathBuf::from(&kept.storage_root).exists());
            assert_eq!(
                std::fs::read_dir(dir.join(REMOVAL_MARKERS_DIR))
                    .unwrap()
                    .count(),
                0
            );
            // Nothing is left to remove at the following start.
            assert_eq!(remove_marked_account_storage(), 0);
        });
    }

    #[test]
    fn removal_tolerates_missing_folders_and_marker_directories() {
        with_app_data_dir(|dir| {
            assert_eq!(remove_marked_account_storage(), 0);
            mark_account_storage_for_removal("acct_never_activated").unwrap();
            assert!(!account_folder(&dir, "acct_never_activated").exists());
            assert_eq!(remove_marked_account_storage(), 1);
            assert!(!dir
                .join(REMOVAL_MARKERS_DIR)
                .join(account_dir_name("acct_never_activated"))
                .exists());
        });
    }

    #[test]
    fn removal_never_reaches_outside_the_accounts_folder() {
        with_app_data_dir(|dir| {
            let outside = dir.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
            let markers = dir.join(REMOVAL_MARKERS_DIR);
            std::fs::create_dir_all(&markers).unwrap();
            std::fs::create_dir_all(dir.join(ACCOUNTS_DIR).join("outside")).unwrap();
            // Markers that are not account folder names are ignored.
            for name in ["outside", "..", "ABCDEF0123456789ABCDEF0123456789"] {
                let _ = std::fs::write(markers.join(name), b"");
            }
            std::fs::create_dir_all(markers.join("0123456789abcdef0123456789abcdef")).unwrap();
            std::fs::create_dir_all(
                dir.join(ACCOUNTS_DIR)
                    .join("0123456789abcdef0123456789abcdef"),
            )
            .unwrap();

            // A marked name that is a link to another folder loses only the link.
            mark_account_storage_for_removal("acct_linked").unwrap();
            let linked = account_folder(&dir, "acct_linked");
            std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &linked).unwrap();

            assert_eq!(remove_marked_account_storage(), 1);
            assert!(outside.join("keep.txt").exists());
            assert!(std::fs::symlink_metadata(&linked).is_err());
            assert!(dir.join(ACCOUNTS_DIR).join("outside").exists());
            // A marker directory is not a marker: its folder stays.
            assert!(dir
                .join(ACCOUNTS_DIR)
                .join("0123456789abcdef0123456789abcdef")
                .exists());
        });
    }

    #[test]
    fn marking_refuses_invalid_ids_and_keeps_traversal_inside_the_markers() {
        with_app_data_dir(|dir| {
            assert_eq!(
                mark_account_storage_for_removal("../acct_x").unwrap_err(),
                "invalid_account_id"
            );
            assert_eq!(
                mark_account_storage_for_removal("").unwrap_err(),
                "invalid_account_id"
            );
            // An id is only ever hashed into a folder name.
            mark_account_storage_for_removal("acct_../../escape").unwrap();
            let markers: Vec<String> = std::fs::read_dir(dir.join(REMOVAL_MARKERS_DIR))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            assert_eq!(markers.len(), 1);
            assert!(is_account_dir_name(&markers[0]));
            assert!(!dir.parent().unwrap().join("escape").exists());
        });
    }

    #[test]
    fn switching_accounts_requires_reload_boundary() {
        with_app_data_dir(|_| {
            let first = cloud_account_storage_activate("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_activate("acct_beta".to_string()).unwrap();
            let third = cloud_account_storage_activate("acct_beta".to_string()).unwrap();

            assert!(!first.requires_reload);
            assert!(second.requires_reload);
            assert!(!third.requires_reload);
        });
    }
}
