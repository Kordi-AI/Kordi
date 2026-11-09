use super::*;
use chrono::TimeZone;

fn member(id: &str, name: &str, location: Option<&str>, zone: Option<&str>) -> Member {
    Member {
        account_id: id.into(),
        name: name.into(),
        public_handle: None,
        location: location.map(Into::into),
        time_zone: zone.map(Into::into),
        ai_allowed: true,
    }
}

fn data(text: &str) -> Value {
    let mut lines = text.lines();
    assert!(lines.next().unwrap().contains("untrusted"));
    serde_json::from_str(lines.next().unwrap()).unwrap()
}

#[test]
fn members_agents_and_profile_fields_appear_only_when_set() {
    let mut requester = member("req", "Sam Lee", Some(" Shenzhen "), Some("Asia/Shanghai"));
    requester.public_handle = Some("sam".into());
    let mut private = member(
        "quiet",
        "Quiet Person",
        Some("Somewhere"),
        Some("Europe/Paris"),
    );
    private.ai_allowed = false;
    let members = [
        member("own", "Shu Yang", None, None),
        requester,
        member("other", "Maya", None, Some("Not/A Zone")),
        private,
    ];
    let agents = [
        Agent {
            agent_id: "cloud-agent:own".into(),
            name: "Kordi".into(),
            owner_account_id: "own".into(),
        },
        Agent {
            agent_id: "cloud-agent:req".into(),
            name: "Kordi".into(),
            owner_account_id: "req".into(),
        },
    ];
    let now = Utc.with_ymd_and_hms(2026, 11, 13, 3, 0, 0).unwrap();
    let text = render(
        &Conversation {
            kind: "group".into(),
            title: Some("Agent test".into()),
        },
        &members,
        &agents,
        ("own", "req", "cloud-agent:own"),
        now,
        None,
    );
    assert!(text.contains("instead of asking who is in this conversation"));
    assert!(text.contains("Ask only for what is actually missing"));
    let value = data(&text);
    assert_eq!(value["conversation"]["kind"], "group");
    assert_eq!(value["conversation"]["title"], "Agent test");
    assert_eq!(value["memberCount"], 4);
    let people = value["people"].as_array().unwrap();
    assert_eq!(people[0]["isOwner"], true);
    assert!(people[0].get("location").is_none() && people[0].get("timeZone").is_none());
    assert_eq!(people[1]["handle"], "@SamLee");
    assert_eq!(people[1]["username"], "@sam");
    assert_eq!(people[1]["isRequester"], true);
    assert_eq!(people[1]["location"], "Shenzhen");
    assert_eq!(people[1]["timeZone"], "Asia/Shanghai");
    assert!(
        people[2].get("timeZone").is_none(),
        "unknown zones are dropped"
    );
    assert!(
        people[3].get("location").is_none() && people[3].get("timeZone").is_none(),
        "no profile fields for someone who declined AI"
    );
    assert_eq!(value["agents"][0]["handle"], "@KordiShuYang");
    assert_eq!(value["agents"][0]["isYou"], true);
    assert_eq!(value["agents"][1]["ownerName"], "Sam Lee");
    assert!(value["agents"][1].get("isYou").is_none());
    assert_eq!(value["now"], "Friday 2026-11-13 03:00 UTC");
    assert_eq!(value["nowTimeZone"], "UTC");
}

#[test]
fn the_current_time_is_in_the_owner_time_zone() {
    let now = Utc.with_ymd_and_hms(2026, 11, 13, 3, 0, 0).unwrap();
    let text = render(
        &Conversation {
            kind: "direct".into(),
            title: None,
        },
        &[member("own", "Owner", None, None)],
        &[],
        ("own", "own", "cloud-agent:own"),
        now,
        Some("America/Los_Angeles"),
    );
    let value = data(&text);
    assert_eq!(value["now"], "Thursday 2026-11-12 19:00 -08:00");
    assert_eq!(value["nowTimeZone"], "America/Los_Angeles");
    assert!(value["conversation"].get("title").is_none());
    assert_eq!(value["people"][0]["isRequester"], true);
}
