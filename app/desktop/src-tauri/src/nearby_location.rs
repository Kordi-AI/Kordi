//! One foreground location fix, requested by the Nearby screen or by the
//! profile's automatic city. Never logs coordinates.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationFix {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    timestamp: f64,
}

impl LocationFix {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn latitude(&self) -> f64 {
        self.latitude
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn longitude(&self) -> f64 {
        self.longitude
    }
}

/// Stable failure codes; the web view maps them to copy.
pub(crate) mod failure {
    /// Location access was denied or is restricted for this app.
    pub const DENIED: &str = "location_denied";
    /// Location Services are turned off for the whole Mac.
    pub const SERVICES_OFF: &str = "location_services_off";
    /// The process has no bundle identity, so macOS cannot ask for permission.
    pub const NOT_BUNDLED: &str = "location_not_bundled";
    /// The permission prompt was not answered in time.
    pub const PERMISSION_PENDING: &str = "location_permission_pending";
    /// No usable fix arrived in time.
    pub const TIMEOUT: &str = "location_timeout";
    /// Core Location reported an error other than denial.
    pub const UNAVAILABLE: &str = "location_unavailable";
    /// Another request is still running.
    pub const BUSY: &str = "location_busy";
    /// Access was never asked for, and this request may not ask.
    pub const NOT_DETERMINED: &str = "location_not_determined";
}

/// How precise and how fresh a fix must be for one purpose.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Precision {
    /// Passed to Core Location as the desired accuracy, in meters.
    pub(crate) desired: f64,
    /// Coarser fixes are not returned right away.
    pub(crate) max_accuracy: f64,
    /// Core Location may first replay a cached fix; older ones are skipped.
    pub(crate) max_age_seconds: f64,
}

/// Nearby: fixes coarser than 2 km are not published; matches the web-side check.
pub(crate) const NEARBY: Precision = Precision {
    desired: 100.0,
    max_accuracy: 2000.0,
    max_age_seconds: 300.0,
};

impl Precision {
    /// Whether a reported fix can be returned right away.
    pub(crate) fn usable(&self, accuracy: f64, age_seconds: f64) -> bool {
        accuracy.is_finite()
            && (0.0..=self.max_accuracy).contains(&accuracy)
            && age_seconds.is_finite()
            && age_seconds <= self.max_age_seconds
    }
}

/// What a Core Location error means for a pending request. `None` keeps waiting.
pub(crate) fn failure_for_error_code(code: isize) -> Option<&'static str> {
    // kCLErrorLocationUnknown: Core Location keeps trying; the error is transient.
    const LOCATION_UNKNOWN: isize = 0;
    // kCLErrorDenied
    const DENIED: isize = 1;
    match code {
        LOCATION_UNKNOWN => None,
        DENIED => Some(failure::DENIED),
        _ => Some(failure::UNAVAILABLE),
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod macos;

#[tauri::command]
pub async fn desktop_nearby_location(app: tauri::AppHandle) -> Result<LocationFix, String> {
    #[cfg(target_os = "macos")]
    {
        match macos::request(app, macos::Options::nearby()).await {
            Ok(Some(fix)) => Ok(fix),
            Ok(None) => Err(failure::UNAVAILABLE.into()),
            Err(code) => Err(code.into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(failure::UNAVAILABLE.into())
    }
}

/// Permission setup does not publish a location or enable Nearby.
#[tauri::command]
pub async fn desktop_nearby_location_permission(
    app: tauri::AppHandle,
    request: bool,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let status = macos::permission(app.clone()).await?;
        if request && status == "not_determined" {
            // Only asks for access; no location is read here.
            let result = macos::request(app.clone(), macos::Options::permission()).await;
            let status = macos::permission(app).await?;
            if status == "not_determined" {
                result.map_err(String::from)?;
            }
            Ok(status)
        } else {
            Ok(status)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok("unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_fix_requires_fresh_and_precise_readings() {
        let usable_fix = |accuracy, age| NEARBY.usable(accuracy, age);
        assert!(usable_fix(65.0, 1.0));
        assert!(usable_fix(2000.0, 300.0));
        assert!(
            !usable_fix(-1.0, 1.0),
            "negative accuracy marks an invalid fix"
        );
        assert!(!usable_fix(2000.5, 1.0));
        assert!(!usable_fix(50.0, 301.0), "cached fixes are skipped");
        assert!(!usable_fix(f64::NAN, 1.0));
    }

    #[test]
    fn core_location_errors_map_to_stable_codes() {
        assert_eq!(failure_for_error_code(0), None);
        assert_eq!(failure_for_error_code(1), Some(failure::DENIED));
        assert_eq!(failure_for_error_code(2), Some(failure::UNAVAILABLE));
    }
}
