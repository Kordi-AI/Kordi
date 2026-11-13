//! What `run` and `list` replay, from their command-line options.

use anyhow::{bail, Context, Result};

use crate::fixture::{Fixture, KIND_NAMES};
use crate::match_run::MatchPrompt;

/// The fixtures that `--only` names, all of which must exist, and that are
/// of the `--kind` given. Fails when nothing is left.
pub fn select(
    mut fixtures: Vec<Fixture>,
    only: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Fixture>> {
    if let Some(kind) = kind.filter(|kind| !KIND_NAMES.contains(kind)) {
        bail!("unknown --kind {kind}; use {}", KIND_NAMES.join(", "));
    }
    if let Some(only) = only {
        let wanted: Vec<&str> = only
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .collect();
        if let Some(missing) = wanted
            .iter()
            .find(|id| !fixtures.iter().any(|fixture| fixture.id() == **id))
        {
            bail!("--only names {missing}, which is not a fixture");
        }
        fixtures.retain(|fixture| wanted.contains(&fixture.id()));
    }
    if let Some(kind) = kind {
        fixtures.retain(|fixture| fixture.kind_name() == kind);
    }
    if fixtures.is_empty() {
        bail!("no fixture is selected by both --only and --kind");
    }
    Ok(fixtures)
}

/// `--repeat`: how many times each fixture is replayed, at least once.
pub fn repeat(value: Option<&str>) -> Result<usize> {
    match value.map(str::parse::<usize>) {
        None => Ok(1),
        Some(Ok(count)) if count >= 1 => Ok(count),
        Some(_) => bail!("--repeat must be a whole number of at least 1"),
    }
}

/// Fixtures that replay into a database run once per database, so repeats
/// are for the database-free kinds only.
pub fn check_repeat(fixtures: &[Fixture], repeat: usize) -> Result<()> {
    if repeat == 1 {
        return Ok(());
    }
    if let Some(fixture) = fixtures.iter().find(|fixture| fixture.needs_database()) {
        bail!(
            "--repeat replays only fixtures that need no database, and {} needs one; \
             narrow the run with --only or with --kind grounding or --kind grounding-match",
            fixture.id()
        );
    }
    Ok(())
}

/// `--match-prompt`: `current` (the default) or `baseline`.
pub fn match_prompt(value: Option<&str>) -> Result<MatchPrompt> {
    value
        .map(|name| {
            MatchPrompt::parse(name)
                .with_context(|| format!("unknown --match-prompt {name}; use current or baseline"))
        })
        .unwrap_or(Ok(MatchPrompt::Current))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<Fixture> {
        crate::fixture::load_dir(&crate::default_fixture_dir(), chrono::Utc::now()).unwrap()
    }

    #[test]
    fn kind_and_only_filter_together() {
        let matches = select(all(), None, Some("grounding-match")).unwrap();
        assert!(matches
            .iter()
            .all(|fixture| fixture.kind() == "groundingMatch"));
        assert_eq!(matches[0].id(), "match-lab-r1-p01-1");
        let both = select(
            all(),
            Some("match-lab-r1-p01-1, grounding-work-profile"),
            Some("grounding"),
        )
        .unwrap();
        let ids: Vec<&str> = both.iter().map(Fixture::id).collect();
        assert_eq!(ids, ["grounding-work-profile"]);
        assert!(select(all(), None, Some("matching")).is_err());
        assert!(select(all(), Some("no-such-fixture"), None).is_err());
        assert!(select(all(), Some("match-lab-r1-p01-1"), Some("system-agent")).is_err());
    }

    #[test]
    fn repeats_need_a_whole_number_and_no_database() {
        assert_eq!(repeat(None).unwrap(), 1);
        assert_eq!(repeat(Some("3")).unwrap(), 3);
        for bad in ["0", "-1", "two", "1.5"] {
            assert!(repeat(Some(bad)).is_err(), "{bad}");
        }
        let fixtures = all();
        assert!(check_repeat(&fixtures, 1).is_ok());
        let error = check_repeat(&fixtures, 2).unwrap_err().to_string();
        assert!(error.contains("--kind"), "{error}");
        let free = select(fixtures, None, Some("grounding-match")).unwrap();
        assert!(check_repeat(&free, 2).is_ok());
        assert_eq!(match_prompt(None).unwrap(), MatchPrompt::Current);
        assert_eq!(
            match_prompt(Some("baseline")).unwrap(),
            MatchPrompt::Baseline
        );
        assert!(match_prompt(Some("newest")).is_err());
    }
}
