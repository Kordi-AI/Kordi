//! Runner client failures, and reading response bodies without letting
//! their content reach a log.

use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum RunnerClientError {
    #[error("cloud runner client request failed: {0}")]
    Request(String),
    /// A failure while the runner held `run_id`.
    #[error("cloud run {run_id} step failed")]
    Run {
        run_id: String,
        #[source]
        source: Box<RunnerClientError>,
    },
}

impl RunnerClientError {
    /// Ties this failure to the run it happened in.
    pub fn for_run(self, run_id: &str) -> Self {
        match self {
            Self::Run { .. } => self,
            other => Self::Run {
                run_id: run_id.to_string(),
                source: Box::new(other),
            },
        }
    }

    /// The run this failure happened in, when known.
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Run { run_id, .. } => Some(run_id),
            Self::Request(_) => None,
        }
    }

    /// This failure and every cause under it, for logs.
    pub fn chain(&self) -> String {
        let mut text = self.to_string();
        let mut source = std::error::Error::source(self);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        text
    }
}

/// A response body the runner could not read, described without its
/// content: serde quotes the offending string value, which can be prompt or
/// reply text, so quoted parts are left out.
fn parse_failure(path: &str, error: &serde_json::Error) -> RunnerClientError {
    let mut message = String::new();
    let mut quoted = false;
    for part in error.to_string().split('"') {
        if !quoted {
            message.push_str(part);
        } else {
            message.push_str("<redacted>");
        }
        quoted = !quoted;
    }
    RunnerClientError::Request(format!("{path} response could not be read: {message}"))
}

/// Reads a successful response body.
pub(super) fn parse_response<T: for<'de> Deserialize<'de>>(
    path: &str,
    text: &str,
) -> Result<T, RunnerClientError> {
    serde_json::from_str(text).map_err(|err| {
        let failure = parse_failure(path, &err);
        // A lease the runner cannot read still leased its run: name the run
        // so the failure can be traced to it.
        let run_id = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|value| value.pointer("/run/runId")?.as_str().map(str::to_string));
        match run_id {
            Some(run_id) => failure.for_run(&run_id),
            None => failure,
        }
    })
}
