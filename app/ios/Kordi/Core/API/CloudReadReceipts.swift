import Foundation

// Read receipts for the viewer's own messages (#2455). The server keeps, per
// author and conversation, the highest sequence of the author's messages that
// another member has read (the read watermark, `read_outbox_sequence` on the
// author's member snapshot) and raises it with a `readOutbox` object on
// `read_cursor.updated`. A server without the watermark sends neither field;
// the app then falls back to the other members' read cursors it knows.

struct CloudChatCursor: Codable, Hashable {
    let conversationId: String
    let accountId: String
    let lastDeliveredSequence: Int64
    let lastReadSequence: Int64

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case accountId = "account_id"
        case lastDeliveredSequence = "last_delivered_sequence"
        case lastReadSequence = "last_read_sequence"
    }
}

/// The author's raised watermark carried by `read_cursor.updated`.
struct CloudChatReadOutbox: Codable, Hashable {
    let conversationId: String?
    let sequence: Int64

    init(conversationId: String?, sequence: Int64) {
        self.conversationId = conversationId
        self.sequence = sequence
    }

    private enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case conversationIdCamel = "conversationId"
        case sequence
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
            ?? container.decodeIfPresent(String.self, forKey: .conversationIdCamel)
        sequence = try container.decode(Int64.self, forKey: .sequence)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(conversationId, forKey: .conversationId)
        try container.encode(sequence, forKey: .sequence)
    }
}

extension CloudChatEventPayload {
    /// Accepts the snake-case key the canonical stream uses and the camel-case
    /// spelling of the contract.
    var readOutbox: CloudChatReadOutbox? { readOutboxSnake ?? readOutboxCamel }
}

extension CloudChatMember {
    private enum ReadOutboxKeys: String, CodingKey {
        case snake = "read_outbox_sequence"
        case camel = "readOutboxSequence"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let receipts = try decoder.container(keyedBy: ReadOutboxKeys.self)
        // Missing, null or malformed reads as no watermark, as on older servers.
        let watermark = ((try? receipts.decodeIfPresent(Int64.self, forKey: .snake)) ?? nil)
            ?? ((try? receipts.decodeIfPresent(Int64.self, forKey: .camel)) ?? nil)
        self.init(
            accountId: try container.decode(String.self, forKey: .accountId),
            displayName: try container.decodeIfPresent(String.self, forKey: .displayName),
            avatarUrl: try container.decodeIfPresent(String.self, forKey: .avatarUrl),
            defaultAgentId: try container.decodeIfPresent(String.self, forKey: .defaultAgentId),
            defaultAgentDisplayName: try container.decodeIfPresent(String.self, forKey: .defaultAgentDisplayName),
            defaultAgentAvatarUrl: try container.decodeIfPresent(String.self, forKey: .defaultAgentAvatarUrl),
            role: try container.decode(String.self, forKey: .role),
            membershipState: try container.decode(String.self, forKey: .membershipState),
            version: try container.decode(Int.self, forKey: .version),
            lastDeliveredSequence: try container.decode(Int64.self, forKey: .lastDeliveredSequence),
            lastReadSequence: try container.decode(Int64.self, forKey: .lastReadSequence),
            joinedAt: try container.decode(String.self, forKey: .joinedAt),
            leftAt: try container.decodeIfPresent(String.self, forKey: .leftAt),
            readOutboxSequence: max(0, watermark ?? 0)
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accountId, forKey: .accountId)
        try container.encode(displayName, forKey: .displayName)
        try container.encode(avatarUrl, forKey: .avatarUrl)
        try container.encode(defaultAgentId, forKey: .defaultAgentId)
        try container.encode(defaultAgentDisplayName, forKey: .defaultAgentDisplayName)
        try container.encode(defaultAgentAvatarUrl, forKey: .defaultAgentAvatarUrl)
        try container.encode(role, forKey: .role)
        try container.encode(membershipState, forKey: .membershipState)
        try container.encode(version, forKey: .version)
        try container.encode(lastDeliveredSequence, forKey: .lastDeliveredSequence)
        try container.encode(lastReadSequence, forKey: .lastReadSequence)
        try container.encode(joinedAt, forKey: .joinedAt)
        try container.encode(leftAt, forKey: .leftAt)
        var receipts = encoder.container(keyedBy: ReadOutboxKeys.self)
        try receipts.encode(readOutboxSequence, forKey: .snake)
    }

    /// Cursors only move forward; the watermark is kept.
    func advanced(by cursor: CloudChatCursor) -> Self {
        guard accountId == cursor.accountId else { return self }
        return Self(
            accountId: accountId, displayName: displayName, avatarUrl: avatarUrl,
            defaultAgentId: defaultAgentId, defaultAgentDisplayName: defaultAgentDisplayName,
            defaultAgentAvatarUrl: defaultAgentAvatarUrl, role: role, membershipState: membershipState,
            version: version,
            lastDeliveredSequence: max(lastDeliveredSequence, cursor.lastDeliveredSequence),
            lastReadSequence: max(lastReadSequence, cursor.lastReadSequence),
            joinedAt: joinedAt, leftAt: leftAt, readOutboxSequence: readOutboxSequence
        )
    }

    /// The watermark never moves back, whatever a delayed snapshot or event says.
    func raisingReadOutbox(to sequence: Int64) -> Self {
        var member = self
        member.readOutboxSequence = max(readOutboxSequence, sequence)
        return member
    }
}

enum CloudReadReceiptRule {
    /// Two ticks on the viewer's message at sequence S when
    /// `S <= max(viewer's watermark, highest read cursor of the other active,
    /// non-service members the app knows)`. The second term keeps ticks right
    /// against a server without the watermark.
    static func readThroughSequence(
        in conversation: CloudChatConversation,
        viewerAccountId: String
    ) -> Int64 {
        let watermark = conversation.members
            .first { $0.accountId == viewerAccountId }?.readOutboxSequence ?? 0
        let otherReaders = conversation.members.lazy
            .filter {
                $0.accountId != viewerAccountId && $0.membershipState == "active"
                    && !KordiSystemIdentity.isServiceAccount($0.accountId)
            }
            .map(\.lastReadSequence)
            .max() ?? 0
        return max(watermark, otherReaders)
    }

    static func isRead(
        sequence: Int64,
        in conversation: CloudChatConversation,
        viewerAccountId: String
    ) -> Bool {
        sequence > 0 && sequence <= readThroughSequence(in: conversation, viewerAccountId: viewerAccountId)
    }
}

extension CloudChatConversation {
    /// Applies a cursor and, for the viewer, a raised watermark from one
    /// `delivery_cursor.updated` or `read_cursor.updated` event.
    func applyingReceipts(
        cursor: CloudChatCursor?,
        readOutbox: CloudChatReadOutbox?,
        viewerAccountId: String
    ) -> Self {
        var updated = self
        if let cursor { updated = updated.withCursor(cursor) }
        if let readOutbox, readOutbox.conversationId.map({ $0 == id }) ?? true {
            updated.members = updated.members.map { member in
                member.accountId == viewerAccountId ? member.raisingReadOutbox(to: readOutbox.sequence) : member
            }
        }
        return updated
    }

    /// A newer snapshot replaces the conversation but never lowers a watermark
    /// this client already applied.
    func keepingReadOutbox(from previous: Self?) -> Self {
        guard let previous, previous.id == id else { return self }
        let previousByAccount = Dictionary(
            previous.members.map { ($0.accountId, $0.readOutboxSequence) },
            uniquingKeysWith: { max($0, $1) }
        )
        var updated = self
        updated.members = members.map { member in
            member.raisingReadOutbox(to: previousByAccount[member.accountId] ?? 0)
        }
        return updated
    }

    func withCursor(_ cursor: CloudChatCursor) -> Self {
        var updated = self
        updated.members = members.map { $0.advanced(by: cursor) }
        return updated
    }
}

/// The messages whose projected state a receipt event changes: those the
/// mover's cursors passed, and the viewer's own messages that the event made
/// read.
func cloudChatMessagesAffectedByReceipts<Messages: Collection>(
    _ messages: Messages,
    before: CloudChatConversation,
    after: CloudChatConversation,
    cursor: CloudChatCursor?,
    viewerAccountId: String
) -> [CloudChatMessage] where Messages.Element == CloudChatMessage {
    let previousReadThrough = CloudReadReceiptRule.readThroughSequence(in: before, viewerAccountId: viewerAccountId)
    let readThrough = CloudReadReceiptRule.readThroughSequence(in: after, viewerAccountId: viewerAccountId)
    let cursorMessages = cursor.map {
        cloudChatMessagesAffectedByCursor(messages, conversation: before, cursor: $0)
    } ?? []
    let cursorMessageIds = Set(cursorMessages.map(\.id))
    let newlyRead = readThrough > previousReadThrough ? messages.filter { message in
        message.conversationId == after.id
            && message.senderAccountId == viewerAccountId
            && message.conversationSequence > previousReadThrough
            && message.conversationSequence <= readThrough
            && !cursorMessageIds.contains(message.id)
    } : []
    return cursorMessages + newlyRead
}
