// `CLGeocoder` and `CLPlacemark` are deprecated in favor of MapKit on
// macOS 26, but they are the reverse geocoding available back to the app's
// macOS 13 minimum.
#![allow(deprecated)]

use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::{msg_send, AnyThread};
use objc2_core_location::{CLGeocoder, CLLocation, CLPlacemark};
use objc2_foundation::{NSArray, NSError, NSLocale, NSString};
use tokio::sync::oneshot;

use super::{city_label, same_city, Placemark};
use crate::nearby_location::{failure, macos as location, CITY};

/// Reverse geocoding normally answers within a second or two.
const GEOCODE_WAIT: Duration = Duration::from_secs(15);
/// The geocoder failed or answered with no place.
const GEOCODE_FAILED: &str = "location_geocode_failed";
/// The place had no town, region or country to name.
const NO_PLACE: &str = "location_no_place";

/// The last fix and its city, kept in memory only so a Mac that has not moved
/// does not ask the geocoder again.
static LAST: Mutex<Option<((f64, f64), String)>> = Mutex::new(None);

/// Logs one failure with its detail (never coordinates) and returns its code,
/// which the profile shows as a short line.
fn fail(code: &'static str, detail: impl std::fmt::Display) -> &'static str {
    eprintln!("[profile-location] {code}: {detail}");
    code
}

pub(super) async fn city(app: tauri::AppHandle) -> Result<String, &'static str> {
    let status = location::permission(app.clone())
        .await
        .map_err(|error| fail(failure::UNAVAILABLE, error))?;
    match status.as_str() {
        "granted" => {}
        "not_determined" => {
            return Err(fail(failure::NOT_DETERMINED, "access was never asked for"))
        }
        "denied" | "restricted" => return Err(fail(failure::DENIED, &status)),
        _ => return Err(fail(failure::UNAVAILABLE, format!("permission {status}"))),
    }
    let fix = location::request(
        app.clone(),
        location::Options::silent(CITY, "profile-location"),
    )
    .await
    .map_err(|code| fail(code, "location request failed"))?
    .ok_or_else(|| fail(failure::UNAVAILABLE, "location request returned no fix"))?;
    let point = (fix.latitude(), fix.longitude());
    if let Some((last, city)) = LAST.lock().ok().and_then(|last| last.clone()) {
        if same_city(last, point) {
            return Ok(city);
        }
    }
    let place = reverse_geocode(&app, point)
        .await
        .map_err(|(code, detail)| fail(code, detail))?;
    let city = city_label(&place).ok_or_else(|| {
        fail(
            NO_PLACE,
            format!("no label for country {:?}", place.iso_country_code),
        )
    })?;
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
) -> Result<Placemark, (&'static str, String)> {
    let (sender, receiver) = oneshot::channel::<Result<Placemark, (&'static str, String)>>();
    app.run_on_main_thread(move || {
        let sender = Mutex::new(Some(sender));
        let geocoder = unsafe { CLGeocoder::new() };
        // The geocoder must live until it answers; the block owns a reference.
        let keep = geocoder.clone();
        let callback = block2::RcBlock::new(
            move |places: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                let _ = &keep;
                let first = unsafe { places.as_ref() }.and_then(|places| places.firstObject());
                let result = match (first, unsafe { error.as_ref() }) {
                    (_, Some(error)) => Err((
                        GEOCODE_FAILED,
                        format!("geocoder error {} {}", error.domain(), error.code()),
                    )),
                    (Some(place), None) => Ok(placemark(&place)),
                    (None, None) => Err((GEOCODE_FAILED, "geocoder returned no place".into())),
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
    .map_err(|_| (failure::UNAVAILABLE, "main thread unavailable".to_string()))?;
    match tokio::time::timeout(GEOCODE_WAIT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err((GEOCODE_FAILED, "geocoder dropped its answer".into())),
        Err(_) => Err((failure::TIMEOUT, "geocoder did not answer".into())),
    }
}
