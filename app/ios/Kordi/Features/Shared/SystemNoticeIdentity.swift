import SwiftUI

/// Server notices, such as a group's introduction and "joined" lines or the
/// plan card in a direct chat. They carry this message kind and come from the
/// hidden System account, the plan agent, or a member (a plan card stays the
/// organizer's). Platform notices show as System. Facilitator and personal
/// agents have their own author labels for messages and cards.
enum KordiSystemIdentity {
    static let messageKind = "system-notice"
    static let displayName = "System"
    static let seed = "kordi_system"
    static let accountId = "acct_kordi_system"

    static let avatar = ConversationAvatarIdentity(name: displayName, source: nil, seed: seed)

    static func isSystemNotice(_ message: ChatMessage) -> Bool {
        isSystemNotice(kind: message.messageKind)
    }

    static func isSystemNotice(kind: String?) -> Bool {
        let kind = kind?.trimmingCharacters(in: .whitespacesAndNewlines)
        return kind == messageKind || kind == ChatMessage.groupEventNoticeMessageKind
    }

    /// The local kind for a server message: a System notice that carries a
    /// `group_event` becomes a timeline line; every other kind is unchanged.
    static func timelineMessageKind(kind: String, hasGroupEvent: Bool) -> String {
        guard hasGroupEvent, kind.trimmingCharacters(in: .whitespacesAndNewlines) == messageKind else { return kind }
        return ChatMessage.groupEventNoticeMessageKind
    }

    static func matches(seed: String?) -> Bool {
        seed?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.seed
    }

    static func isSystem(accountId: String?) -> Bool {
        accountId?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.accountId
    }

    /// The System agent and the System account are server-managed: never listed, counted,
    /// pictured, or synchronized as members.
    static func isServiceAccount(_ accountId: String?) -> Bool {
        KordiSystemAgentIdentity.isSystemAgent(accountId: accountId) || isSystem(accountId: accountId)
    }

    /// A notice is never the viewer's own bubble, even when the viewer's
    /// account sent it.
    static func author(messageKind: String?, fromAccountId: String, ownAccountId: String) -> MessageAuthor {
        if isSystemNotice(kind: messageKind) || isSystem(accountId: fromAccountId) { return .person }
        return fromAccountId == ownAccountId ? .me : .person
    }

    /// The name on a direct-chat message from someone other than the viewer.
    static func directAuthorName(messageKind: String?, fromAccountId: String, fallback: String) -> String {
        isSystemNotice(kind: messageKind) || isServiceAccount(fromAccountId) ? displayName : fallback
    }

    /// The name on a group message that has no envelope: "System" for a
    /// notice or a server-managed account, then the member's name or the
    /// conversation's name.
    static func groupAuthorName(
        messageKind: String?,
        fromAccountId: String,
        participantNames: [String: String],
        fallback: String
    ) -> String {
        if isSystemNotice(kind: messageKind) || isServiceAccount(fromAccountId) { return displayName }
        return participantNames[fromAccountId] ?? fallback
    }

    /// A card a person's agent opened travels as a notice from the agent's
    /// owner, but shows as that agent's message, like its other replies.
    /// Nil for every other message, System agent and Meet cards included.
    static func planCardAgent(_ message: CloudMessageDTO, ownAccountId: String) -> PlanCardAgentSender? {
        guard isSystemNotice(kind: message.messageKind), let planner = message.planCard?.plannedBy,
              planner.ownerAccountId == message.fromAccountId else { return nil }
        let ownerName = planner.ownerName?.nonEmpty
        let isDefaultAgent = CanonicalAvatarSystem.agentID(planner.agentId, ownerAccountID: planner.ownerAccountId)
            == "cloud-agent:\(planner.ownerAccountId)"
        return PlanCardAgentSender(
            authorName: isDefaultAgent
                ? CloudDefaultAgentProfile.displayName(planner.agentName, ownerName: ownerName) : planner.agentName,
            ownerName: planner.ownerAccountId == ownAccountId ? "You" : ownerName
        )
    }
}

/// The agent shown as the sender of a plan card it opened.
struct PlanCardAgentSender: Equatable {
    /// An agent's card is an ordinary message, never a System notice.
    static let messageKind = "text"
    let authorName: String
    /// "You" when the viewer owns the agent.
    let ownerName: String?
}

/// The front-facing Kordi bird, shared with the desktop System avatar.
struct KordiSystemAvatar: View {
    var body: some View {
        Image("KordiSystemAvatar")
            .resizable()
            .scaledToFit()
    }
}
