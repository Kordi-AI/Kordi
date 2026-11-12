//! An explicit per-method exemption from blanket post-mutation eviction.
//!
//! Only wrap handlers whose successful work leaves session lookup facts
//! unchanged, including synchronous follow-up work. Authorization, account,
//! device and organization mutations must keep the default eviction. Add the
//! exemption before combining other methods; new methods default to eviction.
//! Database signals and cache liveness/expiry checks always remain active.

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::MethodRouter;

#[derive(Clone)]
struct SessionUnchanged;

pub(crate) fn preserve_session<S>(method: MethodRouter<S>) -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    method.route_layer(middleware::from_fn(mark_success))
}

async fn mark_success(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if response.status().is_success() {
        // Internal response metadata, never a header supplied by a client.
        response.extensions_mut().insert(SessionUnchanged);
    }
    response
}

pub(crate) fn take_preserved_session(response: &mut Response) -> bool {
    response
        .extensions_mut()
        .remove::<SessionUnchanged>()
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::post, Router};
    use tower::ServiceExt;

    #[tokio::test]
    async fn only_successful_reviewed_methods_preserve_the_session() {
        let app = Router::new()
            .route(
                "/reviewed",
                preserve_session(post(|| async { StatusCode::OK }))
                    .delete(|| async { StatusCode::OK }),
            )
            .route(
                "/failed",
                preserve_session(post(|| async { StatusCode::FORBIDDEN })),
            )
            .route("/unreviewed", post(|| async { StatusCode::OK }));
        for (path, method, expected) in [
            ("/reviewed", "POST", true),
            ("/reviewed", "DELETE", false),
            ("/reviewed", "PUT", false),
            ("/failed", "POST", false),
            ("/unreviewed", "POST", false),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap();
            let mut response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                take_preserved_session(&mut response),
                expected,
                "{method} {path}"
            );
            assert!(
                !take_preserved_session(&mut response),
                "metadata is consumed once"
            );
        }
    }
}
