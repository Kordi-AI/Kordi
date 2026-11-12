//! Fixed-label send diagnostics, owned by one server state's session metrics.
//!
//! Handler and store totals contain their sub-stages; do not sum them.
//! Lock/authorization/allocation timings include SQL execution and round trips,
//! not just lock waits. Completed timings include returned errors. Abandoned
//! futures are counted separately, so cancellations cannot look like successes.
//! No request values, SQL, identifiers, or message contents are recorded.
use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

use serde_json::{json, Value};

use super::Histogram;

#[derive(Clone, Copy)]
pub(crate) enum SendStage {
    Handler,
    Store,
    PoolWait,
    Begin,
    OperationLock,
    GroupNormalization,
    GroupProjectionLock,
    WriterAuthorization,
    SequenceAllocation,
    Fanout,
    Commit,
    Projection,
    Notifications,
    ReplyMatching,
    MentionRouting,
}

const NAMES: [&str; 15] = [
    "handler",
    "store",
    "pool_wait",
    "begin",
    "operation_lock",
    "group_normalization",
    "group_projection_lock",
    "writer_authorization",
    "sequence_allocation",
    "fanout",
    "commit",
    "projection",
    "notifications",
    "reply_matching",
    "mention_routing",
];

#[derive(Default)]
pub(crate) struct SendTimings {
    completed: [Histogram; 15],
    abandoned: [AtomicU64; 15],
}

impl SendTimings {
    pub(super) fn snapshot(&self) -> Value {
        Value::Object(
            NAMES
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    let mut value = self.completed[index].snapshot();
                    value["abandoned"] = json!(self.abandoned[index].load(Ordering::Relaxed));
                    ((*name).to_owned(), value)
                })
                .collect(),
        )
    }
}

struct Observation<'a> {
    metrics: &'a SendTimings,
    stage: usize,
    started: Instant,
    completed: bool,
}

impl Drop for Observation<'_> {
    fn drop(&mut self) {
        if self.completed {
            self.metrics.completed[self.stage].observe(self.started.elapsed());
        } else {
            self.metrics.abandoned[self.stage].fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(crate) async fn measure<F: Future>(
    metrics: Option<&SendTimings>,
    stage: SendStage,
    future: F,
) -> F::Output {
    let mut observation = metrics.map(|metrics| Observation {
        metrics,
        stage: stage as usize,
        started: Instant::now(),
        completed: false,
    });
    let result = future.await;
    if let Some(observation) = observation.as_mut() {
        observation.completed = true;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returned_errors_and_abandoned_futures_are_distinct_and_replica_local() {
        let first = SendTimings::default();
        let second = SendTimings::default();
        let result = measure(Some(&first), SendStage::Store, async {
            Err::<(), _>("synthetic")
        })
        .await;
        assert!(result.is_err());
        let mut pending = Box::pin(measure(
            Some(&first),
            SendStage::Store,
            std::future::pending::<()>(),
        ));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        drop(pending);
        let snapshot = first.snapshot();
        assert_eq!(snapshot["store"]["count"], 1);
        assert_eq!(snapshot["store"]["abandoned"], 1);
        assert_eq!(second.snapshot()["store"]["count"], 0);
        assert_eq!(snapshot.as_object().unwrap().len(), NAMES.len());
        assert!(!snapshot.to_string().contains("synthetic"));
    }
}
