//! KordiSpot's rotating key file, from its settings to the runner payload.

use std::collections::HashMap;

use super::*;
use crate::cloud_agent_runtime::provider_auth::{
    service_provider_auth_for_run, ServiceProviderAuth,
};

struct KeyFile(std::path::PathBuf);

impl KeyFile {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("kordi-support-key-{}", uuid::Uuid::new_v4())))
    }

    fn write(&self, contents: &str) {
        std::fs::write(&self.0, contents).unwrap();
    }

    fn path(&self) -> String {
        self.0.to_str().unwrap().to_string()
    }
}

impl Drop for KeyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn settings(extra: &[(&'static str, String)]) -> HashMap<&'static str, String> {
    let mut values: HashMap<_, _> = [
        ("KORDI_SUPPORT_ENABLED", "true"),
        ("KORDI_SUPPORT_OWNER_EMAIL", "support@example.invalid"),
        ("KORDI_SUPPORT_AGENT_NAME", "Synthetic support"),
        ("KORDI_SUPPORT_AGENT_SUBTITLE", "Ask questions"),
        ("KORDI_SUPPORT_OPENAI_MODEL", "synthetic-model"),
    ]
    .into_iter()
    .map(|(key, value)| (key, value.to_string()))
    .collect();
    values.extend(extra.iter().cloned());
    values
}

fn startup(
    values: &HashMap<&'static str, String>,
) -> Result<Option<PendingSupportConfig>, SupportConfigError> {
    PendingSupportConfig::from_lookup_for_startup(|key| values.get(key).cloned())
}

/// The key the runner receives for a KordiSpot run, as the runner route
/// builds it for each request.
async fn runner_key(auth: &SupportProviderAuth) -> Result<String, String> {
    let route = serde_json::json!({
        "defaultAuthProvider": auth.provider(),
        "defaultAuthChoice": auth.auth_choice(),
    });
    let service_auth = ServiceProviderAuth {
        owner_account_id: DEFAULT_SUPPORT_ACCOUNT_ID,
        snapshot_id: auth.snapshot_id(),
        provider: auth.provider(),
        auth_choice: auth.auth_choice(),
        credential: auth.credential(),
        base_url: auth.base_url(),
        model: auth.model(),
        run_id_prefix: None,
        resource_pool: None,
    };
    let material = service_provider_auth_for_run(
        DEFAULT_SUPPORT_ACCOUNT_ID,
        "run_synthetic",
        &route,
        vec![service_auth],
    )
    .await
    .map_err(|error| error.to_string())?
    .expect("KordiSpot serves its own route");
    Ok(material.payload["apiKey"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn a_replaced_key_file_is_used_by_the_next_run_without_a_restart() {
    let key = KeyFile::new();
    key.write("synthetic-support-key-one\n");
    // A shared operator key is only a default; the KordiSpot key file wins.
    let values = settings(&[
        ("KORDI_SUPPORT_OPENAI_API_KEY_FILE", key.path()),
        ("KORDI_SERVICE_MODEL_API_KEY", "synthetic-shared-key".into()),
    ]);
    let config = startup(&values).unwrap().unwrap();
    let auth = &config.provider_auth;
    assert_eq!(auth.provider(), "openai");
    assert_eq!(auth.auth_choice(), "support-service-api-key");
    assert_eq!(auth.snapshot_id(), "support-service-openai");
    assert_eq!(auth.model(), "synthetic-model");
    assert!(!auth.credential().is_google_cloud());
    let debug = format!("{config:?}");
    assert!(!debug.contains("synthetic-support-key") && !debug.contains("kordi-support-key"));

    assert_eq!(runner_key(auth).await.unwrap(), "synthetic-support-key-one");
    key.write("synthetic-support-key-two");
    assert_eq!(runner_key(auth).await.unwrap(), "synthetic-support-key-two");

    // An emptied or removed file fails that request without echoing either
    // the path or the old key.
    key.write("");
    let error = runner_key(auth).await.unwrap_err();
    assert!(!error.contains("kordi-support-key") && !error.contains("synthetic-support-key"));
    std::fs::remove_file(&key.0).unwrap();
    assert!(runner_key(auth).await.is_err());
}

#[test]
fn startup_rejects_both_keys_and_a_missing_or_empty_key_file() {
    let key = KeyFile::new();
    let file_only = settings(&[("KORDI_SUPPORT_OPENAI_API_KEY_FILE", key.path())]);
    let error = startup(&file_only).unwrap_err().to_string();
    assert!(error.contains("API key file") && !error.contains("kordi-support-key"));
    key.write(" \n");
    assert!(startup(&file_only).is_err());
    key.write("synthetic-support-key");
    assert!(startup(&file_only).unwrap().is_some());

    let mut both = file_only.clone();
    both.insert(
        "KORDI_SUPPORT_OPENAI_API_KEY",
        "synthetic-dedicated-key".into(),
    );
    assert_eq!(
        startup(&both).unwrap_err().to_string(),
        "Set only one of KORDI_SUPPORT_OPENAI_API_KEY or KORDI_SUPPORT_OPENAI_API_KEY_FILE"
    );
    // An empty or blank setting counts as unset, as it does for every other
    // setting, so a manifest may keep the key variable with no value.
    for unset in ["", " "] {
        both.insert("KORDI_SUPPORT_OPENAI_API_KEY", unset.into());
        assert!(startup(&both).unwrap().is_some());
    }
}

#[tokio::test]
async fn a_dedicated_key_alone_behaves_as_before() {
    let values = settings(&[
        (
            "KORDI_SUPPORT_OPENAI_API_KEY",
            " synthetic-dedicated-key ".into(),
        ),
        ("KORDI_SUPPORT_OPENAI_API_KEY_FILE", " ".into()),
    ]);
    let config = startup(&values).unwrap().unwrap();
    let auth = &config.provider_auth;
    assert_eq!(auth.credential().api_key(), "synthetic-dedicated-key");
    assert_eq!(auth.auth_choice(), "support-service-api-key");
    assert_eq!(runner_key(auth).await.unwrap(), "synthetic-dedicated-key");
}
