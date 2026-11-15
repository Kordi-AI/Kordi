//! `GET gallery/:item_id/content`: the bytes of an item you see. The
//! gallery check stands in for the attachment owner check; the bytes are
//! served by the attachment `/content` code path. A Kordi document whose
//! current text is stored (`cloud_document_contents`) serves that text, as
//! the document routes read it. The answer tells a browser never to
//! render the bytes as a page: they are another person's file, and API
//! routes also accept the web session cookie.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Extension,
};
use sqlx_core::query_as::query_as;

use super::{item_not_found, member_room, visible_item};
use crate::attachments::content::{stream_readable_object, StoredObject};
use crate::common_ground::db_error;
use crate::{auth::routes::CloudSession, server::ServerState};

type ObjectRow = (
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

pub(in crate::common_ground) async fn content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, item_id)): Path<(String, String)>,
    request_headers: HeaderMap,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    let item = match visible_item(pool, &room, viewer, &item_id).await {
        Ok(item) => item,
        Err(response) => return *response,
    };
    let row: Result<Option<ObjectRow>, _> = query_as(
        "SELECT attachment.object_key, attachment.content_type,
                attachment.detected_content_type, attachment.size_bytes, contents.source
         FROM cloud_attachments attachment
         LEFT JOIN cloud_document_contents contents
           ON contents.attachment_id = attachment.attachment_id
         WHERE attachment.attachment_id = $1 AND attachment.finalized_at IS NOT NULL",
    )
    .bind(&item.attachment_id)
    .fetch_optional(pool)
    .await;
    match row {
        Ok(Some((_, _, _, _, Some(source)))) => {
            let mut response = source.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/markdown; charset=utf-8"),
            );
            never_render(response)
        }
        Ok(Some((object_key, content_type, detected_content_type, size_bytes, None))) => {
            let object = StoredObject {
                object_key: &object_key,
                content_type: content_type.as_deref(),
                detected_content_type: detected_content_type.as_deref(),
                size_bytes,
            };
            never_render(stream_readable_object(&state, &object, &request_headers).await)
        }
        Ok(None) => item_not_found(),
        Err(error) => db_error(error),
    }
}

/// Adds the headers that stop a browser from running the file as a page in
/// the app's origin; status, body and content type stay as they are.
pub(in crate::common_ground) fn never_render(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    response
}
