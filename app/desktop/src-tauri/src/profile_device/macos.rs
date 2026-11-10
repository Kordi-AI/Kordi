// `CLGeocoder` and `CLPlacemark` are deprecated in favor of MapKit on
// macOS 26, but they are the reverse geocoding available back to the app's
// macOS 13 minimum.
#![allow(deprecated)]

use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::{msg_send, AnyThread};
use objc2_core_location::{kCLLocationAccuracyReduced, CLGeocoder, CLLocation, CLPlacemark};
use objc2_foundation::{NSArray, NSError, NSLocale, NSString};
use tokio::sync::oneshot;

use super::{city_label, same_city, Placemark};
use crate::nearby_location::{failure, macos as location, Precision};

/// Reverse geocoding normally answers within a second or two.
const GEOCODE_WAIT: Duration = Duration::from_secs(15);

/// The last fix and its city, kept in memory only so a Mac that has not moved
/// does not ask the geocoder again.
static LAST: Mutex<Option<((f64, f64), String)>> = Mutex::new(None);

/// Approximate location is enough for a city.
fn precision() -> Precision {
    Precision {
        desired: unsafe { kCLLocationAccuracyReduced },
        max_accuracy: 25_000.0,
        max_age_seconds: 1800.0,
    }
}

pub(super) async fn city(app: tauri::AppHandle) -> Result<String, &'static str> {
    match location::permission(app.clone())
        .await
        .map_err(|_| failure::UNAVAILABLE)?
        .as_str()
    {
        "granted" => {}
        "not_determined" => return Err(failure::NOT_DETERMINED),
        "denied" | "restricted" => return Err(failure::DENIED),
        _ => return Err(failure::UNAVAILABLE),
    }
    let fix = location::request(app.clone(), location::Options::silent(precision()))
        .await?
        .ok_or(failure::UNAVAILABLE)?;
    let point = (fix.latitude(), fix.longitude());
    if let Some((last, city)) = LAST.lock().ok().and_then(|last| last.clone()) {
        if same_city(last, point) {
            return Ok(city);
        }
    }
    let place = reverse_geocode(&app, point).await?;
    let city = city_label(&place).ok_or(failure::UNAVAILABLE)?;
    if let Ok(mut last) = LAST.lock() {
        *last = Some((point, city.clone()));
    }
    Ok(city)
}

fn text(value: Option<Retained<NSString>>) -> Option<String> {
    value.map(|value| value.to_string())
}

/// Reads the parts a city label needs; the coordinates are not kept.
fn placemark(place: &CLPlacemark) -> Placemark {
    unsafe {
        Placemark {
            locality: text(place.locality()),
            sub_administrative_area: text(place.subAdministrativeArea()),
            administrative_area: text(place.administrativeArea()),
            country: text(place.country()),
            iso_country_code: text(place.ISOcountryCode()),
        }
    }
}

/// One reverse geocoding request in English, so every device writes the
/// same label.
async fn reverse_geocode(
    app: &tauri::AppHandle,
    (latitude, longitude): (f64, f64),
) -> Result<Placemark, &'static str> {
    let (sender, receiver) = oneshot::channel::<Result<Placemark, &'static str>>();
    app.run_on_main_thread(move || {
        let sender = Mutex::new(Some(sender));
        let geocoder = unsafe { CLGeocoder::new() };
        // The geocoder must live until it answers; the block owns a reference.
        let keep = geocoder.clone();
        let callback = block2::RcBlock::new(
            move |places: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                let _ = &keep;
                let first = unsafe { places.as_ref() }.and_then(|places| places.firstObject());
                let result = match first {
                    Some(place) if error.is_null() => Ok(placemark(&place)),
                    _ => Err(failure::UNAVAILABLE),
                };
                if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = sender.send(result);
                }
            },
        );
        unsafe {
            let location =
                CLLocation::initWithLatitude_longitude(CLLocation::alloc(), latitude, longitude);
            let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str("en_US"));
            // Sent directly so the crate's block support, and a new lockfile
            // edge, is not needed; the signature matches the Core Location header.
            let _: () = msg_send![
                &*geocoder,
                reverseGeocodeLocation: &*location,
                preferredLocale: &*locale,
                completionHandler: &*callback
            ];
        }
    })
    .map_err(|_| failure::UNAVAILABLE)?;
    match tokio::time::timeout(GEOCODE_WAIT, receiver).await {
        Ok(Ok(result)) => result,
        _ => Err(failure::TIMEOUT),
    }
}
