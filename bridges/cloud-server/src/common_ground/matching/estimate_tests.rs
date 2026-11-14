use super::*;

fn card(
    id: &str,
    working_on: &[&str],
    interests: &[&str],
    can_help: &[&str],
    looking_for: &[&str],
) -> SharedCard {
    let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    SharedCard {
        account_id: format!("acct_{id}"),
        profile_id: format!("prof_{id}"),
        profile_kind: "work".into(),
        profile_name: "Work".into(),
        profile_design: None,
        profile_icon: None,
        name: id.into(),
        handle: None,
        avatar_url: None,
        revision: 1,
        topics: Topics {
            working_on: list(working_on),
            interests: list(interests),
            can_help: list(can_help),
            looking_for: list(looking_for),
            ..Topics::default()
        },
    }
}

#[test]
fn the_same_topic_is_shared_and_heads_the_match() {
    let ada = card("ada", &["Agent memory benchmarks"], &[], &[], &[]);
    let bo = card("bo", &["agent memory benchmark"], &["Climbing"], &[], &[]);
    let rarity = Rarity::of(&[ada.clone(), bo.clone()]);
    let found = estimate(&ada, &bo, &rarity);
    assert_eq!(found.shared.len(), 1);
    assert_eq!(found.shared[0].topic, "Agent memory benchmarks");
    assert_eq!(found.shared[0].their_topic, "agent memory benchmark");
    assert!(found.shared[0].why.is_empty());
    assert_eq!(found.headline, "agent memory benchmark");
    assert!(found.score > 30, "score {}", found.score);
}

#[test]
fn a_common_word_alone_is_not_the_same_area() {
    // "memory" is on every card, so "GPU memory" and "agent memory" differ.
    let ada = card("ada", &["GPU memory"], &[], &[], &[]);
    let bo = card("bo", &["Agent memory"], &[], &[], &[]);
    let others: Vec<SharedCard> = (0..8)
        .map(|i| {
            card(
                &format!("p{i}"),
                &[&format!("memory topic {i}")],
                &[],
                &[],
                &[],
            )
        })
        .collect();
    let mut room = vec![ada.clone(), bo.clone()];
    room.extend(others);
    let rarity = Rarity::of(&room);
    let found = estimate(&ada, &bo, &rarity);
    assert!(found.shared.is_empty());
    assert_eq!(found.score, 0);
    assert_eq!(found.headline, "Different area");
}

#[test]
fn a_skill_that_serves_what_someone_looks_for_is_a_trade() {
    let ada = card(
        "ada",
        &["Robot arms"],
        &[],
        &["Rust embedded firmware"],
        &[],
    );
    let bo = card(
        "bo",
        &["Drone swarms"],
        &[],
        &[],
        &["embedded Rust firmware help"],
    );
    let rarity = Rarity::of(&[ada.clone(), bo.clone()]);
    let found = estimate(&ada, &bo, &rarity);
    assert!(found.shared.is_empty());
    assert_eq!(found.you_bring.len(), 1);
    assert_eq!(found.you_bring[0].topic, "Rust embedded firmware");
    assert_eq!(found.you_bring[0].target, "embedded Rust firmware help");
    assert!(found.they_bring.is_empty());
    assert_eq!(found.headline, "Needs your Rust embedded firmware");
    assert!(found.score > 0);
    // The same pair from the other side.
    let back = estimate(&bo, &ada, &rarity);
    assert_eq!(back.they_bring.len(), 1);
    assert_eq!(back.score, found.score);
}

#[test]
fn closer_topics_rank_higher() {
    let ada = card(
        "ada",
        &["LLM evaluation harness"],
        &["Rock climbing"],
        &[],
        &[],
    );
    let close = card(
        "close",
        &["Evaluation harness for LLM agents"],
        &[],
        &[],
        &[],
    );
    let loose = card("loose", &[], &["LLM product design"], &[], &[]);
    let rarity = Rarity::of(&[ada.clone(), close.clone(), loose.clone()]);
    let close_score = estimate(&ada, &close, &rarity).score;
    let loose_score = estimate(&ada, &loose, &rarity).score;
    assert!(close_score > loose_score, "{close_score} vs {loose_score}");
}

#[test]
fn each_topic_is_used_once_and_lists_are_capped() {
    let ada = card(
        "ada",
        &["vector search", "vector databases", "vector search ranking"],
        &[],
        &[],
        &[],
    );
    let bo = card(
        "bo",
        &["vector search", "vector search ranking", "vector databases"],
        &[],
        &[],
        &[],
    );
    let rarity = Rarity::of(&[ada.clone(), bo.clone()]);
    let found = estimate(&ada, &bo, &rarity);
    assert_eq!(found.shared.len(), MAX_PAIRS);
    let mine: HashSet<&String> = found.shared.iter().map(|r| &r.topic).collect();
    let theirs: HashSet<&String> = found.shared.iter().map(|r| &r.their_topic).collect();
    assert_eq!(mine.len(), MAX_PAIRS);
    assert_eq!(theirs.len(), MAX_PAIRS);
    // Exact labels pair with each other first.
    assert!(found.shared.iter().all(|r| r.topic == r.their_topic));
}

#[test]
fn plurals_fold_and_stop_words_drop() {
    assert_eq!(words("The Agents of Memories"), vec!["agent", "memory"]);
    assert_eq!(words("class analysis"), vec!["class", "analysis"]);
}
