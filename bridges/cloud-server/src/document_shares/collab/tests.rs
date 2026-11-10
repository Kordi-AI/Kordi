//! Pure tests for collaboration tickets, the init grant, frame decoding, and
//! relay payloads. Socket and storage tests live in
//! `document_shares/tests/collab_*.rs`.

use chrono::{Duration, Utc};

use super::relay::{awareness_payload, query_payload, update_payload, Signal, MAX_PAYLOAD_BYTES};
use super::rooms::decode_messages;
use super::tickets::{
    bind_origin, grants_init, random_ticket, ticket_hash, InitState, TicketError, TICKET_PREFIX,
};

#[test]
fn tickets_are_opaque_random_and_hash_stably() {
    let first = random_ticket();
    let second = random_ticket();
    assert!(first.starts_with(TICKET_PREFIX));
    assert_eq!(first.len(), TICKET_PREFIX.len() + 43);
    assert_ne!(first, second);
    assert_eq!(ticket_hash(&first).unwrap(), ticket_hash(&first).unwrap());
    assert_ne!(ticket_hash(&first).unwrap(), ticket_hash(&second).unwrap());
    assert!(!ticket_hash(&first)
        .unwrap()
        .contains(&first[TICKET_PREFIX.len()..]));
    for invalid in [
        "",
        "kordi_dc_short",
        "kordi_rt_AAAA",
        &first.replace(TICKET_PREFIX, "kordi_rt_"),
    ] {
        assert!(
            matches!(ticket_hash(invalid), Err(TicketError::InvalidTicket)),
            "{invalid}"
        );
    }
}

#[test]
fn ticket_origins_are_allowlisted_and_bound() {
    let allowed = vec![
        "tauri://localhost".to_string(),
        "http://127.0.0.1".to_string(),
    ];
    assert_eq!(
        bind_origin(None, &allowed).unwrap(),
        None,
        "native clients send no origin"
    );
    assert_eq!(bind_origin(Some("  "), &allowed).unwrap(), None);
    assert_eq!(
        bind_origin(Some("tauri://localhost"), &allowed)
            .unwrap()
            .as_deref(),
        Some("tauri://localhost")
    );
    assert_eq!(
        bind_origin(Some("http://127.0.0.1:1420"), &allowed)
            .unwrap()
            .as_deref(),
        Some("http://127.0.0.1:1420"),
        "a bare loopback entry allows any port"
    );
    for refused in ["null", "https://example.com", "http://127.0.0.2:1420"] {
        assert!(
            matches!(
                bind_origin(Some(refused), &allowed),
                Err(TicketError::OriginNotAllowed)
            ),
            "{refused}"
        );
    }
}

fn state(initialized: bool, holder: Option<&str>, expires_in: Option<i64>) -> InitState {
    let now = Utc::now();
    InitState {
        initialized,
        granted_to: holder.map(str::to_string),
        grant_expires_at: expires_in.map(|seconds| now + Duration::seconds(seconds)),
    }
}

#[test]
fn exactly_one_editor_is_granted_the_seed() {
    let now = Utc::now();
    assert!(
        grants_init(&state(false, None, None), "acct_a", now),
        "first caller"
    );
    assert!(
        grants_init(&state(false, Some("acct_a"), Some(20)), "acct_a", now),
        "holder keeps it"
    );
    assert!(
        !grants_init(&state(false, Some("acct_a"), Some(20)), "acct_b", now),
        "others wait"
    );
    assert!(
        grants_init(&state(false, Some("acct_a"), Some(-1)), "acct_b", now),
        "an expired grant passes on"
    );
    assert!(
        !grants_init(&state(true, None, None), "acct_a", now),
        "initialized rooms seed nobody"
    );
    assert!(!grants_init(
        &state(true, Some("acct_a"), Some(20)),
        "acct_a",
        now
    ));
}

#[test]
fn frames_must_hold_known_messages() {
    // Sync step 1 with an empty state vector: [0 sync, 0 step1, buf len 1, 0 entries].
    assert_eq!(decode_messages(&[0, 0, 1, 0]).unwrap().len(), 1);
    assert!(decode_messages(&[]).is_err(), "empty frame");
    assert!(decode_messages(&[0, 9]).is_err(), "unknown sync step");
    assert!(decode_messages(&[0, 0, 5, 1]).is_err(), "truncated");
}

#[test]
fn relay_payloads_round_trip() {
    let payload = update_payload("att_doc_1", 42);
    assert_eq!(payload, "u:att_doc_1:42");
    assert_eq!(
        Signal::parse(&payload),
        Some(Signal::Update {
            attachment_id: "att_doc_1".into(),
            seq: 42
        })
    );

    let update = vec![1, 2, 3, 250, 0, 58];
    let payload = awareness_payload("origin1", "att:with:colons", &update).unwrap();
    assert!(payload.starts_with("a:origin1:att:with:colons:"));
    assert_eq!(
        Signal::parse(&payload),
        Some(Signal::Awareness {
            origin: "origin1".into(),
            attachment_id: "att:with:colons".into(),
            update
        })
    );

    let payload = query_payload("origin1", "att_doc_1");
    assert_eq!(payload, "q:origin1:att_doc_1");
    assert_eq!(
        Signal::parse(&payload),
        Some(Signal::Query {
            origin: "origin1".into(),
            attachment_id: "att_doc_1".into()
        })
    );
}

#[test]
fn oversized_awareness_is_not_sent() {
    let fits = vec![7_u8; 5_000];
    assert!(awareness_payload("origin1", "att_doc_1", &fits).is_some());
    let too_large = vec![7_u8; MAX_PAYLOAD_BYTES];
    assert!(awareness_payload("origin1", "att_doc_1", &too_large).is_none());
}

#[test]
fn malformed_relay_payloads_are_ignored() {
    for payload in [
        "",
        "u",
        "u:",
        "u:att_doc_1",
        "u::5",
        "u:att_doc_1:0",
        "u:att_doc_1:-3",
        "u:att_doc_1:many",
        "a:origin1:att_doc_1",
        "a:origin1:att_doc_1:not base64!",
        "a::att_doc_1:AQID",
        "a:origin1::AQID",
        "a:origin1:att_doc_1:",
        "q:origin1",
        "q::att_doc_1",
        "q:origin1:",
        "x:origin1:att_doc_1",
        "att_doc_1",
    ] {
        assert_eq!(Signal::parse(payload), None, "{payload:?}");
    }
}
