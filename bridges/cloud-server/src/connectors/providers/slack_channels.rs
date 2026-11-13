//! Slack channel choices: the channels a person can pick for Kordi, the
//! names stored next to the chosen ids, and the channel list a run sees on
//! the Slack tools.
//!
//! Settings keep the original `{ "channels": ["C123", ...] }` shape and may
//! add `"channelNames": { "C123": "general" }` so runs and apps can show
//! names without another Slack call.

use serde_json::{json, Map, Value};

use super::http::ProviderHttp;
use super::slack::{chosen_channels, slack_ok, POST, READ_CHANNEL};
use super::{ProviderError, SettingOptionsError};

/// Scope that lists public channels. Required.
pub const LIST_PUBLIC_SCOPE: &str = "channels:read";
/// Scope that lists private channels. Without it only public channels are
/// listed.
pub const LIST_PRIVATE_SCOPE: &str = "groups:read";
/// Channels requested per `conversations.list` page (Slack allows 1000 but
/// recommends at most 200).
const PAGE_LIMIT: u32 = 200;
/// Pages read per listing, so a huge workspace cannot hold a request open.
const MAX_PAGES: usize = 10;
/// Longest stored channel name; Slack names are at most 80 characters.
pub const MAX_NAME_CHARS: usize = 80;

pub const NO_CHANNELS_NOTE: &str = "No Slack channels are chosen yet; ask the person to choose them in Settings > Connectors > Slack.";

/// A channel name safe to store and to show a model: Slack's letters,
/// digits, `-`, `_`, and `.`, at most [`MAX_NAME_CHARS`] characters.
pub fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim().trim_start_matches('#');
    let valid = !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    valid.then(|| name.to_string())
}

/// Validates `channelNames` against the chosen `channels`. Names for
/// channels that are not chosen, and names Slack would not produce, are
/// dropped rather than rejected, so a save never fails on a display name.
pub fn validate_names(
    raw: Option<&Value>,
    channels: &[String],
) -> Result<Map<String, Value>, String> {
    let map = match raw {
        None | Some(Value::Null) => return Ok(Map::new()),
        Some(Value::Object(map)) => map,
        Some(_) => return Err("channelNames must map channel ids to names.".into()),
    };
    let mut names = Map::new();
    for id in channels {
        if let Some(name) = map.get(id).and_then(Value::as_str).and_then(clean_name) {
            names.insert(id.clone(), Value::String(name));
        }
    }
    Ok(names)
}

/// The chosen channels with their stored names, in chosen order.
pub fn chosen_with_names(settings: &Value) -> Vec<(String, Option<String>)> {
    let names = settings.get("channelNames");
    chosen_channels(settings)
        .into_iter()
        .map(|id| {
            let name = names
                .and_then(|names| names.get(&id))
                .and_then(Value::as_str)
                .and_then(clean_name);
            (id, name)
        })
        .collect()
}

fn label((id, name): &(String, Option<String>)) -> String {
    match name {
        Some(name) => format!("#{name} ({id})"),
        None => id.clone(),
    }
}

/// Puts the chosen channels into the Slack tool description and `channel`
/// argument, so a run knows where it may read and post without guessing.
pub fn tailor_tool(tool: &str, settings: &Value, description: &mut String, schema: &mut Value) {
    if tool != READ_CHANNEL && tool != POST {
        return;
    }
    let chosen = chosen_with_names(settings);
    let channel = schema.pointer_mut("/properties/channel");
    if chosen.is_empty() {
        description.push(' ');
        description.push_str(NO_CHANNELS_NOTE);
        if let Some(channel) = channel {
            channel["description"] = json!(NO_CHANNELS_NOTE);
        }
        return;
    }
    let labels = chosen.iter().map(label).collect::<Vec<_>>().join(", ");
    description.push_str(&format!(" Chosen channels: {labels}."));
    if let Some(channel) = channel {
        channel["description"] = json!(format!("Channel id, one of: {labels}."));
        channel["enum"] = json!(chosen.iter().map(|(id, _)| id).collect::<Vec<_>>());
    }
}

/// Lists the public channels, and the private ones when `groups:read` was
/// granted, that the person can choose: `{ channels: [{ id, name,
/// isPrivate }] }`, sorted by name. Archived channels are left out.
pub async fn list_channels(
    api: &ProviderHttp,
    token: &str,
    granted: &[String],
) -> Result<Value, SettingOptionsError> {
    let has = |scope: &str| granted.iter().any(|value| value == scope);
    if !has(LIST_PUBLIC_SCOPE) {
        return Err(SettingOptionsError::MissingScope);
    }
    let types = if has(LIST_PRIVATE_SCOPE) {
        "public_channel,private_channel"
    } else {
        "public_channel"
    };
    let mut channels = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![
            ("types", types.to_string()),
            ("exclude_archived", "true".to_string()),
            ("limit", PAGE_LIMIT.to_string()),
        ];
        if let Some(cursor) = cursor.take() {
            query.push(("cursor", cursor));
        }
        let body = api.get("/conversations.list", token, &query).await?;
        if body.get("error").and_then(Value::as_str) == Some("missing_scope") {
            return Err(SettingOptionsError::MissingScope);
        }
        let body = slack_ok(body)?;
        let items = body
            .get("channels")
            .and_then(Value::as_array)
            .ok_or(ProviderError::InvalidResponse)?;
        channels.extend(items.iter().filter_map(channel_option));
        cursor = body
            .pointer("/response_metadata/next_cursor")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty() && next.len() <= 512)
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    channels.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({ "channels": channels }))
}

fn channel_option(channel: &Value) -> Option<Value> {
    let id = channel.get("id").and_then(Value::as_str)?;
    if !super::slack::is_channel_id(id) || channel.get("is_archived") == Some(&json!(true)) {
        return None;
    }
    let name = channel
        .get("name")
        .and_then(Value::as_str)
        .and_then(clean_name)
        .unwrap_or_else(|| id.to_string());
    let private = channel.get("is_private").and_then(Value::as_bool) == Some(true);
    Some(json!({ "id": id, "name": name, "isPrivate": private }))
}
