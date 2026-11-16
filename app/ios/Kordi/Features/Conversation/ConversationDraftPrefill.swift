import Foundation

/// Text another screen leaves for a chat's composer, such as "About …" from a
/// Grounding gallery item. The chat takes it once when it appears with an
/// empty draft; nothing is sent until the person sends it.
@MainActor
enum ConversationDraftPrefill {
    private static var drafts: [String: String] = [:]

    static func set(_ text: String, for conversationId: String) {
        drafts[conversationId] = text
    }

    /// The text left for this chat, removed as it is read.
    static func take(for conversationId: String) -> String? {
        drafts.removeValue(forKey: conversationId)
    }
}
