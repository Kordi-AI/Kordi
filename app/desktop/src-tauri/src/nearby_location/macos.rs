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

use super::{failure, failure_for_error_code, LocationFix, Precision, NEARBY};

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
}

impl Options {
    pub(crate) fn permission() -> Self {
        Self {
            fetch: false,
            prompt: true,
            precision: NEARBY,
            log: None,
        }
    }

    pub(crate) fn nearby() -> Self {
        Self {
            fetch: true,
            prompt: true,
            precision: NEARBY,
            log: None,
        }
    }

    /// A fix without asking for access, for a purpose that already has it.
    pub(crate) fn silent(precision: Precision, log: &'static str) -> Self {
        Self {
            fetch: true,
            prompt: false,
            precision,
            log: Some(log),
        }
    }
}
static REQUEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Time for the person to answer the macOS permission prompt.
const PERMISSION_WAIT: Duration = Duration::from_secs(120);
/// Time for a fix once access is granted.
const FIX_WAIT: Duration = Duration::from_secs(30);

struct LocationIvars {
    reply: RefCell<Option<oneshot::Sender<Reply>>>,
    /// Signalled once access is granted; dropped when the request ends early.
    granted: RefCell<Option<oneshot::Sender<()>>>,
    options: Options,
    asked: Cell<bool>,
    started: Cell<bool>,
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
        if let Some(tag) = self.ivars().options.log {
            eprintln!("[{tag}] authorization status {}", status.0);
        }
        match status {
            CLAuthorizationStatus::NotDetermined if !self.ivars().options.prompt => {
                self.finish(manager, Err(failure::NOT_DETERMINED));
            }
            CLAuthorizationStatus::NotDetermined => {
                if !self.ivars().asked.replace(true) {
                    // Shows the macOS prompt; the answer arrives through this delegate.
                    unsafe { manager.requestWhenInUseAuthorization() };
                }
            }
            CLAuthorizationStatus::AuthorizedAlways
            | CLAuthorizationStatus::AuthorizedWhenInUse => {
                if let Some(granted) = self.ivars().granted.borrow_mut().take() {
                    let _ = granted.send(());
                }
                if !self.ivars().options.fetch {
                    self.finish(manager, Ok(None));
                } else if !self.ivars().started.replace(true) {
                    unsafe { manager.startUpdatingLocation() };
                }
            }
            CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                self.finish(manager, Err(failure::DENIED));
            }
            _ => {}
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
    // The grant sender is dropped when the request ends before access is granted.
    let result = match tokio::time::timeout(PERMISSION_WAIT, granted_receiver).await {
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

pub(crate) async fn permission(app: tauri::AppHandle) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let status = unsafe {
            if !bundled() {
                "unavailable"
            } else if !CLLocationManager::locationServicesEnabled_class() {
                "denied"
            } else {
                match CLLocationManager::new().authorizationStatus() {
                    CLAuthorizationStatus::NotDetermined => "not_determined",
                    CLAuthorizationStatus::Denied => "denied",
                    CLAuthorizationStatus::Restricted => "restricted",
                    CLAuthorizationStatus::AuthorizedAlways
                    | CLAuthorizationStatus::AuthorizedWhenInUse => "granted",
                    _ => "unknown",
                }
            }
        };
        let _ = sender.send(status.to_string());
    })
    .map_err(|_| "Could not read location permission.")?;
    receiver
        .await
        .map_err(|_| "Could not read location permission.".into())
}
