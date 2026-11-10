//! `POST /v1/cloud/auth/me/device-profile`: the Mac or iPhone reports the
//! time zone and city it observed. Each field is written only while its mode
//! is `automatic`, in the same statement, so a value the owner set by hand on
//! another device is never overwritten. Devices send city names, never
//! coordinates.

use super::fields::{clean_location, clean_time_zone, FieldError};
use super::*;

/// One observed value, validated; blank or absent is `None`.
fn observed(
    value: Option<&str>,
    clean: fn(&str) -> Result<String, FieldError>,
) -> Result<Option<String>, FieldError> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(trimmed) => clean(trimmed).map(Some),
    }
}

pub(in crate::auth::routes) async fn update_device_profile(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<DeviceProfileRequest>,
) -> Response {
    let (time_zone, location) = match (
        observed(req.time_zone.as_deref(), clean_time_zone),
        observed(req.location.as_deref(), clean_location),
    ) {
        (Ok(time_zone), Ok(location)) => (time_zone, location),
        (Err(error), _) | (_, Err(error)) => {
            return err(error.code, error.message, StatusCode::BAD_REQUEST)
        }
    };
    let pool = state.db_pool();
    let failed = || {
        err(
            "server_error",
            "Could not update profile.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    };
    let Ok(mut tx) = pool.begin().await else {
        return failed();
    };
    let updated: Option<OwnerAccountRecordRow> = match query_as(&format!(
        "UPDATE cloud_accounts SET \
            time_zone = CASE WHEN time_zone_mode = 'automatic' THEN COALESCE($2, time_zone) \
                ELSE time_zone END, \
            location = CASE WHEN location_mode = 'automatic' THEN COALESCE($3, location) \
                ELSE location END, \
            updated_at = $4 \
         WHERE account_id = $1 AND ( \
            (time_zone_mode = 'automatic' AND $2::TEXT IS NOT NULL AND time_zone IS DISTINCT FROM $2) \
            OR (location_mode = 'automatic' AND $3::TEXT IS NOT NULL AND location IS DISTINCT FROM $3)) \
         RETURNING {OWNER_ACCOUNT_RECORD_COLUMNS}",
    ))
    .bind(&session.account_id)
    .bind(time_zone.as_deref())
    .bind(location.as_deref())
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(_) => return failed(),
    };
    let default_agent = match default_agent_profile_row(pool, &session.account_id).await {
        Ok(row) => row,
        Err(_) => return failed(),
    };
    let Some(row) = updated else {
        // Nothing to write: the fields are manual or already current.
        drop(tx);
        return match owner_account_response_row(pool, &session.account_id).await {
            Ok(Some(account)) => Json(account).into_response(),
            Ok(None) => err(
                "account_missing",
                "Account no longer exists.",
                StatusCode::NOT_FOUND,
            ),
            Err(_) => failed(),
        };
    };
    let account = owner_account_response_from_rows(row, default_agent);
    if let Err(response) =
        sync::publish_profile_change(&state, tx, &session.account_id, &account).await
    {
        return *response;
    }
    Json(account).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_values_are_validated_and_blank_is_ignored() {
        assert_eq!(observed(None, clean_time_zone), Ok(None));
        assert_eq!(observed(Some("  "), clean_location), Ok(None));
        assert_eq!(
            observed(Some(" Asia/Riyadh "), clean_time_zone),
            Ok(Some("Asia/Riyadh".into()))
        );
        assert_eq!(
            observed(Some("Palo Alto, CA"), clean_location),
            Ok(Some("Palo Alto, CA".into()))
        );
        assert_eq!(
            observed(Some("Mars/Olympus"), clean_time_zone).map_err(|error| error.code),
            Err("invalid_time_zone")
        );
        assert_eq!(
            observed(Some("Line one\nLine two"), clean_location).map_err(|error| error.code),
            Err("invalid_location")
        );
    }
}
