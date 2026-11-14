//! The tool gate for a run of a background session.

use super::gate;
use crate::connectors::models::RunTrigger;
use crate::document_shares::agents::gating::{offered_tools, ToolGate};
use crate::document_shares::agents::{tools, CREATE_DOCUMENT_TOOL};

/// A background session's run: `create_document` when its parent is a group,
/// whoever asked; the parent's documents only for the owner's own request;
/// never an edit.
#[test]
fn a_background_session_creates_in_its_parent_group_and_never_edits() {
    let background = ToolGate {
        comment_run: false,
        trigger: RunTrigger::PersonStarted,
        group_session: true,
        session_has_document: true,
        background_session: true,
        ..gate()
    };
    for trigger in [RunTrigger::PersonStarted, RunTrigger::Background] {
        let offered = offered_tools(&ToolGate {
            trigger,
            ..background
        });
        assert!(
            offered.create && offered.read && !offered.edit,
            "{trigger:?}"
        );
    }
    let member = offered_tools(&ToolGate {
        owner_request: false,
        ..background
    });
    assert!(member.create && !member.read && !member.edit);
    // The same facts without the background session do edit: the owner's
    // own chat run in a session with a document.
    assert!(
        offered_tools(&ToolGate {
            background_session: false,
            ..background
        })
        .edit
    );
    let not_group = offered_tools(&ToolGate {
        group_session: false,
        session_has_document: false,
        ..background
    });
    assert!(!not_group.create && !not_group.read && !not_group.edit);
    let public = offered_tools(&ToolGate {
        public_reader: true,
        ..background
    });
    assert!(!public.create);
    // Its tool says where the document goes: not into a reply.
    let tool = tools::create_descriptor_for(true);
    assert_eq!(tool.name, CREATE_DOCUMENT_TOOL);
    assert!(tool.description.contains("posted in the group"));
    assert!(!tool.description.contains("attached to your reply"));
    assert!(tools::create_descriptor()
        .description
        .contains("attached to your reply"));
}
