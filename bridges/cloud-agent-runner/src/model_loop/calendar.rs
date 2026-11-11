//! Calendar scope for a cloud run. The server enforces who may read what; the
//! runner only refuses requests it can already tell are out of scope.
use serde_json::Value;

use crate::client::CloudAgentRun;

fn shared_session(session_id: &str) -> bool {
    session_id.starts_with("session:group:") || session_id.starts_with("session:direct-person:")
}

/// Arguments to send for a `read_calendar` call, or why the run may not read.
///
/// The owner's own request may read details in a shared conversation only
/// with `shareInConversation`; otherwise it reads availability. Another
/// member's request (directly or through their agent) reads only the run
/// owner's availability, and only in a shared conversation.
pub(super) fn calendar_arguments(run: &CloudAgentRun, arguments: &Value) -> Result<Value, String> {
    let unavailable = kordi_tools::calendar::CALENDAR_UNAVAILABLE;
    let owner_request = run.owner_account_id == run.requester_account_id;
    if run.subsession_id.is_some() || (!owner_request && !shared_session(&run.session_id)) {
        return Err(format!(
            "Calendar reads require a request to the owner's own Agent. {unavailable}"
        ));
    }
    let details = arguments["shareInConversation"] == true || arguments["disclosure"] == "details";
    if !owner_request && details {
        return Err(format!(
            "Only busy and free times can be shared on another person's request; event details need the owner's own request. {unavailable}"
        ));
    }
    let mut arguments = arguments.clone();
    if shared_session(&run.session_id) && !details && arguments.is_object() {
        arguments["disclosure"] = "availability".into();
    }
    Ok(arguments)
}
