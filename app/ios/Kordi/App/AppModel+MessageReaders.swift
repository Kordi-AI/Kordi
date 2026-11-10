import Foundation

/// Who read the viewer's own group message, loaded on demand for the message
/// menu's Seen by row and its full list (#2455).
extension AppModel {
    func messageReaders(_ target: MessageSeenByTarget, limit: Int) async throws -> CloudMessageReadersResponse {
        if isPreviewMode { return MessageSeenByPresentation.previewResponse(for: target, limit: limit) }
        let (api, token, _) = try projectContext()
        return try await api.messageReaders(
            token: token,
            sessionId: target.sessionId,
            messageId: target.messageId,
            limit: limit
        )
    }
}
