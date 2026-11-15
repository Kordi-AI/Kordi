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
