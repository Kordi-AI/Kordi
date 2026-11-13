//! Numbers in run reports, such as an AUC or a rate: one value per repeat,
//! their mean, and a comparison table that shows them side by side.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::report::RunReport;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Number {
    pub name: String,
    /// The mean of `perRepeat`.
    pub value: f64,
    /// Observations behind the value, over all repeats.
    pub samples: usize,
    /// The value in each repeat that could measure it, in order.
    pub per_repeat: Vec<f64>,
}

/// One repeat's value of a number and the observations behind it.
#[derive(Debug, Clone, PartialEq)]
pub struct Measure {
    pub name: String,
    pub value: f64,
    pub samples: usize,
}

impl Measure {
    pub fn new(name: impl Into<String>, value: f64, samples: usize) -> Self {
        Self {
            name: name.into(),
            value,
            samples,
        }
    }
}

/// Numbers from each repeat's measures, in the order names first appear.
pub fn combine(repeats: &[Vec<Measure>]) -> Vec<Number> {
    let mut numbers: Vec<Number> = Vec::new();
    for measure in repeats.iter().flatten() {
        let index = match numbers.iter().position(|n| n.name == measure.name) {
            Some(index) => index,
            None => {
                numbers.push(Number {
                    name: measure.name.clone(),
                    value: 0.0,
                    samples: 0,
                    per_repeat: Vec::new(),
                });
                numbers.len() - 1
            }
        };
        let number = &mut numbers[index];
        number.samples += measure.samples;
        number.per_repeat.push(measure.value);
    }
    for number in &mut numbers {
        number.value = number.per_repeat.iter().sum::<f64>() / number.per_repeat.len() as f64;
    }
    numbers
}

fn find<'a>(report: &'a RunReport, name: &str) -> Option<&'a Number> {
    report
        .summary
        .numbers
        .iter()
        .find(|number| number.name == name)
}

fn cell(number: Option<&Number>, base: Option<&Number>) -> String {
    let Some(number) = number else {
        return "n/a".into();
    };
    let mut text = format!("{:.3} (n={}", number.value, number.samples);
    if number.per_repeat.len() > 1 {
        let values: Vec<String> = number
            .per_repeat
            .iter()
            .map(|value| format!("{value:.3}"))
            .collect();
        text.push_str(&format!("; {}", values.join(" / ")));
    }
    text.push(')');
    if let Some(base) = base {
        text.push_str(&format!(" {:+.3}", number.value - base.value));
    }
    text
}

/// The numbers of every run side by side, the first run being the baseline:
/// a Markdown section (empty when no run has numbers) and a JSON list.
pub fn compare(runs: &[&RunReport]) -> (String, Value) {
    let mut names: Vec<&str> = Vec::new();
    for report in runs {
        for number in &report.summary.numbers {
            if !names.contains(&number.name.as_str()) {
                names.push(&number.name);
            }
        }
    }
    if names.is_empty() {
        return (String::new(), json!([]));
    }
    let header: Vec<&str> = runs.iter().map(|report| report.label.as_str()).collect();
    let mut md = format!(
        "\n\n## Numbers\n\nMean over repeats (observations; each repeat) and the change from {}.\n",
        header[0]
    );
    md.push_str(&format!("\n| Number | {} |\n|---|", header.join(" | ")));
    md.push_str(&"---|".repeat(runs.len()));
    let mut rows = Vec::new();
    for name in names {
        let base = find(runs[0], name);
        let cells: Vec<String> = runs
            .iter()
            .enumerate()
            .map(|(index, report)| cell(find(report, name), base.filter(|_| index > 0)))
            .collect();
        md.push_str(&format!("\n| {name} | {} |", cells.join(" | ")));
        rows.push(json!({
            "name": name,
            "baseline": base,
            "candidates": runs[1..].iter().map(|report| find(report, name)).collect::<Vec<_>>(),
        }));
    }
    (md, Value::Array(rows))
}
