import Foundation

/// The server-managed stand-in for every deleted person, and the direct
/// conversations other people keep after an operator deletes an account
/// (docs/development/account-deletion.md#kept-direct-conversations-on-clients).
///
/// A kept conversation is read-only. Its session id still names the deleted
/// account, and that id stays the chat's peer here, so the chat keeps its id
/// and session id and local copies stay attached. The stand-in only ever
/// appears as a member who left, never as a contact.
enum KordiDeletedAccount {
    static let accountId = "acct_kordi_deleted"
    static let displayName = String(
        localized: "Deleted account",
        comment: "Name of a person whose account was deleted, in their kept chat."
    )
    /// Replaces the composer of a kept chat, and is what a refused write there says.
    static let closedLine = String(
        localized: "This account was deleted.",
        comment: "Shown in place of the message field in a chat with a deleted account, and when a write there is refused."
    )

    private static let directPersonSessionPrefix = "session:direct-person:"

    static func isStandIn(_ accountId: String?) -> Bool {
        accountId?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.accountId
    }

    /// The name the server stores for the stand-in (on its member row, on
    /// scrubbed messages and as a quote's `senderLabel`), or this app's
    /// own wording of it.
    static func isDisplayName(_ name: String?) -> Bool {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return false }
        return [serverDisplayName, displayName].contains {
            name.compare($0, options: [.caseInsensitive]) == .orderedSame
        }
    }

    static let serverDisplayName = "Deleted account"

    /// The deleted account a kept direct conversation was with, named by its
    /// session id, or nil for any other conversation. Everyone keeps a member
    /// row once in a conversation (active, left or removed); only a deleted
    /// account loses it. That already holds in the `membership.updated` that
    /// arrives before the close, so the chat switches as soon as the new member
    /// list does.
    ///
    /// The viewer must still be an active member. A person's own deletion
    /// empties the direct conversation instead: it also drops their row, but
    /// deletes every message and sets the other person's row to `removed`, so
    /// that conversation is never a kept one.
    static func peerAccountId(
        in conversation: CloudChatConversation,
        viewerAccountId: String? = nil
    ) -> String? {
        let viewer = (viewerAccountId ?? conversation.preferences.accountId)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard conversation.kind == "direct", isActiveMember(viewer, of: conversation),
              let sessionId = conversation.legacySessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              sessionId.hasPrefix(directPersonSessionPrefix) else { return nil }
        let accountIds = sessionId.dropFirst(directPersonSessionPrefix.count)
            .split(separator: ":", omittingEmptySubsequences: false)
            .map(String.init)
        guard accountIds.count == 2, accountIds.contains(viewer),
              let peer = accountIds.first(where: { $0 != viewer }), !peer.isEmpty,
              !isStandIn(peer), !KordiSystemIdentity.isServiceAccount(peer),
              !conversation.members.contains(where: { $0.accountId == peer }) else { return nil }
        return peer
    }

    /// Whether the viewer still has a direct conversation that is closed
    /// because the other account was deleted: the server closes a direct
    /// conversation for no other reason, with the stand-in as the closer.
    static func isKeptDirect(_ conversation: CloudChatConversation) -> Bool {
        guard conversation.kind == "direct",
              isActiveMember(conversation.preferences.accountId, of: conversation) else { return false }
        return isStandIn(conversation.closed?.closedByAccountId) || peerAccountId(in: conversation) != nil
    }

    /// A snapshot without the viewer's own active row is no member list to judge by.
    private static func isActiveMember(_ accountId: String, of conversation: CloudChatConversation) -> Bool {
        let accountId = accountId.trimmingCharacters(in: .whitespacesAndNewlines)
        return !accountId.isEmpty && conversation.members.contains {
            $0.accountId == accountId && $0.membershipState == "active"
        }
    }

    /// The kept direct conversations of `viewerAccountId`, by the deleted
    /// account each was with.
    static func keptDirectConversations(
        in conversations: [CloudChatConversation],
        viewerAccountId: String
    ) -> [String: CloudChatConversation] {
        var result: [String: CloudChatConversation] = [:]
        for conversation in conversations {
            let owner = conversation.preferences.accountId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard owner.isEmpty || owner == viewerAccountId,
                  let peer = peerAccountId(in: conversation, viewerAccountId: viewerAccountId) else { continue }
            if let existing = result[peer], parseCloudDate(existing.updatedAt) >= parseCloudDate(conversation.updatedAt) {
                continue
            }
            result[peer] = conversation
        }
        return result
    }

    /// The conversation a chat request names: `/v2/chat/conversations/<id>/…`.
    static func conversationId(inRequestPath path: String) -> String? {
        let prefix = "v2/chat/conversations/"
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard trimmed.hasPrefix(prefix) else { return nil }
        let component = trimmed.dropFirst(prefix.count)
            .split(separator: "/", maxSplits: 1).first
            .flatMap { $0.split(separator: "?", maxSplits: 1).first }
            .map(String.init) ?? ""
        let id = component.removingPercentEncoding ?? component
        return id.isEmpty ? nil : id
    }

    /// The server refuses every write to a kept direct conversation with
    /// `group_closed` and the closed group's wording. Its refusal says the
    /// account was deleted instead; the code stays, so closed handling applies.
    static func refusal(_ error: CloudAPIError, in conversation: CloudChatConversation?) -> CloudAPIError {
        guard error.code == GroupClosedState.errorCode, let conversation, isKeptDirect(conversation) else {
            return error
        }
        return CloudAPIError(
            code: error.code,
            message: closedLine,
            statusCode: error.statusCode,
            reason: error.reason,
            retryAfterSeconds: error.retryAfterSeconds,
            fromServer: error.fromServer
        )
    }
}
