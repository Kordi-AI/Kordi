use super::*;

fn observation(viewer: &str, other: &str, strength: Option<Strength>, score: i64) -> Observation {
    Observation {
        suite: "s".into(),
        room: Some("r1".into()),
        viewer: viewer.into(),
        other: other.into(),
        strength,
        score,
        shared: BTreeSet::new(),
        proposed: 0,
        kept: 0,
        reads_for_either: true,
        cause: None,
    }
}

fn pairs(items: &[(&str, &str)]) -> BTreeSet<(String, String)> {
    items
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

fn value(measures: &[Measure], name: &str) -> (f64, usize) {
    let measure = measures
        .iter()
        .find(|m| m.name == format!("s/{name}"))
        .unwrap_or_else(|| panic!("no {name} in {measures:#?}"));
    (measure.value, measure.samples)
}

#[test]
fn auc_counts_wins_and_half_of_ties() {
    // 80 beats both, 60 beats 0 and ties 60, 0 ties 0: 4 of 6.
    let auc = auc(&[80, 60, 0], &[0, 60]).unwrap();
    assert!((auc - 4.0 / 6.0).abs() < 1e-12, "{auc}");
    assert_eq!(super::auc(&[50], &[10, 20]), Some(1.0));
    assert_eq!(super::auc(&[], &[10]), None);
}

#[test]
fn the_top_three_ignore_zero_scores_and_keep_the_order_of_ties() {
    let ranked = [
        ("a", 90),
        ("b", 0),
        ("c", 70),
        ("d", 70),
        ("e", 40),
        ("f", 95),
    ];
    let set = |items: &[&'static str]| items.iter().copied().collect::<BTreeSet<&str>>();
    // f, a, c: d ties with c but comes later.
    assert_eq!(top_three(&ranked, &set(&["e"]), &set(&["d"])), (false, 0));
    assert_eq!(
        top_three(&ranked, &set(&["c"]), &set(&["a", "b"])),
        (true, 1)
    );
    // Zero scores never fill the top three.
    assert_eq!(
        top_three(&[("a", 0), ("b", 30)], &set(&["a"]), &set(&["a"])),
        (false, 0)
    );
}

#[test]
fn directions_agree_by_shared_pairs_after_swapping_sides_and_by_score() {
    let mut xy = observation("x", "y", None, 80);
    xy.shared = pairs(&[("A", "B"), ("C", "D")]);
    let mut yx = observation("y", "x", None, 60);
    yx.shared = pairs(&[("B", "A")]);
    // Trades only, both ways: no shared pairs to compare, scores differ by 10.
    let yz = observation("y", "z", None, 30);
    let zy = observation("z", "y", None, 40);
    // Nothing either way: left out of both.
    let xz = observation("x", "z", None, 0);
    let zx = observation("z", "x", None, 0);
    // Seen one way only.
    let xw = observation("x", "w", None, 50);
    let all = [&xy, &yx, &yz, &zy, &xz, &zx, &xw];
    let measures = suite_measures("s", &all);
    assert_eq!(value(&measures, "direction_shared_jaccard"), (0.5, 1));
    assert_eq!(value(&measures, "direction_score_difference"), (15.0, 2));
    assert_eq!(jaccard(&pairs(&[]), &pairs(&[])), None);
    assert_eq!(jaccard(&pairs(&[("A", "B")]), &pairs(&[])), Some(0.0));
}

#[test]
fn suite_numbers_cover_auc_top_three_scores_drops_and_wording() {
    let strong = Some(Strength::Strong);
    let none = Some(Strength::None);
    let mut maya_tomas = observation("maya", "tomas", strong, 90);
    (maya_tomas.proposed, maya_tomas.kept) = (3, 2);
    let mut maya_priya = observation("maya", "priya", strong, 40);
    (maya_priya.proposed, maya_priya.kept) = (1, 1);
    maya_priya.reads_for_either = false;
    maya_priya.cause = Some(Cause::SecondPerson);
    let mut maya_dmitri = observation("maya", "dmitri", none, 60);
    (maya_dmitri.proposed, maya_dmitri.kept) = (1, 1);
    maya_dmitri.reads_for_either = false;
    maya_dmitri.cause = Some(Cause::Name);
    let maya_sana = observation("maya", "sana", none, 0);
    let mut lena_arjun = observation("lena", "arjun", Some(Strength::Weak), 20);
    lena_arjun.room = None;
    let all = [
        &maya_tomas,
        &maya_priya,
        &maya_dmitri,
        &maya_sana,
        &lena_arjun,
    ];
    let measures = suite_measures("s", &all);
    // Strong 90 and 40 against none 60 and 0: 90 wins twice, 40 once.
    assert_eq!(value(&measures, "auc_strong_vs_none"), (0.75, 4));
    // With weak 20, which beats only 0: 4 of 6 wins.
    let (any, samples) = value(&measures, "auc_strong_weak_vs_none");
    assert!((any - 4.0 / 6.0).abs() < 1e-12 && samples == 5);
    // Maya's top three: tomas 90, dmitri 60, priya 40.
    assert_eq!(value(&measures, "top3_hit_rate"), (1.0, 1));
    assert_eq!(value(&measures, "top3_none_count"), (1.0, 1));
    assert_eq!(value(&measures, "strong_score_at_least_50"), (0.5, 2));
    assert_eq!(value(&measures, "strong_score_at_least_85"), (0.5, 2));
    assert_eq!(value(&measures, "dropped_pair_rate"), (0.2, 5));
    let third = 1.0 / 3.0;
    assert_eq!(value(&measures, "either_person_rate"), (third, 3));
    assert_eq!(
        value(&measures, "either_person_second_person_rate"),
        (third, 3)
    );
    assert_eq!(value(&measures, "either_person_name_rate"), (third, 3));
}

#[test]
fn numbers_keep_suites_apart_and_list_each_repeat() {
    let mut lab = observation("a", "b", Some(Strength::Strong), 80);
    lab.suite = "lab".into();
    let mut names = observation("c", "d", Some(Strength::Strong), 40);
    names.suite = "names".into();
    let first = vec![lab.clone(), names.clone()];
    lab.score = 60;
    let second = vec![lab, names];
    let numbers = numbers(&[first, second]);
    let lab = numbers
        .iter()
        .find(|n| n.name == "lab/strong_score_at_least_70")
        .unwrap();
    assert_eq!(lab.per_repeat, vec![1.0, 0.0]);
    assert_eq!((lab.value, lab.samples), (0.5, 2));
    let names = numbers
        .iter()
        .find(|n| n.name == "names/strong_score_at_least_70")
        .unwrap();
    assert_eq!(names.per_repeat, vec![0.0, 0.0]);
    assert!(numbers
        .iter()
        .all(|n| !n.name.ends_with("auc_strong_vs_none")));
}
