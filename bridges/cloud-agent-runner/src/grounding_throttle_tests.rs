use super::*;

#[tokio::test(start_paused = true)]
async fn a_rate_limit_halves_the_limit_once_per_burst_and_never_below_two() {
    let controller = Controller::new(16);
    assert_eq!(controller.limit(), 16);
    controller.rate_limited();
    assert_eq!(controller.limit(), 8);
    // The rest of the same burst does not cut again.
    controller.rate_limited();
    controller.rate_limited();
    assert_eq!(controller.limit(), 8);
    for expected in [4, 2, 2] {
        tokio::time::advance(CUT_COOLDOWN).await;
        controller.rate_limited();
        assert_eq!(controller.limit(), expected);
    }
}

#[tokio::test(start_paused = true)]
async fn successes_grow_the_limit_back_to_the_concurrency() {
    let controller = Controller::new(4);
    controller.rate_limited();
    assert_eq!(controller.limit(), 2);
    for _ in 0..GROW_AFTER - 1 {
        controller.succeeded();
    }
    assert_eq!(controller.limit(), 2, "not yet");
    controller.succeeded();
    assert_eq!(controller.limit(), 3);
    // A rate limit in between starts the count again.
    controller.succeeded();
    tokio::time::advance(CUT_COOLDOWN).await;
    controller.rate_limited();
    assert_eq!(controller.limit(), 2);
    for _ in 0..GROW_AFTER * 10 {
        controller.succeeded();
    }
    assert_eq!(controller.limit(), 4, "never above the concurrency");
}

#[tokio::test(start_paused = true)]
async fn calls_wait_for_a_slot_and_the_runner_stops_claiming_meanwhile() {
    let controller = std::sync::Arc::new(Controller::new(4));
    controller.rate_limited();
    let first = controller.try_acquire().unwrap();
    let second = controller.try_acquire().unwrap();
    assert!(controller.try_acquire().is_none());
    assert!(controller.is_full());

    let waiter = {
        let controller = controller.clone();
        tokio::spawn(async move {
            let permit = controller.acquire().await;
            drop(permit);
        })
    };
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished(), "waits while both slots are taken");
    drop(first);
    waiter.await.unwrap();
    assert_eq!(controller.in_flight(), 1);
    drop(second);
    assert_eq!(controller.in_flight(), 0);
    assert!(!controller.is_full());
}

#[tokio::test(start_paused = true)]
async fn a_raised_limit_wakes_a_waiting_call() {
    let controller = std::sync::Arc::new(Controller::new(3));
    controller.rate_limited();
    let held: Vec<_> = (0..2).map(|_| controller.try_acquire().unwrap()).collect();
    let waiter = {
        let controller = controller.clone();
        tokio::spawn(async move { drop(controller.acquire().await) })
    };
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    for _ in 0..GROW_AFTER {
        controller.succeeded();
    }
    waiter.await.unwrap();
    drop(held);
}

#[test]
fn provider_errors_are_classified_without_their_text() {
    let paid = "provider error: unexpected status 402 Payment Required: A positive credit balance is required, url: https://gateway.example/v1/chat/completions";
    assert_eq!(failure_kind(paid), "provider_http_402");
    assert!(!is_rate_limit_text(paid));
    let limited = "provider error: unexpected status 429 Too Many Requests: slow down, url: https://gateway.example/v1/chat/completions";
    assert_eq!(failure_kind(limited), "provider_http_429");
    assert!(is_rate_limit_text(limited));
    assert!(is_rate_limit_text("Rate limit reached for gpt-5-mini"));
    assert_eq!(
        failure_kind("provider error: provider request timed out, url: https://gateway.example"),
        "timeout"
    );
    assert_eq!(
        failure_kind("the model finished without a reply"),
        "empty_reply"
    );
    assert_eq!(failure_kind("something odd"), "other");
    // A request id or token count is not a status.
    assert!(!is_rate_limit_text(
        "request req_4290 failed after 1429 tokens"
    ));
}

#[tokio::test(start_paused = true)]
async fn a_provider_retry_for_a_rate_limit_lowers_the_limit_at_once() {
    let controller = Controller::new(16);
    let retry = |message: &str| kordi_provider::ProviderRetryEvent::Start {
        attempt: 1,
        max_attempts: 4,
        delay_ms: 30_000,
        error_message: message.into(),
    };
    report_retry(
        &controller,
        &retry("unexpected status 503 Service Unavailable: busy"),
    );
    assert_eq!(controller.limit(), 16, "only rate limits count");
    report_retry(
        &controller,
        &retry("unexpected status 429 Too Many Requests: slow down"),
    );
    assert_eq!(controller.limit(), 8);
}
