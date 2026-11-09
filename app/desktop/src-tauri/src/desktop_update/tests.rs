use std::path::Path;

use super::{
    classify_install_location, is_supported_os_version, rfc3339, DateParts,
    DesktopUpdateDownloadEvent, InstallLocation,
};

fn location(bundle: &str) -> InstallLocation {
    classify_install_location(Some(Path::new(bundle)), Some(Path::new("/Users/alice")))
}

#[test]
fn applications_folders_can_update_in_place() {
    assert_eq!(
        location("/Applications/Kordi.app"),
        InstallLocation::Applications
    );
    assert_eq!(
        location("/Applications/Utilities/Kordi.app"),
        InstallLocation::Applications
    );
    assert_eq!(
        location("/Users/alice/Applications/Kordi.app"),
        InstallLocation::Applications
    );
}

#[test]
fn other_locations_cannot_update_in_place() {
    assert_eq!(
        classify_install_location(None, Some(Path::new("/Users/alice"))),
        InstallLocation::Elsewhere
    );
    for bundle in [
        "/Volumes/Kordi/Kordi.app",
        "/Users/alice/Downloads/Kordi.app",
        "/private/var/folders/xx/T/AppTranslocation/UUID/d/Kordi.app",
        "/Applications/AppTranslocation/Kordi.app",
        "/ApplicationsFoo/Kordi.app",
        "/Users/alice/ApplicationsFoo/Kordi.app",
        "/Users/example/Applications/Kordi.app",
        "/Applications/../Users/alice/Downloads/Kordi.app",
        "/Applications",
        "Applications/Kordi.app",
    ] {
        assert_eq!(location(bundle), InstallLocation::Elsewhere, "{bundle}");
    }
    assert_eq!(
        classify_install_location(Some(Path::new("/Users/alice/Applications/Kordi.app")), None),
        InstallLocation::Elsewhere
    );
}

#[test]
fn install_location_serializes_as_lowercase_strings() {
    assert_eq!(
        serde_json::to_string(&InstallLocation::Applications).unwrap(),
        "\"applications\""
    );
    assert_eq!(
        serde_json::to_string(&InstallLocation::Elsewhere).unwrap(),
        "\"elsewhere\""
    );
}

#[test]
fn download_events_match_the_plugin_shape() {
    let json = |event| serde_json::to_value(event).unwrap();
    assert_eq!(
        json(DesktopUpdateDownloadEvent::Started {
            content_length: Some(123)
        }),
        serde_json::json!({ "event": "Started", "data": { "contentLength": 123 } })
    );
    assert_eq!(
        json(DesktopUpdateDownloadEvent::Started {
            content_length: None
        }),
        serde_json::json!({ "event": "Started", "data": {} })
    );
    assert_eq!(
        json(DesktopUpdateDownloadEvent::Progress { chunk_length: 456 }),
        serde_json::json!({ "event": "Progress", "data": { "chunkLength": 456 } })
    );
    assert_eq!(
        json(DesktopUpdateDownloadEvent::Finished),
        serde_json::json!({ "event": "Finished" })
    );
}

#[test]
fn os_version_matches_the_frontend_rule() {
    for version in ["15.4", "15.4.1", "26.0", "10.0.0", "65535.65535.65535"] {
        assert!(is_supported_os_version(version), "{version}");
    }
    for version in [
        "", "15", "0.1", "015.4", "15.04", "15.4.01", "10.4.1.2", "15..4", "15.4.", " 15.4",
        "15.4 ", "15.a", "65536.0", "15.65536", "+15.4",
    ] {
        assert!(!is_supported_os_version(version), "{version}");
    }
}

#[test]
fn release_dates_format_as_rfc3339() {
    let parts = |nanosecond, offset| DateParts {
        year: 2026,
        month: 11,
        day: 8,
        hour: 9,
        minute: 5,
        second: 7,
        nanosecond,
        offset,
    };
    assert_eq!(
        rfc3339(parts(0, (0, 0, 0))).as_deref(),
        Some("2026-11-08T09:05:07Z")
    );
    assert_eq!(
        rfc3339(parts(120_000_000, (5, 30, 0))).as_deref(),
        Some("2026-11-08T09:05:07.12+05:30")
    );
    assert_eq!(
        rfc3339(parts(0, (-3, -30, 0))).as_deref(),
        Some("2026-11-08T09:05:07-03:30")
    );
    assert_eq!(rfc3339(parts(0, (0, 0, 30))), None);
}
