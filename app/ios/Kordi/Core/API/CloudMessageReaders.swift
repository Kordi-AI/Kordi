import Foundation

/// One member who read the viewer's group message (#2455). `readAt` is nil
/// when the server no longer has the time.
struct CloudMessageReader: Codable, Hashable {
    let accountId: String
    let readAt: String?

    init(accountId: String, readAt: String?) {
        self.accountId = accountId
        self.readAt = readAt
    }

    private enum CodingKeys: String, CodingKey {
        case accountId, readAt
        case accountIdSnake = "account_id"
        case readAtSnake = "read_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let accountId = try container.decodeIfPresent(String.self, forKey: .accountId)
            ?? container.decodeIfPresent(String.self, forKey: .accountIdSnake) else {
            throw DecodingError.keyNotFound(CodingKeys.accountId, DecodingError.Context(
                codingPath: container.codingPath, debugDescription: "A reader needs an account id."
            ))
        }
        self.accountId = accountId
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
            ?? container.decodeIfPresent(String.self, forKey: .readAtSnake)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accountId, forKey: .accountId)
        try container.encode(readAt, forKey: .readAt)
    }
}

/// `GET .../messages/:message_id/readers`: readers in the server's order
/// (read time ascending, unknown times first). `total` ignores the limit.
struct CloudMessageReadersResponse: Codable, Hashable {
    let total: Int
    let readers: [CloudMessageReader]

    init(total: Int, readers: [CloudMessageReader]) {
        self.total = total
        self.readers = readers
    }

    private enum CodingKeys: String, CodingKey { case total, readers }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        readers = try container.decodeIfPresent([CloudMessageReader].self, forKey: .readers) ?? []
        total = max(try container.decodeIfPresent(Int.self, forKey: .total) ?? 0, readers.count)
    }
}

extension CloudAPIClient {
    /// The row asks for four readers; the full list asks for the maximum.
    static let messageReadersPreviewLimit = 4
    static let messageReadersMaximum = 100

    /// Only the author may ask. The server answers 403 to anyone else and 409
    /// `readers_unavailable` in a group of more than 100 active members.
    func messageReaders(
        token: String,
        sessionId: String,
        messageId: String,
        limit: Int
    ) async throws -> CloudMessageReadersResponse {
        guard let conversation = cachedChatConversations().first(where: {
            $0.legacySessionId == sessionId || $0.id == sessionId
        }) else {
            throw CloudAPIError(
                code: "chat_conversation_missing",
                message: "This conversation is not available in reliable chat sync.",
                statusCode: 404
            )
        }
        let conversationPath = conversation.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? conversation.id
        let messagePath = messageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageId
        let boundedLimit = min(max(limit, 1), Self.messageReadersMaximum)
        return try await send(
            path: "/v2/chat/conversations/\(conversationPath)/messages/\(messagePath)/readers",
            method: "GET",
            token: token,
            query: [URLQueryItem(name: "limit", value: String(boundedLimit))],
            fallback: "Could not load who has seen this message."
        )
    }
}
