//! The Slack channel picker end to end: the options route, saving names,
//! and the chosen channels on delivered tools (database).

use super::http_stub::HttpStub;
use super::service_fixture::{connect_service, service_runtime, unique_number};
use super::*;
use crate::connectors::delivery;
use crate::connectors::providers::slack_channels::NO_CHANNELS_NOTE;

fn token_response(team: &str, access: &str, scope: &str) -> Value {
    json!({ "ok": true, "team": { "id": team },
            "authed_user": { "id": "U1", "access_token": access, "scope": scope } })
}

async fn read_tool_description(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    owner: &str,
) -> (String, Value) {
    let tools = delivery::tools_for_run(
        pool,
        &runtime.providers,
        owner,
        &store::default_agent_id(owner),
        RunTrigger::PersonStarted,
        ConnectorAudience::OwnerPrivate,
    )
    .await
    .unwrap();
    let tool = tools
        .into_iter()
        .find(|tool| tool.name == "slack_read_channel")
        .expect("Slack read tool is delivered");
    (tool.description, tool.input_schema)
}

#[tokio::test]
async fn slack_channel_picker_lists_saves_and_reaches_the_run() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let runtime = service_runtime(&stub, Default::default());
    let team = format!("T{}", unique_number());
    stub.respond(
        "POST",
        "/token",
        token_response(&team, "xoxp-old", "channels:history,groups:history"),
    );
    let (owner, token) = signed_in_account(&pool, "slack_picker").await;
    let connector_id =
        connect_service(&pool, &runtime, &owner, "slack", ConnectorToolGroup::Read).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime.clone()),
    ));
    let options_uri = format!("/v1/cloud/connectors/{connector_id}/settings/options");
    let get_options = || {
        app.clone()
            .oneshot(authed("GET", &options_uri, &token, None))
    };

    // A connection made before the listing scopes asks for a reconnect and
    // never calls Slack.
    let old = get_options().await.unwrap();
    assert_eq!(old.status(), StatusCode::CONFLICT);
    let old = body_json(old).await;
    assert_eq!(old["errorCode"], "connector_scope_missing");
    assert_eq!(old["message"], "Reconnect Slack to choose channels.");
    assert!(stub.requests_to("GET", "/conversations.list").is_empty());

    let (description, _) = read_tool_description(&pool, &runtime, &owner).await;
    assert!(description.ends_with(NO_CHANNELS_NOTE), "{description}");

    // Reconnecting adds the listing scopes.
    stub.respond(
        "POST",
        "/token",
        token_response(
            &team,
            "xoxp-new",
            "channels:history,groups:history,channels:read,groups:read,chat:write",
        ),
    );
    let reconnected =
        connect_service(&pool, &runtime, &owner, "slack", ConnectorToolGroup::Read).await;
    assert_eq!(reconnected, connector_id);
    stub.respond_when(
        "GET",
        "/conversations.list",
        None,
        Some("xoxp-new"),
        200,
        json!({ "ok": true, "channels": [
            { "id": "C0GENERAL", "name": "general", "is_private": false },
            { "id": "G0LAUNCH", "name": "launch", "is_private": true }
        ] }),
    );
    let listed = get_options().await.unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = body_json(listed).await;
    assert_eq!(
        listed,
        json!({ "channels": [
            { "id": "C0GENERAL", "name": "general", "isPrivate": false },
            { "id": "G0LAUNCH", "name": "launch", "isPrivate": true }
        ] })
    );
    assert_no_stub_credentials("settings options", &listed);
    assert!(!listed.to_string().contains("xoxp"));

    let saved = app
        .clone()
        .oneshot(authed(
            "PUT",
            &format!("/v1/cloud/connectors/{connector_id}/settings"),
            &token,
            Some(json!({ "channels": ["C0GENERAL"], "channelNames": { "C0GENERAL": "general" } })),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        body_json(saved).await["connector"]["settings"],
        json!({ "channels": ["C0GENERAL"], "channelNames": { "C0GENERAL": "general" } })
    );
    let (description, schema) = read_tool_description(&pool, &runtime, &owner).await;
    assert!(
        description.ends_with("Chosen channels: #general (C0GENERAL)."),
        "{description}"
    );
    assert_eq!(
        schema["properties"]["channel"]["enum"],
        json!(["C0GENERAL"])
    );

    // A revoked Slack token marks the connector for a new sign-in.
    stub.reject_token("xoxp-new");
    let revoked = get_options().await.unwrap();
    assert_eq!(revoked.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(revoked).await["errorCode"],
        "connector_not_connected"
    );
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.status, ConnectorStatus::NeedsReauth);

    // Another account's connector is not found.
    let (_, stranger) = signed_in_account(&pool, "slack_picker_other").await;
    let foreign = app
        .clone()
        .oneshot(authed("GET", &options_uri, &stranger, None))
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
}
