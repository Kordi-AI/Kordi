import Foundation

struct CloudSyncResponse: Codable, Hashable {
    let cursor: String
    let lastStreamSequence: Int64
    let hasMore: Bool
    let events: [CloudSyncEvent]
    /// The saved cursor could not be used, so this page is a fresh bootstrap.
    /// It holds one message per conversation; open conversations need their
    /// history refilled.
    var isFullReload = false

    enum CodingKeys: String, CodingKey {
        case cursor, lastStreamSequence, hasMore, events
    }

    func markingFullReload() -> CloudSyncResponse {
        var copy = self
        copy.isFullReload = true
        return copy
    }
}

/// What the sync loop carries from one pass to the next.
struct CloudSyncLoopState {
    var nextCursor: String
    var hasUnpersistedChanges: Bool
    var refillsOpenHistory = false
    var pendingEvents: [CloudSyncEvent] = []
    var passesUntilContactRefresh = 0
    var passesUntilPresenceRefresh = 0
}

/// How the server says a sync cursor can no longer be used. Every other
/// failure, including a reconnect or a `resync_required` frame, resumes from
/// the saved cursor.
enum CloudSyncReloadPolicy {
    /// Both errors carry `bootstrap_required: true`: 409 `SYNC_CURSOR_EXPIRED`
    /// for a cursor older than retained events, ahead of the stream, or not
    /// valid for the account, and 500 `CHAT_SYNC_INVARIANT_VIOLATION` for a gap
    /// in the durable stream.
    static let bootstrapRequiredCodes: Set<String> = ["SYNC_CURSOR_EXPIRED", "CHAT_SYNC_INVARIANT_VIOLATION"]

    static func requiresFullReload(_ error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        return bootstrapRequiredCodes.contains(error.code)
    }
}
