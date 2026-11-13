//! Grounding match runs: the server's match instructions, the runner's
//! Common ground completion on the System agent's credential, and the
//! server's reply parsing and scoring. No database is involved.

use kordi_cloud_server::common_ground::quality::{
    prompt_sha256, Addressing, MatchFinding, MatchRun, MatchTrade, MATCH_SYSTEM_PROMPT,
};
use kordi_cloud_server::system_agent::SystemAgentConfig;
use serde::{Deserialize, Serialize};

use crate::match_suite::{Label, MatchFixture, PairKind, Strength};
use crate::replay::{Engine, UsageRecord};
use crate::score::{check, Check};

/// The check metric of match runs.
pub const METRIC: &str = "groundingMatch";

/// The match instructions before the server kept one finding for both
/// people (PR #2503), verbatim.
const BASELINE: &str = include_str!("match_system_baseline.txt");

/// Which match instructions a run uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchPrompt {
    /// The instructions the server queues today.
    Current,
    /// The wording before PR #2503.
    Baseline,
}

impl MatchPrompt {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "current" => Some(Self::Current),
            "baseline" => Some(Self::Baseline),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Baseline => "baseline",
        }
    }

    pub fn text(self) -> &'static str {
        match self {
            Self::Current => MATCH_SYSTEM_PROMPT,
            Self::Baseline => BASELINE.strip_suffix('\n').unwrap_or(BASELINE),
        }
    }

    pub fn info(self) -> PromptInfo {
        PromptInfo {
            name: self.name().to_string(),
            sha256: prompt_sha256(self.text()),
        }
    }
}

/// The match instructions a report's runs used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptInfo {
    /// `current` or `baseline`.
    pub name: String,
    /// SHA-256 of the instruction text.
    pub sha256: String,
}

/// Why a finding is kept for the viewer only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Cause {
    SecondPerson,
    Name,
}

impl From<Addressing> for Cause {
    fn from(addressing: Addressing) -> Self {
        match addressing {
            Addressing::SecondPerson => Self::SecondPerson,
            Addressing::Name => Self::Name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPair {
    pub topic: String,
    pub their_topic: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TradePair {
    pub topic: String,
    #[serde(rename = "for")]
    pub target: String,
    pub why: String,
}

/// What the server keeps for one other person, from the viewer's side.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// The other person's id in the suite.
    pub person: String,
    pub score: i64,
    /// The score of the same finding stored for the other person.
    pub reversed_score: i64,
    pub headline: String,
    pub shared: Vec<SharedPair>,
    pub you_bring: Vec<TradePair>,
    pub they_bring: Vec<TradePair>,
    pub next_step: String,
    pub reads_for_either: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<Cause>,
    /// Pairs the reply proposed for this person and pairs the server kept.
    pub proposed: usize,
    pub kept: usize,
}

impl Finding {
    pub fn from_server(person: &str, finding: MatchFinding) -> Self {
        let trades = |trades: Vec<MatchTrade>| {
            trades
                .into_iter()
                .map(|trade| TradePair {
                    topic: trade.topic,
                    target: trade.target,
                    why: trade.why,
                })
                .collect()
        };
        Self {
            person: person.to_string(),
            score: finding.score,
            reversed_score: finding.reversed_score,
            headline: finding.headline,
            shared: finding
                .shared
                .into_iter()
                .map(|reason| SharedPair {
                    topic: reason.topic,
                    their_topic: reason.their_topic,
                    why: reason.why,
                })
                .collect(),
            you_bring: trades(finding.you_bring),
            they_bring: trades(finding.they_bring),
            next_step: finding.next_step,
            reads_for_either: finding.reads_for_either,
            cause: finding.addressing.map(Cause::from),
            proposed: finding.proposed,
            kept: finding.kept,
        }
    }

    fn describe(&self) -> String {
        let mut kept: Vec<String> = self
            .shared
            .iter()
            .map(|pair| format!("shared {} ~ {}", pair.topic, pair.their_topic))
            .collect();
        kept.extend(
            self.you_bring
                .iter()
                .chain(&self.they_bring)
                .map(|trade| format!("trade {} for {}", trade.topic, trade.target)),
        );
        if kept.is_empty() {
            "kept nothing".into()
        } else {
            format!("kept {}", kept.join("; "))
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageRecord>,
    /// The reply as the model wrote it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Why the server would fail the run (`invalid_output`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
    /// One finding per other person, in the run's order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub findings: Option<Vec<Finding>>,
}

impl MatchOutcome {
    /// Reads a reply the way a finished run does.
    pub fn from_reply(fixture: &MatchFixture, run: &MatchRun, reply: String) -> Self {
        let mut outcome = Self::default();
        match run.parse(&reply) {
            Ok(findings) => {
                outcome.findings = Some(
                    fixture
                        .others
                        .iter()
                        .zip(findings)
                        .map(|(other, finding)| Finding::from_server(&other.id, finding))
                        .collect(),
                );
            }
            Err(code) => outcome.rejected = Some(code.to_string()),
        }
        outcome.output = Some(reply);
        outcome
    }
}

/// What the server would queue for the fixture, with `prompt`'s instructions.
pub fn match_run(fixture: &MatchFixture, prompt: MatchPrompt) -> MatchRun {
    let others: Vec<_> = fixture.others.iter().map(|person| person.card()).collect();
    MatchRun::new(&fixture.viewer.card(), &others).with_system_prompt(prompt.text())
}

/// One match run through the runner, read the way a finished run is.
pub async fn run(
    config: &SystemAgentConfig,
    engine: Engine,
    fixture: &MatchFixture,
    prompt: MatchPrompt,
) -> anyhow::Result<MatchOutcome> {
    let run = match_run(fixture, prompt);
    let (result, latency_ms, usage) = crate::grounding::complete(
        config,
        engine,
        &run.system_prompt,
        &run.user_prompt,
        Some(&fixture.stub),
    )
    .await?;
    let mut outcome = match result {
        Ok(reply) => MatchOutcome::from_reply(fixture, &run, reply),
        Err(error) => MatchOutcome {
            error: Some(crate::redact::provider_error(&error)),
            ..MatchOutcome::default()
        },
    };
    outcome.latency_ms = latency_ms;
    outcome.usage = usage;
    Ok(outcome)
}

/// The check for one labelled person, if the label has one: a strong pair
/// keeps a pair of its kind, a pair labelled none keeps nothing.
fn label_check(id: &str, label: Label, finding: &Finding) -> Option<Check> {
    let traded = !finding.you_bring.is_empty() || !finding.they_bring.is_empty();
    let (name, passed) = match (label.strength, label.kind) {
        (Strength::Strong, PairKind::Complement) => {
            (format!("strong complement {id} keeps a trade"), traded)
        }
        (Strength::Strong, kind) => (
            format!("strong {} {id} keeps a shared pair", kind.name()),
            !finding.shared.is_empty(),
        ),
        (Strength::None, kind) => (
            format!("{} {id} keeps nothing", kind.name()),
            finding.kept == 0,
        ),
        (Strength::Weak, _) => return None,
    };
    Some(check(METRIC, name, passed, Some(finding.describe())))
}

pub fn score_match(fixture: &MatchFixture, outcome: &MatchOutcome) -> Vec<Check> {
    let mut checks = vec![check(
        "reliability",
        "run completes",
        outcome.error.is_none(),
        outcome.error.clone(),
    )];
    if outcome.error.is_some() {
        return checks;
    }
    checks.push(check(
        METRIC,
        "reply becomes a match list",
        outcome.findings.is_some(),
        outcome.rejected.clone(),
    ));
    let Some(findings) = &outcome.findings else {
        return checks;
    };
    for ((other, label), finding) in fixture.others.iter().zip(&fixture.labels).zip(findings) {
        if let Some(check) = label.and_then(|label| label_check(&other.id, label, finding)) {
            checks.push(check);
        }
    }
    checks
}

#[cfg(test)]
#[path = "match_run_tests.rs"]
mod tests;
