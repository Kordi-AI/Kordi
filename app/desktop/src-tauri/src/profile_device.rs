//! What this Mac reports for the profile's automatic Location and Time zone
//! (#2439): the system time zone and a city-level place name. Coordinates stay
//! in this process; only the place name leaves it.
use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;

/// The parts of a reverse-geocoded place that a city label uses.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Placemark {
    pub(crate) locality: Option<String>,
    pub(crate) sub_administrative_area: Option<String>,
    pub(crate) administrative_area: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) iso_country_code: Option<String>,
}

/// Matches the server's Location limit.
const MAX_CITY_CHARS: usize = 80;
/// A fix closer than this to the last one reuses its city.
const SAME_CITY_KM: f64 = 5.0;

fn clean(value: &Option<String>) -> Option<String> {
    let text = value
        .as_deref()?
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// "Palo Alto, CA" in the United States, "Thuwal, Saudi Arabia" elsewhere:
/// the town, then the state code or the country. Never more precise.
pub(crate) fn city_label(place: &Placemark) -> Option<String> {
    let us = clean(&place.iso_country_code).is_some_and(|code| code.eq_ignore_ascii_case("US"));
    let town = clean(&place.locality)
        .or_else(|| clean(&place.sub_administrative_area))
        .or_else(|| clean(&place.administrative_area));
    let region = if us {
        clean(&place.administrative_area).or_else(|| clean(&place.country))
    } else {
        clean(&place.country)
    };
    let label = match (town, region) {
        (Some(town), Some(region)) if town != region => format!("{town}, {region}"),
        (Some(town), _) => town,
        (None, Some(region)) => region,
        (None, None) => return None,
    };
    Some(
        label
            .chars()
            .take(MAX_CITY_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string(),
    )
}

/// Great-circle distance in kilometers.
pub(crate) fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (lat1, lon1) = (a.0.to_radians(), a.1.to_radians());
    let (lat2, lon2) = (b.0.to_radians(), b.1.to_radians());
    let h = ((lat2 - lat1) / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * ((lon2 - lon1) / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Whether a new fix is close enough to reuse the last city.
pub(crate) fn same_city(last: (f64, f64), next: (f64, f64)) -> bool {
    distance_km(last, next) < SAME_CITY_KM
}

/// The system time zone, such as "America/Los_Angeles".
#[tauri::command]
pub fn desktop_time_zone() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        crate::cloud_session::macos_time_zone()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The city this Mac is in, without asking for access. Fails with the
/// location failure codes when access is missing or no fix arrives.
#[tauri::command]
pub async fn desktop_profile_city(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::city(app).await.map_err(String::from)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(crate::nearby_location::failure::UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(locality: &str, admin: &str, country: &str, code: &str) -> Placemark {
        let some = |value: &str| (!value.is_empty()).then(|| value.to_string());
        Placemark {
            locality: some(locality),
            sub_administrative_area: None,
            administrative_area: some(admin),
            country: some(country),
            iso_country_code: some(code),
        }
    }

    #[test]
    fn united_states_cities_use_the_state_code() {
        assert_eq!(
            city_label(&place("Palo Alto", "CA", "United States", "US")).as_deref(),
            Some("Palo Alto, CA")
        );
    }

    #[test]
    fn other_cities_use_the_country() {
        assert_eq!(
            city_label(&place("Thuwal", "Makkah Province", "Saudi Arabia", "SA")).as_deref(),
            Some("Thuwal, Saudi Arabia")
        );
        assert_eq!(
            city_label(&place("Lisbon", "Lisbon", "Portugal", "PT")).as_deref(),
            Some("Lisbon, Portugal")
        );
    }

    #[test]
    fn city_states_and_missing_parts_stay_short() {
        assert_eq!(
            city_label(&place("Singapore", "", "Singapore", "SG")).as_deref(),
            Some("Singapore")
        );
        let county = Placemark {
            sub_administrative_area: Some("Santa Clara County".into()),
            ..place("", "CA", "United States", "US")
        };
        assert_eq!(
            city_label(&county).as_deref(),
            Some("Santa Clara County, CA")
        );
        assert_eq!(
            city_label(&place("", "", "Iceland", "IS")).as_deref(),
            Some("Iceland")
        );
        assert_eq!(city_label(&Placemark::default()), None);
    }

    #[test]
    fn labels_are_one_line_within_the_server_limit() {
        let label = city_label(&place("New\nTown\t", "", "Somewhere", "XX")).unwrap();
        assert_eq!(label, "New Town, Somewhere");
        let long = city_label(&place(&"a".repeat(100), "", "Portugal", "PT")).unwrap();
        assert_eq!(long.chars().count(), MAX_CITY_CHARS);
    }

    #[test]
    fn nearby_fixes_reuse_the_last_city() {
        let palo_alto = (37.4419, -122.1430);
        assert!(same_city(palo_alto, (37.4500, -122.1500)));
        assert!(
            !same_city(palo_alto, (37.7749, -122.4194)),
            "San Francisco is another city"
        );
        let distance = distance_km(palo_alto, (22.3046, 39.1047));
        assert!((13_000.0..14_000.0).contains(&distance), "{distance}");
    }
}
