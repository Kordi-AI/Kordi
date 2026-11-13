//! Slack channel choices: settings with names, the channel list on the
//! tools, and `conversations.list` against a local stub (no database).

use super::http_stub::HttpStub;
use super::providers_tests::{assert_clean, http, secret, ACCESS};
use super::*;
use crate::connectors::providers::{
    slack, slack_channels, ConnectorProvider, ProviderError, SettingOptionsError,
};

fn scopes(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn slack_settings_keep_names_for_chosen_channels_only() {
    let registry = ProviderRegistry::production();
    let slack = registry.get("slack").unwrap();
    assert_eq!(
        slack.validate_settings(&json!({
            "channels": ["C0GENERAL", "G0SECRET", "C0NONAME"],
            "channelNames": {
                "C0GENERAL": "#general",
                "G0SECRET": "launch-team",
                "C0NONAME": "has space",
                "C0OTHER": "not-chosen"
            }
        })),
        Ok(json!({
            "channels": ["C0GENERAL", "G0SECRET", "C0NONAME"],
            "channelNames": { "C0GENERAL": "general", "G0SECRET": "launch-team" }
        }))
    );
    // Settings saved before names existed still validate unchanged.
    assert_eq!(
        slack.validate_settings(&json!({ "channels": ["C0GENERAL"], "channelNames": {} })),
        Ok(json!({ "channels": ["C0GENERAL"] }))
    );
    for bad in [
        json!({ "channels": ["C0GENERAL"], "channelNames": ["general"] }),
        json!({ "channels": ["D0DIRECT"], "channelNames": { "D0DIRECT": "dm" } }),
        json!({ "channels": ["C0GENERAL"], "names": {} }),
    ] {
        assert!(slack.validate_settings(&bad).is_err(), "{bad}");
    }
}

fn tailored(tool: &str, settings: Value) -> (String, Value) {
    let registry = ProviderRegistry::production();
    let slack = registry.get("slack").unwrap();
    let base = slack
        .tools()
        .iter()
        .find(|descriptor| descriptor.name == tool)
        .unwrap()
        .description;
    let mut description = base.to_string();
    let mut schema = crate::connectors::tool_schemas::input_schema(tool);
    slack.tailor_tool(tool, &settings, &mut description, &mut schema);
    assert!(description.starts_with(base));
    (description, schema)
}

#[test]
fn slack_tools_name_the_chosen_channels() {
    for tool in [slack::READ_CHANNEL, slack::POST] {
        let (description, schema) = tailored(tool, json!({ "channels": [] }));
        assert!(
            description.ends_with(slack_channels::NO_CHANNELS_NOTE),
            "{description}"
        );
        assert!(description.contains("Settings > Connectors > Slack"));
        let channel = &schema["properties"]["channel"];
        assert_eq!(channel["description"], slack_channels::NO_CHANNELS_NOTE);
        assert!(channel.get("enum").is_none());

        let (description, schema) = tailored(
            tool,
            json!({ "channels": ["C0GENERAL", "G0SECRET"], "channelNames": { "C0GENERAL": "general" } }),
        );
        assert!(
            description.ends_with("Chosen channels: #general (C0GENERAL), G0SECRET."),
            "{description}"
        );
        let channel = &schema["properties"]["channel"];
        assert_eq!(channel["enum"], json!(["C0GENERAL", "G0SECRET"]));
        assert!(channel["description"]
            .as_str()
            .unwrap()
            .contains("#general (C0GENERAL)"));
        assert_eq!(schema["required"][0], "channel");
    }

    // Other providers and settings without channels are left alone.
    let registry = ProviderRegistry::production();
    let github = registry.get("github").unwrap();
    let mut description = "Read notifications.".to_string();
    let mut schema = crate::connectors::tool_schemas::input_schema("github_notifications");
    let before = schema.clone();
    github.tailor_tool(
        "github_notifications",
        &json!({}),
        &mut description,
        &mut schema,
    );
    assert_eq!(description, "Read notifications.");
    assert_eq!(schema, before);
}

fn channel(id: &str, name: &str, private: bool) -> Value {
    json!({ "id": id, "name": name, "is_private": private, "is_archived": false,
            "is_member": true, "topic": { "value": "ignored" } })
}

#[tokio::test]
async fn slack_lists_choosable_channels_across_pages() {
    let stub = HttpStub::start().await;
    let provider = slack::provider(http(), Some(stub.base.clone()));
    let list = "/conversations.list";
    let both = scopes(&[
        "channels:history",
        "groups:history",
        "channels:read",
        "groups:read",
    ]);

    // Grants made before the listing scopes existed never reach Slack.
    let old = provider
        .setting_options(&secret(), &scopes(&["channels:history", "groups:history"]))
        .await;
    assert!(matches!(old, Err(SettingOptionsError::MissingScope)));
    assert!(stub.requests().is_empty());

    stub.respond_when(
        "GET",
        list,
        None,
        Some(ACCESS),
        200,
        json!({ "ok": true,
                "channels": [channel("C0ZETA", "zeta", false), channel("G0ALPHA", "alpha", true),
                             { "id": "D0DIRECT", "name": "dm" },
                             { "id": "C0OLD", "name": "old", "is_archived": true }],
                "response_metadata": { "next_cursor": "page2" } }),
    );
    stub.respond_when(
        "GET",
        list,
        Some("cursor=page2"),
        Some(ACCESS),
        200,
        json!({ "ok": true, "channels": [channel("C0MID", "mid", false)],
                "response_metadata": { "next_cursor": "" } }),
    );
    let listed = provider.setting_options(&secret(), &both).await.unwrap();
    assert_clean("conversations.list", &listed);
    assert_eq!(
        listed,
        json!({ "channels": [
            { "id": "G0ALPHA", "name": "alpha", "isPrivate": true },
            { "id": "C0MID", "name": "mid", "isPrivate": false },
            { "id": "C0ZETA", "name": "zeta", "isPrivate": false }
        ] })
    );
    let calls = stub.requests_to("GET", list);
    assert_eq!(calls.len(), 2);
    assert!(calls[0]
        .query
        .contains("types=public_channel%2Cprivate_channel"));
    assert!(calls[0].query.contains("exclude_archived=true"));
    assert!(calls[0].query.contains("limit=200"));
    assert!(calls[1].query.contains("cursor=page2"));

    // Without `groups:read` only public channels are asked for.
    provider
        .setting_options(&secret(), &scopes(&["channels:read"]))
        .await
        .unwrap();
    let last = stub.requests_to("GET", list).pop().unwrap();
    assert!(
        last.query.contains("types=public_channel&"),
        "{}",
        last.query
    );
}

#[tokio::test]
async fn slack_listing_errors_map_to_reconnect_states() {
    let stub = HttpStub::start().await;
    let provider = slack::provider(http(), Some(stub.base.clone()));
    let granted = scopes(&["channels:read", "groups:read"]);
    let list = "/conversations.list";
    stub.respond(
        "GET",
        list,
        json!({ "ok": false, "error": "missing_scope" }),
    );
    let missing = provider.setting_options(&secret(), &granted).await;
    assert!(matches!(missing, Err(SettingOptionsError::MissingScope)));

    stub.respond(
        "GET",
        list,
        json!({ "ok": false, "error": "token_revoked" }),
    );
    let revoked = provider.setting_options(&secret(), &granted).await;
    assert!(matches!(
        revoked,
        Err(SettingOptionsError::Provider(ProviderError::Unauthorized))
    ));

    stub.respond("GET", list, json!({ "ok": true }));
    let malformed = provider.setting_options(&secret(), &granted).await;
    assert!(matches!(
        malformed,
        Err(SettingOptionsError::Provider(
            ProviderError::InvalidResponse
        ))
    ));

    // Providers without choices say so.
    let github = crate::connectors::providers::github::provider(http(), Some(stub.base.clone()));
    let unsupported = github.setting_options(&secret(), &granted).await;
    assert!(matches!(unsupported, Err(SettingOptionsError::Unsupported)));
}
