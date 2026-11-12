use super::*;
use std::collections::HashMap;

const MODEL: (&str, &str) = ("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "synthetic-model");

#[test]
fn self_hosted_model_defaults_work_without_google_credentials() {
    let mut values = HashMap::from([
        ("KORDI_SERVICE_MODEL_PROVIDER", "openai-compatible"),
        ("KORDI_SERVICE_MODEL_API_KEY", "synthetic-shared-key"),
        ("KORDI_SERVICE_MODEL_MODEL", "operator-selected-model"),
        (
            "KORDI_SERVICE_MODEL_BASE_URL",
            "https://models.example.test/v1/",
        ),
    ]);
    let resolve = |values: &HashMap<&str, &str>| {
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
            .unwrap()
    };
    let config = resolve(&values);
    assert_eq!(config.provider_auth.api_key(), "synthetic-shared-key");
    assert_eq!(config.provider_auth.model(), "operator-selected-model");
    assert_eq!(
        config.provider_auth.base_url(),
        "https://models.example.test/v1"
    );
    assert!(!config.provider_auth.credential().is_google_cloud());
    values.insert(
        "KORDI_SYSTEM_AGENT_OPENAI_API_KEY",
        "synthetic-dedicated-key",
    );
    values.insert("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "dedicated-model");
    assert_eq!(
        resolve(&values).provider_auth.api_key(),
        "synthetic-dedicated-key"
    );
    assert_eq!(resolve(&values).provider_auth.model(), "dedicated-model");
    values.insert("KORDI_SYSTEM_AGENT_ENABLED", "false");
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_none());
}

#[test]
fn system_agent_is_off_without_a_key() {
    let values: HashMap<&str, &str> = HashMap::new();
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap();
    assert!(config.is_none());
}

#[test]
fn system_agent_is_on_with_a_key_and_model_unless_switched_off() {
    let on = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"), MODEL]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| on
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_some());
    let off = HashMap::from([
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
        ("KORDI_SYSTEM_AGENT_ENABLED", "false"),
    ]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| off
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_none());
}

#[test]
fn grounding_credentials_can_be_enabled_without_group_chat_automation() {
    for name in [
        "KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED",
        "KORDI_PIP_GROUP_CHAT_ENABLED",
    ] {
        let config = configured(&[
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
            MODEL,
            (name, "false"),
        ])
        .expect("Grounding service remains available");
        assert!(!config.group_chat_enabled);
        assert_eq!(config.provider_auth.api_key(), "synthetic-key");
    }
    let config = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
        MODEL,
        ("KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED", "true"),
        ("KORDI_PIP_GROUP_CHAT_ENABLED", "false"),
    ])
    .unwrap();
    assert!(
        config.group_chat_enabled,
        "the new setting takes precedence"
    );
}

#[test]
fn enabled_system_agent_requires_its_own_api_key() {
    let values = HashMap::from([("KORDI_SYSTEM_AGENT_ENABLED", "true")]);
    let error =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap_err();
    assert!(matches!(error, SystemAgentConfigError::Invalid(_)));
}

#[test]
fn a_facilitator_key_alone_does_not_select_a_model() {
    let error = PendingSystemAgentConfig::from_lookup(|key| {
        (key == "KORDI_SYSTEM_AGENT_OPENAI_API_KEY").then(|| "synthetic-key".to_string())
    })
    .unwrap_err();
    assert!(matches!(error, SystemAgentConfigError::Invalid(message)
        if message == "KORDI_SYSTEM_AGENT_OPENAI_MODEL is required"));
}

#[test]
fn identity_defaults_are_independent_of_model_selection() {
    let values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "yes"),
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", " sk-test "),
        MODEL,
    ]);
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
            .unwrap();
    assert!(config.group_chat_enabled);
    assert_eq!(config.account_id, DEFAULT_SYSTEM_AGENT_ACCOUNT_ID);
    assert_eq!(config.agent_id, DEFAULT_SYSTEM_AGENT_ID);
    assert_eq!(config.name, "Facilitator");
    assert_eq!(config.provider_auth.api_key(), "sk-test");
    assert_eq!(config.provider_auth.model(), MODEL.1);
    assert!(!format!("{:?}", config.provider_auth).contains("sk-test"));
}

fn lookup(extra: Option<&'static str>) -> Result<PendingSystemAgentConfig, SystemAgentConfigError> {
    let mut values = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"), MODEL]);
    if let Some(url) = extra {
        values.insert("KORDI_SYSTEM_AGENT_OPENAI_BASE_URL", url);
    }
    PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
        .map(|config| config.expect("configured"))
}

#[test]
fn base_url_defaults_to_openai_when_unset() {
    let config = lookup(None).unwrap();
    assert_eq!(
        config.provider_auth.base_url(),
        DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL
    );
}

#[test]
fn base_url_override_is_used_and_trailing_slash_stripped() {
    let config = lookup(Some(" https://gateway.example.invalid/v1/ ")).unwrap();
    assert_eq!(
        config.provider_auth.base_url(),
        "https://gateway.example.invalid/v1"
    );
    let config = lookup(Some("http://127.0.0.1:4000/v1")).unwrap();
    assert_eq!(config.provider_auth.base_url(), "http://127.0.0.1:4000/v1");
}

fn configured(values: &[(&str, &str)]) -> Option<PendingSystemAgentConfig> {
    let values: HashMap<&str, &str> = values.iter().copied().collect();
    PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
        .unwrap()
}

#[test]
fn new_and_old_setting_names_are_both_read() {
    let new = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        ("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "model-new"),
    ])
    .unwrap();
    assert_eq!(new.provider_auth.api_key(), "sk-new");
    assert_eq!(new.provider_auth.model(), "model-new");
    let old = configured(&[
        ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
        ("KORDI_PIP_OPENAI_MODEL", "model-old"),
        ("KORDI_PIP_OWNER_EMAIL", "old@example.invalid"),
    ])
    .unwrap();
    assert_eq!(old.provider_auth.api_key(), "sk-old");
    assert_eq!(old.provider_auth.model(), "model-old");
    assert_eq!(old.owner_email, "old@example.invalid");
}

#[test]
fn the_new_setting_name_wins_over_the_old_one() {
    let config = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
        MODEL,
        ("KORDI_SYSTEM_AGENT_AGENT_NAME", " "),
        ("KORDI_PIP_AGENT_NAME", "Old name"),
    ])
    .unwrap();
    assert_eq!(config.provider_auth.api_key(), "sk-new");
    assert_eq!(config.name, "Old name", "a blank new value falls back");
    let on = [
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        MODEL,
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_PIP_ENABLED", "false"),
    ];
    assert!(configured(&on).is_some());
}

#[test]
fn either_enabled_name_switches_it_off() {
    for name in ["KORDI_SYSTEM_AGENT_ENABLED", "KORDI_PIP_ENABLED"] {
        let values = [
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
            (name, "false"),
        ];
        assert!(configured(&values).is_none(), "{name}");
    }
}

#[test]
fn non_https_base_url_is_rejected() {
    for bad in [
        "http://gateway.example.invalid/v1",
        "ftp://x",
        "gateway.example.invalid",
        "http://localhost.evil.invalid/v1",
    ] {
        let error = lookup(Some(bad)).unwrap_err();
        assert!(
            matches!(error, SystemAgentConfigError::Invalid(m) if m == "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL must be an https URL"),
            "{bad}"
        );
    }
}
#[test]
fn vertex_service_uses_explicit_model_without_an_openai_key() {
    let mut values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
        ("KORDI_SYSTEM_AGENT_PROVIDER", "vertex-ai"),
        ("KORDI_SERVICE_VERTEX_PROJECT", "synthetic-project"),
        ("KORDI_SYSTEM_AGENT_VERTEX_MODEL", "google/synthetic-model"),
    ]);
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
            .unwrap();
    assert_eq!(config.provider_auth.provider(), "vertex-ai");
    assert_eq!(config.provider_auth.model(), "google/synthetic-model");
    assert!(config.provider_auth.credential().is_google_cloud());
    assert!(config
        .provider_auth
        .base_url()
        .starts_with("https://aiplatform.googleapis.com/"));
    // Selecting Vertex never silently falls back to an existing OpenAI key.
    values.insert("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret");
    values.remove("KORDI_SYSTEM_AGENT_VERTEX_MODEL");
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .is_err());
    values.insert("KORDI_SYSTEM_AGENT_ENABLED", "false");
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_none());
}

#[test]
fn service_rejects_unknown_provider() {
    let values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
        ("KORDI_SYSTEM_AGENT_PROVIDER", "typo"),
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret"),
    ]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .is_err());
}

#[test]
fn stall_minutes_default_to_ten_and_reject_nonsense() {
    let key = ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test");
    let default = configured(&[key, MODEL]).unwrap();
    assert_eq!(default.stall_minutes, super::DEFAULT_STALL_MINUTES);
    assert_eq!(default.stall_minutes, 10);
    let custom = configured(&[key, MODEL, ("KORDI_SYSTEM_AGENT_STALL_MINUTES", "3")]).unwrap();
    assert_eq!(custom.stall_minutes, 3);
    assert_eq!(
        custom.unprovisioned().stall_window(),
        chrono::Duration::minutes(3)
    );
    for bad in ["0", "-1", "soon", "1441"] {
        let values = HashMap::from([key, MODEL, ("KORDI_SYSTEM_AGENT_STALL_MINUTES", bad)]);
        assert!(
            PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|v| v.to_string()))
                .is_err(),
            "{bad}"
        );
    }
}

#[test]
fn silence_minutes_default_to_ten_and_reject_nonsense() {
    let key = ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test");
    let default = configured(&[key, MODEL]).unwrap();
    assert_eq!(default.silence_minutes, super::DEFAULT_SILENCE_MINUTES);
    assert_eq!(default.silence_minutes, 10);
    let custom = configured(&[key, MODEL, ("KORDI_SYSTEM_AGENT_SILENCE_MINUTES", "4")]).unwrap();
    assert_eq!(
        custom.unprovisioned().silence_window(),
        chrono::Duration::minutes(4)
    );
    for bad in ["0", "later", "1441"] {
        let values = HashMap::from([key, MODEL, ("KORDI_SYSTEM_AGENT_SILENCE_MINUTES", bad)]);
        assert!(
            PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|v| v.to_string()))
                .is_err(),
            "{bad}"
        );
    }
}
