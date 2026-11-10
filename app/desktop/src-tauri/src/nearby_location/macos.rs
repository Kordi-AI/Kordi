use std::cell::{Cell, RefCell};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_location::{
    CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol};
use tokio::sync::oneshot;

use super::{
    failure, failure_for_error_code, next_step, Access, LocationFix, Precision, Step, CITY, NEARBY,
};

/// `None` when the request only asked for permission.
type Reply = Result<Option<LocationFix>, &'static str>;

/// What one request does.
#[derive(Clone, Copy)]
pub(crate) struct Options {
    /// Read a fix once access is granted; otherwise only ask for access.
    fetch: bool,
    /// Show the macOS prompt when access was never asked for.
    prompt: bool,
    precision: Precision,
    /// Logs Core Location errors and skipped fixes (never coordinates) under
    /// this tag, so a failed request can be diagnosed from the app log.
    log: Option<&'static str>,
    /// How long to wait for access: the person's answer to the prompt, or
    /// Core Location's settled status for a request that may not ask.
    permission_wait: Duration,
}

impl Options {
    pub(crate) fn permission() -> Self {
        Self {
            fetch: false,
            prompt: true,
            precision: NEARBY,
            log: None,
            permission_wait: PERMISSION_WAIT,
        }
    }

    pub(crate) fn nearby() -> Self {
        Self {
            fetch: true,
            prompt: true,
            precision: NEARBY,
            log: None,
            permission_wait: PERMISSION_WAIT,
        }
    }

    /// Only reads the settled status: never asks and never reads a fix.
    fn probe() -> Self {
        Self {
            fetch: false,
            prompt: false,
            precision: NEARBY,
            log: None,
            permission_wait: SETTLE_WAIT,
        }
    }

    /// A fix for the profile's city. With `prompt`, asks for access first
    /// when it was never asked for and waits for the answer.
    pub(crate) fn city(prompt: bool, log: &'static str) -> Self {
        Self {
            fetch: true,
            prompt,
            precision: CITY,
            log: Some(log),
            permission_wait: if prompt {
                PERMISSION_WAIT
            } else {
                SETTLE_WAIT * 4
            },
        }
    }
}
static REQUEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Time for the person to answer the macOS permission prompt.
const PERMISSION_WAIT: Duration = Duration::from_secs(120);
/// Time for a fix once access is granted.
const FIX_WAIT: Duration = Duration::from_secs(30);
/// A new manager's `authorizationStatus` is not settled until Core Location
/// calls `locationManagerDidChangeAuthorization:`; after this long without
/// that call, the status read directly is used.
const SETTLE_WAIT: Duration = Duration::from_secs(2);

struct LocationIvars {
    reply: RefCell<Option<oneshot::Sender<Reply>>>,
    /// Signalled once access is granted; dropped when the request ends early.
    granted: RefCell<Option<oneshot::Sender<()>>>,
    options: Options,
    asked: Cell<bool>,
    started: Cell<bool>,
    /// Core Location reported the settled status, or `SETTLE_WAIT` passed.
    settled: Cell<bool>,
    /// A status probe: receives the settled status and does nothing else.
    probe: RefCell<Option<oneshot::Sender<CLAuthorizationStatus>>>,
    /// Best fresh but coarse fix, returned if nothing better arrives in time.
    best: RefCell<Option<LocationFix>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = LocationIvars]
    struct NearbyLocationDelegate;

    unsafe impl NSObjectProtocol for NearbyLocationDelegate {}

    unsafe impl CLLocationManagerDelegate for NearbyLocationDelegate {
        #[unsafe(method(locationManagerDidChangeAuthorization:))]
        fn authorization_changed(&self, manager: &CLLocationManager) {
            self.ivars().settled.set(true);
            self.authorized(manager);
        }

        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn received(&self, manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
            for location in locations.iter() {
                // Access is confined to the main run loop that owns the manager.
                let (fix, age) = unsafe {
                    let coordinate = location.coordinate();
                    let timestamp = location.timestamp();
                    (
                        LocationFix {
                            latitude: coordinate.latitude,
                            longitude: coordinate.longitude,
                            accuracy: location.horizontalAccuracy(),
                            timestamp: timestamp.timeIntervalSince1970() * 1000.0,
                        },
                        -timestamp.timeIntervalSinceNow(),
                    )
                };
                let precision = self.ivars().options.precision;
                if precision.usable(fix.accuracy, age) {
                    self.finish(manager, Ok(Some(fix)));
                    return;
                }
                if let Some(tag) = self.ivars().options.log {
                    eprintln!(
                        "[{tag}] fix skipped: accuracy {:.0} m, age {age:.0} s",
                        fix.accuracy
                    );
                }
                if precision.fallback(fix.accuracy, age) {
                    let mut best = self.ivars().best.borrow_mut();
                    if best
                        .as_ref()
                        .is_none_or(|best| fix.accuracy < best.accuracy)
                    {
                        *best = Some(fix);
                    }
                }
            }
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn failed(&self, manager: &CLLocationManager, error: &NSError) {
            if let Some(tag) = self.ivars().options.log {
                eprintln!(
                    "[{tag}] core location error {} {}",
                    error.domain(),
                    error.code()
                );
            }
            if let Some(code) = failure_for_error_code(error.code()) {
                self.finish(manager, Err(code));
            }
        }
    }
);

impl NearbyLocationDelegate {
    fn authorized(&self, manager: &CLLocationManager) {
        let status = unsafe { manager.authorizationStatus() };
        let settled = self.ivars().settled.get();
        if let Some(tag) = self.ivars().options.log {
            eprintln!(
                "[{tag}] authorization status {} (settled: {settled})",
                status.0
            );
        }
        let access = match status {
            CLAuthorizationStatus::NotDetermined => Access::NotDetermined,
            CLAuthorizationStatus::AuthorizedAlways
            | CLAuthorizationStatus::AuthorizedWhenInUse => Access::Granted,
            CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => Access::Blocked,
            _ => Access::Unknown,
        };
        let probing = self.ivars().probe.borrow().is_some();
        let options = self.ivars().options;
        match next_step(access, settled, probing, options.prompt, options.fetch) {
            Step::Wait => {}
            Step::Report => {
                if let Some(probe) = self.ivars().probe.borrow_mut().take() {
                    let _ = probe.send(status);
                }
            }
            Step::Ask => {
                if !self.ivars().asked.replace(true) {
                    // Shows the macOS prompt; the answer arrives through this delegate.
                    unsafe { manager.requestWhenInUseAuthorization() };
                }
            }
            Step::Fail(code) => self.finish(manager, Err(code)),
            Step::Granted { fetch } => {
                if let Some(granted) = self.ivars().granted.borrow_mut().take() {
                    let _ = granted.send(());
                }
                if !fetch {
                    self.finish(manager, Ok(None));
                } else if !self.ivars().started.replace(true) {
                    unsafe { manager.startUpdatingLocation() };
                }
            }
        }
    }

    /// Uses the status read directly when Core Location never reported one.
    fn settle(&self, manager: &CLLocationManager) {
        if !self.ivars().settled.replace(true) {
            self.authorized(manager);
        }
    }

    fn finish(&self, manager: &CLLocationManager, reply: Reply) {
        unsafe { manager.stopUpdatingLocation() };
        self.ivars().granted.borrow_mut().take();
        if let Some(sender) = self.ivars().reply.borrow_mut().take() {
            let _ = sender.send(reply);
        }
    }
}

struct ActiveRequest {
    manager: Retained<CLLocationManager>,
    // CLLocationManager's delegate is weak; keep it alive through completion or timeout.
    delegate: Retained<NearbyLocationDelegate>,
}

thread_local! {
    static ACTIVE: RefCell<Option<ActiveRequest>> = const { RefCell::new(None) };
}

/// macOS only shows the location prompt to a process with a bundle identity.
fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Asks for access when needed, then, with `fetch`, reads one foreground fix.
pub(crate) async fn request(app: tauri::AppHandle, options: Options) -> Reply {
    let _guard = REQUEST.try_lock().map_err(|_| failure::BUSY)?;
    let (sender, receiver) = oneshot::channel();
    let (granted, granted_receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = sender.send(Err(failure::UNAVAILABLE));
            return;
        };
        if !bundled() {
            let _ = sender.send(Err(failure::NOT_BUNDLED));
            return;
        }
        // Core Location and its delegate stay on the application's main run loop.
        unsafe {
            let delegate = NearbyLocationDelegate::alloc(mtm).set_ivars(LocationIvars {
                reply: RefCell::new(Some(sender)),
                granted: RefCell::new(Some(granted)),
                options,
                asked: Cell::new(false),
                started: Cell::new(false),
                settled: Cell::new(false),
                probe: RefCell::new(None),
                best: RefCell::new(None),
            });
            let delegate: Retained<NearbyLocationDelegate> = msg_send![super(delegate), init];
            let manager = CLLocationManager::new();
            manager.setDesiredAccuracy(options.precision.desired);
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            if !CLLocationManager::locationServicesEnabled_class() {
                delegate.finish(&manager, Err(failure::SERVICES_OFF));
            } else {
                delegate.authorized(&manager);
            }
            ACTIVE.with(|active| *active.borrow_mut() = Some(ActiveRequest { manager, delegate }));
        }
    })
    .map_err(|_| failure::UNAVAILABLE)?;
    settle_later(&app, || {
        ACTIVE.with(|active| {
            if let Some(request) = active.borrow().as_ref() {
                request.delegate.settle(&request.manager);
            }
        })
    });
    // The grant sender is dropped when the request ends before access is granted.
    let result = match tokio::time::timeout(options.permission_wait, granted_receiver).await {
        Err(_) => Err(failure::PERMISSION_PENDING),
        Ok(_) => match tokio::time::timeout(FIX_WAIT, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(failure::UNAVAILABLE),
            Err(_) => Err(failure::TIMEOUT),
        },
    };
    let (stopped, done) = oneshot::channel();
    app.run_on_main_thread(move || {
        let best = ACTIVE.with(|active| {
            active.borrow_mut().take().and_then(|request| {
                unsafe {
                    request.manager.stopUpdatingLocation();
                    request.manager.setDelegate(None);
                }
                request.delegate.ivars().best.borrow_mut().take()
            })
        });
        let _ = stopped.send(best);
    })
    .map_err(|_| failure::UNAVAILABLE)?;
    let best = done.await.ok().flatten();
    match result {
        // A coarse fix lets the caller explain the accuracy instead of a timeout.
        Err(failure::TIMEOUT) if best.is_some() => Ok(best),
        result => result,
    }
}

/// After `SETTLE_WAIT`, runs `settle` on the main thread.
fn settle_later(app: &tauri::AppHandle, settle: impl FnOnce() + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE_WAIT).await;
        let _ = app.run_on_main_thread(settle);
    });
}

thread_local! {
    /// Status probes waiting for Core Location, kept alive until they answer.
    static PROBES: RefCell<Vec<(u64, ActiveRequest)>> = const { RefCell::new(Vec::new()) };
}
static NEXT_PROBE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// This app's location access as Core Location settles it: a new manager is
/// asked, and the answer is its `locationManagerDidChangeAuthorization:` call.
pub(crate) async fn permission(app: tauri::AppHandle) -> Result<String, String> {
    const FAILED: &str = "Could not read location permission.";
    let id = NEXT_PROBE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel::<Result<CLAuthorizationStatus, &'static str>>();
    let (status_sender, status_receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = sender.send(Err("unavailable"));
            return;
        };
        if !bundled() {
            let _ = sender.send(Err("unavailable"));
            return;
        }
        unsafe {
            if !CLLocationManager::locationServicesEnabled_class() {
                let _ = sender.send(Err("denied"));
                return;
            }
            let (reply, _) = oneshot::channel();
            let (granted, _) = oneshot::channel();
            let delegate = NearbyLocationDelegate::alloc(mtm).set_ivars(LocationIvars {
                reply: RefCell::new(Some(reply)),
                granted: RefCell::new(Some(granted)),
                options: Options::probe(),
                asked: Cell::new(false),
                started: Cell::new(false),
                settled: Cell::new(false),
                probe: RefCell::new(Some(status_sender)),
                best: RefCell::new(None),
            });
            let delegate: Retained<NearbyLocationDelegate> = msg_send![super(delegate), init];
            let manager = CLLocationManager::new();
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            delegate.authorized(&manager);
            PROBES.with(|probes| {
                probes
                    .borrow_mut()
                    .push((id, ActiveRequest { manager, delegate }))
            });
        }
    })
    .map_err(|_| FAILED)?;
    settle_later(&app, move || {
        PROBES.with(|probes| {
            if let Some((_, probe)) = probes.borrow().iter().find(|(probe, _)| *probe == id) {
                probe.delegate.settle(&probe.manager);
            }
        })
    });
    let status = tokio::select! {
        // The early sender is dropped unused on the normal path; a closed
        // channel is not an answer, so this branch only ends on a real error.
        Ok(early) = receiver => early,
        status = tokio::time::timeout(SETTLE_WAIT * 2, status_receiver) => match status {
            Ok(Ok(status)) => Ok(status),
            _ => Err("unknown"),
        },
    };
    let _ = app.run_on_main_thread(move || {
        PROBES.with(|probes| {
            let mut probes = probes.borrow_mut();
            if let Some(index) = probes.iter().position(|(probe, _)| *probe == id) {
                let (_, probe) = probes.remove(index);
                unsafe { probe.manager.setDelegate(None) };
            }
        })
    });
    Ok(match status {
        Err(label) => label,
        Ok(CLAuthorizationStatus::NotDetermined) => "not_determined",
        Ok(CLAuthorizationStatus::Denied) => "denied",
        Ok(CLAuthorizationStatus::Restricted) => "restricted",
        Ok(
            CLAuthorizationStatus::AuthorizedAlways | CLAuthorizationStatus::AuthorizedWhenInUse,
        ) => "granted",
        Ok(_) => "unknown",
    }
    .to_string())
}
