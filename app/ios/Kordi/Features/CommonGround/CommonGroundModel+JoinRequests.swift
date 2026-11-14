import Foundation

/// Asking to join a group started from a room, and answering such requests.
/// Every call reloads the room and its results afterwards, so the rows show
/// the server's state even when the call failed because something changed.
extension CommonGroundModel {
    static func joinRequestBusyKey(groupSpaceId: String) -> String { "join-request:\(groupSpaceId)" }
    static func decideBusyKey(requestId: String) -> String { "decide:\(requestId)" }

    func askToJoin(code: String, groupSpaceId: String) async {
        _ = await run(Self.joinRequestBusyKey(groupSpaceId: groupSpaceId)) {
            try await $0.askToJoinCommonGroundGroup(token: $1, code: code, groupSpaceId: groupSpaceId)
        }
        await reloadAfterJoinRequest(code)
    }

    func cancelJoinRequest(code: String, groupSpaceId: String, requestId: String) async {
        _ = await run(Self.joinRequestBusyKey(groupSpaceId: groupSpaceId)) {
            try await $0.cancelCommonGroundJoinRequest(token: $1, code: code, requestId: requestId)
        }
        await reloadAfterJoinRequest(code)
    }

    func decideJoinRequest(code: String, requestId: String, approve: Bool) async {
        _ = await run(Self.decideBusyKey(requestId: requestId)) {
            try await $0.groupJoinRequest(token: $1, requestId: requestId, action: approve ? "approve" : "decline")
        }
        await reloadAfterJoinRequest(code)
    }

    private func reloadAfterJoinRequest(_ code: String) async {
        guard await refreshRoom(code) else { return }
        await loadResults(code, quiet: true)
    }
}
