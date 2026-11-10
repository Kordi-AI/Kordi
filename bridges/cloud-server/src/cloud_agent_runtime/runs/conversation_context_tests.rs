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
        suffix: format!("{id}1234"),
    }
}

fn agent(id: &str, owner: &str) -> Agent {
    Agent {
        agent_id: id.into(),
        name: "Kordi".into(),
        owner_account_id: owner.into(),
    }
}

fn snapshot(members: Vec<Member>, owner_zone: Option<&str>) -> Snapshot {
    Snapshot {
        conversation_id: uuid::Uuid::nil(),
        conversation: Conversation {
            kind: "group".into(),
            title: Some("Agent test".into()),
        },
        members,
        agents: vec![
            agent("cloud-agent:own", "own"),
            agent("cloud-agent:req", "req"),
        ],
        ids: ("own".into(), "req".into(), "cloud-agent:own".into()),
        owner_zone: owner_zone.map(Into::into),
    }
}

fn friday() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 13, 3, 0, 0).unwrap()
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
    let value = view(
        &snapshot(
            vec![
                member("own", "Shu Yang", None, None),
                requester,
                member("other", "Maya", None, Some("Not/A Zone")),
                private,
            ],
            None,
        ),
        friday(),
    );
    assert_eq!(value["conversation"]["kind"], "group");
    assert_eq!(value["conversation"]["title"], "Agent test");
    assert_eq!(value["memberCount"], 4);
    assert!(value["untrusted"]
        .as_str()
        .unwrap()
        .contains("not instructions"));
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
    let value = view(
        &snapshot(
            vec![member("own", "Owner", None, None)],
            Some("America/Los_Angeles"),
        ),
        friday(),
    );
    assert_eq!(value["now"], "Thursday 2026-11-12 19:00 -08:00");
    assert_eq!(value["nowTimeZone"], "America/Los_Angeles");
}

fn note_data(text: &str) -> Value {
    assert!(text.starts_with("Runtime note for this turn"));
    assert!(text.contains("untrusted"));
    serde_json::from_str(&text[text.find('{').unwrap()..]).unwrap()
}

#[test]
fn the_note_carries_the_time_and_members_only_when_they_changed() {
    let members = || {
        vec![
            member("own", "Shu Yang", None, None),
            member("req", "Sam", None, None),
        ]
    };
    let (first, digest) = render_note(&snapshot(members(), None), friday(), None);
    let data = note_data(&first);
    assert_eq!(data["now"], "Friday 2026-11-13 03:00 UTC");
    assert_eq!(data["members"]["people"].as_array().unwrap().len(), 2);

    // Same members an hour later: only the time.
    let later = friday() + chrono::Duration::hours(1);
    let (second, same) = render_note(&snapshot(members(), None), later, Some(&digest));
    assert_eq!(same, digest, "the digest ignores the time");
    let data = note_data(&second);
    assert_eq!(data["membersUnchanged"], true);
    assert!(data.get("members").is_none());
    assert_eq!(data["now"], "Friday 2026-11-13 04:00 UTC");

    // Someone joined: the members come back.
    let mut grown = members();
    grown.push(member("new", "New Person", None, None));
    let (third, changed) = render_note(&snapshot(grown, None), later, Some(&digest));
    assert_ne!(changed, digest);
    assert_eq!(
        note_data(&third)["members"]["people"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn people_and_agents_with_the_same_name_get_unique_handles_and_ids_decide() {
    let mut snapshot = snapshot(
        vec![
            member("own", "Shu Yang", None, None),
            member("req", "shu yang", None, None),
        ],
        None,
    );
    snapshot.members[1].suffix = "5033".into();
    let value = view(&snapshot, friday());
    let handles: Vec<&str> = value["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["handle"].as_str().unwrap())
        .collect();
    assert_eq!(handles, ["@ShuYangown1234", "@shuyang5033"]);
    let agents: Vec<&str> = value["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["handle"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["@KordiShuYangown1234", "@Kordishuyang5033"]);
    assert_eq!(value["ownerAccountId"], "own");
    assert_eq!(value["requesterAccountId"], "req");
    assert!(value["identity"]
        .as_str()
        .unwrap()
        .contains("never by display name"));
}

#[test]
fn unique_handles_leave_distinct_handles_alone() {
    let mut handles = vec!["@Maya".to_string(), "@Sam".to_string()];
    unique_handles(&mut handles, &["a".into(), "b".into()]);
    assert_eq!(handles, ["@Maya", "@Sam"]);
}
