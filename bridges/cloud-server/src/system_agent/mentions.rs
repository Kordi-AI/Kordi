//! `@Handle` mentions in the System agent's messages.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

/// The System agent's text in the cloud message envelope the clients decode,
/// with the mentions they render and notify on.
pub(crate) fn encode_system_agent_message_with_mentions(
    text: &str,
    mentions: Vec<Value>,
) -> String {
    let payload =
        json!({"schemaVersion": 1, "kind": "message", "text": text, "mentions": mentions});
    format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    )
}

/// `@Handle` for a member: the display name without spaces, which is what the
/// clients' mention parsers match a token against.
pub(crate) fn mention_handle(display_name: &str) -> String {
    display_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// `@Handle` for a member's own agent, as group mention catalogs build it:
/// the agent's name followed by its owner's name.
pub(crate) fn agent_mention_handle(agent_name: Option<&str>, owner_name: &str) -> String {
    let agent_name = agent_name
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "My Kordi")
        .unwrap_or("Kordi");
    mention_handle(&format!("{agent_name} {owner_name}"))
}

/// A conversation member the System agent can mention, with their agent.
pub(crate) struct MentionMember {
    pub account_id: String,
    pub display_name: String,
    /// The member's agent, when they have one the System agent may address.
    pub agent_name: Option<Option<String>>,
}

fn person_mention(member: &MentionMember, handle: &str) -> Value {
    json!({
        "label": mention_handle(&member.display_name),
        "targetKind": "person",
        "targetIdentityId": member.account_id,
        "humanId": member.account_id,
        "displayText": format!("@{handle}"),
        "displayLabel": member.display_name,
    })
}

fn agent_mention(member: &MentionMember, agent_name: Option<&str>, handle: &str) -> Value {
    let agent_id = format!("cloud-agent:{}", member.account_id);
    json!({
        "label": agent_mention_handle(agent_name, &member.display_name),
        "targetKind": "agent",
        "targetIdentityId": format!("agent:{agent_id}"),
        "agentId": agent_id,
        "ownerAccountId": member.account_id,
        "sourceHostId": "cloud",
        "displayText": format!("@{handle}"),
        "displayLabel": format!("{}'s {}", member.display_name, agent_name.unwrap_or("Kordi")),
    })
}

/// Resolves `@Handle` tokens in the System agent's text to member and agent
/// mentions in the shape the clients render and notify on. Unknown or
/// ambiguous handles stay plain text.
pub(crate) fn resolve_mentions(text: &str, members: &[MentionMember]) -> Vec<Value> {
    let mut mentions = Vec::new();
    let mut utf16_offset = 0usize;
    let mut chars = text.chars().peekable();
    let mut previous: Option<char> = None;
    while let Some(c) = chars.next() {
        if c == '@' && previous.is_none_or(|p| !p.is_alphanumeric()) {
            let start_utf16 = utf16_offset;
            let mut handle = String::new();
            let mut token_utf16 = c.len_utf16();
            while let Some(next) = chars.peek().copied().filter(|next| next.is_alphanumeric()) {
                handle.push(next);
                token_utf16 += next.len_utf16();
                chars.next();
            }
            utf16_offset += token_utf16;
            previous = handle.chars().last().or(Some(c));
            if handle.is_empty() {
                continue;
            }
            let is = |candidate: &str| candidate.eq_ignore_ascii_case(&handle);
            let mut matched: Vec<Value> = Vec::new();
            for member in members {
                if is(&mention_handle(&member.display_name)) {
                    matched.push(person_mention(member, &handle));
                }
                if let Some(agent_name) = &member.agent_name {
                    if is(&agent_mention_handle(
                        agent_name.as_deref(),
                        &member.display_name,
                    )) {
                        matched.push(agent_mention(member, agent_name.as_deref(), &handle));
                    }
                }
            }
            // An ambiguous handle must never pick a member by position.
            if let [mention] = matched.as_mut_slice() {
                mention["startUtf16"] = json!(start_utf16);
                mention["lengthUtf16"] = json!(token_utf16);
                mentions.push(mention.take());
            }
            continue;
        }
        utf16_offset += c.len_utf16();
        previous = Some(c);
    }
    mentions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(account_id: &str, display_name: &str, agent: Option<&str>) -> MentionMember {
        MentionMember {
            account_id: account_id.to_string(),
            display_name: display_name.to_string(),
            agent_name: Some(agent.map(str::to_string)),
        }
    }

    #[test]
    fn handles_resolve_to_one_member_with_utf16_offsets() {
        let members = vec![
            member("acct_mina", "Mina Park", None),
            member("acct_theo", "Theo", None),
            member("acct_theo2", "Theo", None),
        ];
        let mentions = resolve_mentions("\u{1f44b} @MinaPark and @theo, email a@b", &members);
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["targetIdentityId"], "acct_mina");
        assert_eq!(mentions[0]["startUtf16"], 3);
        assert_eq!(mentions[0]["lengthUtf16"], 9);
    }

    #[test]
    fn agent_handles_resolve_to_that_members_agent() {
        let members = vec![
            member("acct_mina", "Mina Park", None),
            member("acct_ana", "Ana", Some("Scout")),
            MentionMember {
                account_id: "acct_system".to_string(),
                display_name: "System".to_string(),
                agent_name: None,
            },
        ];
        let mentions = resolve_mentions(
            "@KordiMinaPark pick one. @ScoutAna too. @KordiSystem",
            &members,
        );
        assert_eq!(mentions.len(), 2);
        assert_eq!(mentions[0]["targetKind"], "agent");
        assert_eq!(mentions[0]["agentId"], "cloud-agent:acct_mina");
        assert_eq!(
            mentions[0]["targetIdentityId"],
            "agent:cloud-agent:acct_mina"
        );
        assert_eq!(mentions[0]["startUtf16"], 0);
        assert_eq!(mentions[0]["lengthUtf16"], 14);
        assert_eq!(mentions[1]["ownerAccountId"], "acct_ana");
        assert_eq!(agent_mention_handle(Some("My Kordi"), "Ana"), "KordiAna");
    }
}
