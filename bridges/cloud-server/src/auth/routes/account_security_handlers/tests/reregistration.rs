//! Signing up again with the email of a deleted account gives a new, empty
//! account (docs/development/account-deletion.md).

use super::*;
use crate::account_deletion::reregistration_fixture::{assert_fresh, give_history};

/// Signs up `email` through the emailed code, as the apps do. Returns the
/// new account id and its session token.
async fn sign_up(harness: &Harness, email: &str, password: &str) -> (String, String) {
    let (status, challenge) = harness
        .send(
            "POST",
            "/v1/cloud/auth/signup/code",
            Auth::None,
            Some(json!({ "email": email })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let code = harness
        .sent_codes()
        .into_iter()
        .rev()
        .find(|(to, _)| to == email)
        .map(|(_, code)| code)
        .expect("a code was sent");
    let (status, body) = harness
        .send(
            "POST",
            "/v1/cloud/auth/signup",
            Auth::None,
            Some(json!({
                "email": email,
                "password": password,
                "verificationId": challenge["verificationId"],
                "verificationCode": code,
                "avatarSeed": "synthetic-seed",
            })),
        )
        .await;
    assert!(status.is_success(), "{status}: {body}");
    (
        body["account"]["accountId"].as_str().unwrap().to_string(),
        body["session"]["token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn signing_up_again_with_a_deleted_accounts_email_starts_a_new_empty_account() {
    let harness = harness().await;
    let email = unique_email("again");
    let password = strong_password();
    let (old_id, old_token) = sign_up(&harness, &email, &password).await;
    let peer = give_history(&harness.pool, &old_id).await;

    let (status, body) = harness
        .post(
            "/delete",
            Auth::Bearer(&old_token),
            json!({ "currentPassword": password }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // No `email_in_use`, and the pending code of the old sign-up is gone, so
    // a new code is sent at once.
    let (new_id, new_token) = sign_up(&harness, &email, &strong_password()).await;
    assert_fresh(&harness.pool, &new_id, &old_id, &peer).await;
    assert_eq!(harness.me_status(&new_token).await, StatusCode::OK);
    let (status, body) = harness
        .send("GET", "/v1/cloud/auth/me", Auth::Bearer(&old_token), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "account_deleted");
}
