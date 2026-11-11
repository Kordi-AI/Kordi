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

fn person_mention(member: &MentionMember) -> (String, Value) {
    let visible = format!("@{}", member.display_name);
    let mention = json!({
        "label": mention_handle(&member.display_name),
        "targetKind": "person",
        // Clients accept a person mention only under the `human:` identity.
        "targetIdentityId": format!("human:{}", member.account_id),
        "humanId": member.account_id,
        "displayLabel": member.display_name,
    });
    (visible, mention)
}

fn agent_mention(member: &MentionMember, agent_name: Option<&str>) -> (String, Value) {
    let agent_id = format!("cloud-agent:{}", member.account_id);
    let label = format!(
        "{}'s {}",
        member.display_name,
        agent_name.unwrap_or("Kordi")
    );
    let mention = json!({
        "label": agent_mention_handle(agent_name, &member.display_name),
        "targetKind": "agent",
        "targetIdentityId": format!("agent:{agent_id}"),
        "agentId": agent_id,
        "ownerAccountId": member.account_id,
        "sourceHostId": "cloud",
        "displayLabel": label,
    });
    (format!("@{label}"), mention)
}

/// Replaces each `@Handle` the System agent wrote with the name people see
/// (`@Maya Patel`, `@Maya Patel's Kordi`), as the clients render mentions,
/// and returns the text with one structured mention per name. The mention's
/// range carries the account; unknown or ambiguous handles stay as written.
pub(crate) fn render_mentions(text: &str, members: &[MentionMember]) -> (String, Vec<Value>) {
    let mut out = String::with_capacity(text.len());
    let mut out_utf16 = 0usize;
    let mut mentions = Vec::new();
    let mut chars = text.chars().peekable();
    let mut previous: Option<char> = None;
    while let Some(c) = chars.next() {
        if c != '@' || previous.is_some_and(|p| p.is_alphanumeric()) {
            out.push(c);
            out_utf16 += c.len_utf16();
            previous = Some(c);
            continue;
        }
        let mut handle = String::new();
        while let Some(next) = chars.peek().copied().filter(|next| next.is_alphanumeric()) {
            handle.push(next);
            chars.next();
        }
        previous = handle.chars().last().or(Some(c));
        let is = |candidate: &str| !handle.is_empty() && candidate.eq_ignore_ascii_case(&handle);
        let mut matched: Vec<(String, Value)> = Vec::new();
        for member in members {
            if is(&mention_handle(&member.display_name)) {
                matched.push(person_mention(member));
            }
            if let Some(agent_name) = &member.agent_name {
                if is(&agent_mention_handle(
                    agent_name.as_deref(),
                    &member.display_name,
                )) {
                    matched.push(agent_mention(member, agent_name.as_deref()));
                }
            }
        }
        // An ambiguous handle must never pick a member by position.
        let visible = match matched.as_mut_slice() {
            [(visible, mention)] => {
                let length = visible.encode_utf16().count();
                mention["displayText"] = json!(visible);
                mention["startUtf16"] = json!(out_utf16);
                mention["lengthUtf16"] = json!(length);
                mentions.push(mention.take());
                visible.clone()
            }
            _ => format!("@{handle}"),
        };
        out_utf16 += visible.encode_utf16().count();
        out.push_str(&visible);
    }
    (out, mentions)
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
    fn handles_resolve_to_one_member_and_show_their_name() {
        let members = vec![
            member("acct_mina", "Mina Park", None),
            member("acct_theo", "Theo", None),
            member("acct_theo2", "Theo", None),
        ];
        let (text, mentions) =
            render_mentions("\u{1f44b} @MinaPark and @theo, email a@b", &members);
        assert_eq!(text, "\u{1f44b} @Mina Park and @theo, email a@b");
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["targetIdentityId"], "human:acct_mina");
        assert_eq!(mentions[0]["displayText"], "@Mina Park");
        assert_eq!(mentions[0]["startUtf16"], 3);
        assert_eq!(mentions[0]["lengthUtf16"], 10);
    }

    /// The exact message and mentions that
    /// `app/desktop/tests/systemAgentMentions.test.tsx` feeds to the renderer.
    #[test]
    fn rendered_mentions_match_the_desktop_fixture() {
        let members = vec![
            member("acct_maya", "Maya Patel Synthetic", None),
            member("acct_ana", "Ana", Some("Scout")),
            MentionMember {
                account_id: "acct_system".to_string(),
                display_name: "System".to_string(),
                agent_name: None,
            },
        ];
        let (text, mentions) = render_mentions(
            "@MayaPatelSynthetic does 7pm work? @ScoutAna can confirm. @KordiSystem",
            &members,
        );
        assert_eq!(
            text,
            "@Maya Patel Synthetic does 7pm work? @Ana's Scout can confirm. @KordiSystem"
        );
        assert_eq!(
            mentions[0],
            json!({"label": "MayaPatelSynthetic", "targetKind": "person",
                "targetIdentityId": "human:acct_maya", "humanId": "acct_maya",
                "displayLabel": "Maya Patel Synthetic", "displayText": "@Maya Patel Synthetic",
                "startUtf16": 0, "lengthUtf16": 21})
        );
        assert_eq!(
            mentions[1],
            json!({"label": "ScoutAna", "targetKind": "agent",
                "targetIdentityId": "agent:cloud-agent:acct_ana", "agentId": "cloud-agent:acct_ana",
                "ownerAccountId": "acct_ana", "sourceHostId": "cloud",
                "displayLabel": "Ana's Scout", "displayText": "@Ana's Scout",
                "startUtf16": 37, "lengthUtf16": 12})
        );
        assert_eq!(mentions.len(), 2);
        assert_eq!(agent_mention_handle(Some("My Kordi"), "Ana"), "KordiAna");
    }
}
