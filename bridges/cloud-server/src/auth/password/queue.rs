//! A process-wide limit on password hashes running at once.
//!
//! A production argon2 hash allocates 64 MiB, so a wave of sign-ins after an
//! outage could otherwise exhaust the process's memory. Every hash and every
//! verification takes a slot first. Requests beyond the limit wait in line
//! (the semaphore serves them in arrival order) without holding a thread, and
//! one that has waited [`PASSWORD_HASH_MAX_WAIT`] gives up so its caller can
//! answer "try again". The hash itself runs on the blocking thread pool,
//! which keeps the slot until the hash finishes even if the request is gone.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Semaphore;

use super::{hash_password, verify_password, PasswordHasherConfig};

/// Overrides how many password hashes may run at once.
pub const PASSWORD_HASH_CONCURRENCY_ENV: &str = "KORDI_PASSWORD_HASH_CONCURRENCY";
/// Hashes that may run at once unless the environment overrides it.
pub const DEFAULT_PASSWORD_HASH_CONCURRENCY: usize = 4;
/// The largest override accepted; larger values fall back to the default.
const MAX_PASSWORD_HASH_CONCURRENCY: usize = 64;
/// How long a request waits for a slot before it is refused.
pub const PASSWORD_HASH_MAX_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum PasswordWorkError {
    /// Every slot stayed busy for the whole wait; the client should retry.
    Busy,
    /// Hashing failed or the stored hash could not be read.
    Failed,
}

/// Runs password work at most `concurrency` at a time.
pub struct PasswordHashQueue {
    slots: Arc<Semaphore>,
    max_wait: Duration,
}

impl PasswordHashQueue {
    pub fn new(concurrency: usize, max_wait: Duration) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(concurrency.max(1))),
            max_wait,
        }
    }

    /// The queue every request in this process shares, sized from
    /// [`PASSWORD_HASH_CONCURRENCY_ENV`] when it is first used.
    pub fn global() -> &'static Self {
        static QUEUE: OnceLock<PasswordHashQueue> = OnceLock::new();
        QUEUE.get_or_init(|| {
            let concurrency =
                concurrency_from(std::env::var(PASSWORD_HASH_CONCURRENCY_ENV).ok().as_deref());
            Self::new(concurrency, PASSWORD_HASH_MAX_WAIT)
        })
    }

    /// Waits for a slot, then runs `work` on the blocking pool.
    pub async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, PasswordWorkError> {
        let slot = tokio::time::timeout(self.max_wait, self.slots.clone().acquire_owned())
            .await
            .map_err(|_| PasswordWorkError::Busy)?
            .map_err(|_| PasswordWorkError::Failed)?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            work()
        })
        .await
        .map_err(|_| PasswordWorkError::Failed)
    }
}

/// Hashes a new password through the shared queue.
pub async fn hash_password_queued(
    plaintext: String,
    config: PasswordHasherConfig,
) -> Result<String, PasswordWorkError> {
    PasswordHashQueue::global()
        .run(move || hash_password(&plaintext, config))
        .await?
        .map_err(|_| PasswordWorkError::Failed)
}

/// Verifies a password against a stored hash through the shared queue.
pub async fn verify_password_queued(
    stored_hash: String,
    plaintext: String,
) -> Result<bool, PasswordWorkError> {
    PasswordHashQueue::global()
        .run(move || verify_password(&stored_hash, &plaintext))
        .await?
        .map_err(|_| PasswordWorkError::Failed)
}

fn concurrency_from(value: Option<&str>) -> usize {
    value
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| (1..=MAX_PASSWORD_HASH_CONCURRENCY).contains(value))
        .unwrap_or(DEFAULT_PASSWORD_HASH_CONCURRENCY)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Work that records how many copies run at once and holds its slot
    /// until `release` lets it finish.
    fn tracked_work(
        running: &Arc<AtomicUsize>,
        peak: &Arc<AtomicUsize>,
        release: &Arc<std::sync::Barrier>,
    ) -> impl FnOnce() + Send + 'static {
        let (running, peak, release) = (running.clone(), peak.clone(), release.clone());
        move || {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            release.wait();
            running.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn no_more_than_the_limit_hash_at_once_and_the_rest_wait_their_turn() {
        let queue = Arc::new(PasswordHashQueue::new(2, Duration::from_secs(30)));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        // Two at a time pass the barrier together, so the cap is exercised.
        let release = Arc::new(std::sync::Barrier::new(2));
        let tasks = (0..8)
            .map(|_| {
                let queue = queue.clone();
                let work = tracked_work(&running, &peak, &release);
                tokio::spawn(async move { queue.run(work).await })
            })
            .collect::<Vec<_>>();
        for task in tasks {
            assert_eq!(
                task.await.unwrap(),
                Ok(()),
                "waiting requests are queued, not refused"
            );
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    /// Work that blocks its slot until the returned sender is used or dropped.
    fn blocking_work() -> (std::sync::mpsc::Sender<()>, impl FnOnce() + Send + 'static) {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        (release, move || {
            let _ = wait.recv();
        })
    }

    #[tokio::test]
    async fn a_request_that_waits_too_long_is_refused_as_busy() {
        let queue = Arc::new(PasswordHashQueue::new(1, Duration::from_millis(100)));
        let (release, work) = blocking_work();
        let blocker = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.run(work).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(queue.run(|| ()).await, Err(PasswordWorkError::Busy));
        drop(release);
        assert_eq!(blocker.await.unwrap(), Ok(()));
        assert_eq!(
            queue.run(|| 7).await,
            Ok(7),
            "the slot frees once work ends"
        );
    }

    #[tokio::test]
    async fn a_dropped_request_keeps_its_slot_until_the_hash_finishes() {
        let queue = Arc::new(PasswordHashQueue::new(1, Duration::from_millis(100)));
        let (release, work) = blocking_work();
        let started = Arc::new(tokio::sync::Notify::new());
        let request = {
            let (queue, started) = (queue.clone(), started.clone());
            tokio::spawn(async move {
                queue
                    .run(move || {
                        started.notify_one();
                        work();
                    })
                    .await
            })
        };
        started.notified().await;
        request.abort();
        assert_eq!(
            queue.run(|| ()).await,
            Err(PasswordWorkError::Busy),
            "the hash still runs after its request is cancelled"
        );
        drop(release);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), queue.run(|| 7))
                .await
                .expect("the slot frees once the abandoned hash ends"),
            Ok(7)
        );
    }

    #[tokio::test]
    async fn queued_hashing_and_verification_round_trip() {
        let config = PasswordHasherConfig::for_tests();
        let hash = hash_password_queued("Correct-horse-7".into(), config)
            .await
            .unwrap();
        assert_eq!(
            verify_password_queued(hash.clone(), "Correct-horse-7".into()).await,
            Ok(true)
        );
        assert_eq!(
            verify_password_queued(hash, "Wrong-horse-7".into()).await,
            Ok(false)
        );
        assert_eq!(
            verify_password_queued("not-a-hash".into(), "anything".into()).await,
            Err(PasswordWorkError::Failed)
        );
    }

    #[test]
    fn the_limit_defaults_to_four_and_reads_sane_overrides() {
        assert_eq!(concurrency_from(None), DEFAULT_PASSWORD_HASH_CONCURRENCY);
        assert_eq!(DEFAULT_PASSWORD_HASH_CONCURRENCY, 4);
        assert_eq!(concurrency_from(Some(" 2 ")), 2);
        for invalid in ["0", "-1", "lots", "65", ""] {
            assert_eq!(
                concurrency_from(Some(invalid)),
                DEFAULT_PASSWORD_HASH_CONCURRENCY,
                "{invalid:?}"
            );
        }
    }
}
