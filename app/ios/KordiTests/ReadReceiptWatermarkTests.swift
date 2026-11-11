import XCTest
@testable import Kordi

/// Ticks for the viewer's own messages (#2455): the read watermark, the
/// fallback to other members' read cursors, and tolerant decoding.
final class ReadReceiptWatermarkTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: Decoding

    func testMemberWithoutWatermarkDecodesAsZero() throws {
        let member = try decoder.decode(CloudChatMember.self, from: memberJSON(extra: ""))
        XCTAssertEqual(member.readOutboxSequence, 0)
        XCTAssertEqual(member.lastReadSequence, 4)
    }

    func testMemberDecodesSnakeAndCamelWatermark() throws {
        let snake = try decoder.decode(CloudChatMember.self, from: memberJSON(extra: #","read_outbox_sequence":12"#))
        let camel = try decoder.decode(CloudChatMember.self, from: memberJSON(extra: #","readOutboxSequence":9"#))
        XCTAssertEqual(snake.readOutboxSequence, 12)
        XCTAssertEqual(camel.readOutboxSequence, 9)
    }

    func testMemberWithNullOrMalformedWatermarkStillDecodes() throws {
        let null = try decoder.decode(CloudChatMember.self, from: memberJSON(extra: #","read_outbox_sequence":null"#))
        let text = try decoder.decode(CloudChatMember.self, from: memberJSON(extra: #","read_outbox_sequence":"7""#))
        XCTAssertEqual(null.readOutboxSequence, 0)
        XCTAssertEqual(text.readOutboxSequence, 0)
    }

    func testMemberRoundTripKeepsTheWatermark() throws {
        let member = self.member("acct_me", read: 3, watermark: 8)
        let decoded = try decoder.decode(CloudChatMember.self, from: JSONEncoder().encode(member))
        XCTAssertEqual(decoded, member)
    }

    func testEventPayloadDecodesReadOutboxInEitherCasing() throws {
        let snake = try decoder.decode(CloudChatEventPayload.self, from: Data(
            #"{"cursor":\#(cursorJSON),"read_outbox":{"conversation_id":"conv","sequence":6}}"#.utf8
        ))
        let camel = try decoder.decode(CloudChatEventPayload.self, from: Data(
            #"{"cursor":\#(cursorJSON),"readOutbox":{"conversationId":"conv","sequence":5}}"#.utf8
        ))
        XCTAssertEqual(snake.readOutbox, CloudChatReadOutbox(conversationId: "conv", sequence: 6))
        XCTAssertEqual(camel.readOutbox, CloudChatReadOutbox(conversationId: "conv", sequence: 5))
        XCTAssertEqual(snake.cursor?.lastReadSequence, 6)
    }

    func testEventPayloadFromAnOlderServerHasNoReadOutbox() throws {
        let payload = try decoder.decode(CloudChatEventPayload.self, from: Data(#"{"cursor":\#(cursorJSON)}"#.utf8))
        XCTAssertNil(payload.readOutbox)
        XCTAssertNotNil(payload.cursor)
    }

    func testStoredDeliveredStateReadsAsSent() throws {
        XCTAssertEqual(MessageDeliveryState(rawValue: "delivered"), .sent)
        XCTAssertEqual(try decoder.decode([MessageDeliveryState].self, from: Data(#"["delivered","read"]"#.utf8)), [.sent, .read])
        XCTAssertEqual(MessageDeliveryState.sent.rawValue, "sent")
        XCTAssertEqual(MessageDeliveryState.sent.label, "Sent")
        XCTAssertEqual(MessageDeliveryState.read.label, "Seen")
    }

    // MARK: Tick rule

    func testWatermarkAloneMakesOwnMessagesRead() {
        let conversation = conversation(members: [
            member("acct_me", read: 10, watermark: 7),
            member("acct_peer", read: 0)
        ])
        XCTAssertEqual(CloudReadReceiptRule.readThroughSequence(in: conversation, viewerAccountId: "acct_me"), 7)
        XCTAssertTrue(CloudReadReceiptRule.isRead(sequence: 7, in: conversation, viewerAccountId: "acct_me"))
        XCTAssertFalse(CloudReadReceiptRule.isRead(sequence: 8, in: conversation, viewerAccountId: "acct_me"))
    }

    func testMemberCursorsStandInForAServerWithoutTheWatermark() {
        let conversation = conversation(members: [
            member("acct_me", read: 10),
            member("acct_a", read: 3),
            member("acct_b", read: 5)
        ])
        XCTAssertEqual(CloudReadReceiptRule.readThroughSequence(in: conversation, viewerAccountId: "acct_me"), 5)
    }

    func testTickUsesTheHigherOfWatermarkAndKnownCursors() {
        let conversation = conversation(members: [
            member("acct_me", read: 10, watermark: 4),
            member("acct_a", read: 6)
        ])
        XCTAssertEqual(CloudReadReceiptRule.readThroughSequence(in: conversation, viewerAccountId: "acct_me"), 6)
    }

    func testOwnCursorLeftMembersAndServiceAccountsDoNotCount() {
        let conversation = conversation(members: [
            member("acct_me", read: 20),
            member("acct_left", read: 15, state: "left"),
            member(KordiSystemIdentity.accountId, read: 18)
        ])
        XCTAssertEqual(CloudReadReceiptRule.readThroughSequence(in: conversation, viewerAccountId: "acct_me"), 0)
        XCTAssertFalse(CloudReadReceiptRule.isRead(sequence: 0, in: conversation, viewerAccountId: "acct_me"))
    }

    func testLegacyProjectionDrawsTwoTicksFromTheWatermark() async {
        let client = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!)
        let conversation = conversation(members: [
            member("acct_me", read: 3, watermark: 3),
            member("acct_peer", read: 0)
        ])
        let read = await client.legacyMessage(from: message(3), conversation: conversation, viewerAccountId: "acct_me")
        let unread = await client.legacyMessage(from: message(4), conversation: conversation, viewerAccountId: "acct_me")
        XCTAssertNotNil(read.readAt)
        XCTAssertNil(unread.readAt)
        XCTAssertNotNil(unread.deliveredAt)
        XCTAssertEqual(CloudMessageStateProjector.deliveryState(for: read, ownAccountId: "acct_me"), .read)
        XCTAssertEqual(CloudMessageStateProjector.deliveryState(for: unread, ownAccountId: "acct_me"), .sent)
    }

    // MARK: Never lowering

    func testReadOutboxRaisesButNeverLowersTheWatermark() {
        let start = conversation(members: [member("acct_me", read: 9, watermark: 5), member("acct_peer", read: 0)])
        let raised = start.applyingReceipts(
            cursor: nil, readOutbox: CloudChatReadOutbox(conversationId: start.id, sequence: 8), viewerAccountId: "acct_me"
        )
        let lowered = raised.applyingReceipts(
            cursor: nil, readOutbox: CloudChatReadOutbox(conversationId: nil, sequence: 2), viewerAccountId: "acct_me"
        )
        XCTAssertEqual(raised.members.first?.readOutboxSequence, 8)
        XCTAssertEqual(lowered.members.first?.readOutboxSequence, 8)
    }

    func testReadOutboxForAnotherConversationIsIgnored() {
        let start = conversation(members: [member("acct_me", read: 9, watermark: 5)])
        let updated = start.applyingReceipts(
            cursor: nil, readOutbox: CloudChatReadOutbox(conversationId: "other", sequence: 8), viewerAccountId: "acct_me"
        )
        XCTAssertEqual(updated.members.first?.readOutboxSequence, 5)
    }

    func testOlderSnapshotKeepsTheAppliedWatermark() {
        let applied = conversation(members: [member("acct_me", read: 9, watermark: 8)])
        let stale = conversation(members: [member("acct_me", read: 9, watermark: 3), member("acct_new", read: 0)])
        let kept = stale.keepingReadOutbox(from: applied)
        XCTAssertEqual(kept.members.map(\.readOutboxSequence), [8, 0])
        XCTAssertEqual(stale.keepingReadOutbox(from: nil), stale)
    }

    func testCursorMoveKeepsTheWatermarkAndGroupFields() {
        var start = conversation(members: [member("acct_me", read: 2, watermark: 6), member("acct_peer", read: 1)])
        start.groupSpaceId = "space"
        let moved = start.withCursor(CloudChatCursor(
            conversationId: start.id, accountId: "acct_me", lastDeliveredSequence: 9, lastReadSequence: 9
        ))
        XCTAssertEqual(moved.members.first?.readOutboxSequence, 6)
        XCTAssertEqual(moved.members.first?.lastReadSequence, 9)
        XCTAssertEqual(moved.groupSpaceId, "space")
    }

    // MARK: Event application

    func testRaisedWatermarkReprojectsOnlyNewlyReadOwnMessages() {
        let before = conversation(members: [member("acct_me", read: 9, watermark: 2), member("acct_peer", read: 0)])
        let after = before.applyingReceipts(
            cursor: nil, readOutbox: CloudChatReadOutbox(conversationId: before.id, sequence: 5), viewerAccountId: "acct_me"
        )
        let messages = (1...7).map { message(Int64($0), sender: $0 == 4 ? "acct_peer" : "acct_me") }
        let affected = cloudChatMessagesAffectedByReceipts(
            messages, before: before, after: after, cursor: nil, viewerAccountId: "acct_me"
        )
        XCTAssertEqual(affected.map(\.conversationSequence), [3, 5])
    }

    func testCursorAndWatermarkReprojectEachMessageOnce() {
        let before = conversation(members: [member("acct_me", read: 9, watermark: 2), member("acct_peer", read: 2)])
        let cursor = CloudChatCursor(conversationId: before.id, accountId: "acct_peer", lastDeliveredSequence: 4, lastReadSequence: 4)
        let after = before.applyingReceipts(
            cursor: cursor, readOutbox: CloudChatReadOutbox(conversationId: before.id, sequence: 4), viewerAccountId: "acct_me"
        )
        let messages = (1...6).map { message(Int64($0)) }
        let affected = cloudChatMessagesAffectedByReceipts(
            messages, before: before, after: after, cursor: cursor, viewerAccountId: "acct_me"
        )
        XCTAssertEqual(affected.map(\.conversationSequence).sorted(), [3, 4])
    }

    /// The reader joined after the cached snapshot, so only the watermark can
    /// tell the client that its message was read.
    func testSyncedReadOutboxEventMarksOwnMessageReadAndNeverLowers() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReadOutboxSyncURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let bootstrap = try await client.sync(token: "session", cursor: "0")
        let initial = try XCTUnwrap(bootstrap.events.compactMap(\.payload?.message).first { $0.messageId == "own-6" })
        XCTAssertNil(initial.readAt)

        let raised = try await client.sync(token: "session", cursor: "10")
        let reprojected = raised.events.compactMap(\.payload?.message)
        XCTAssertEqual(reprojected.map(\.messageId), ["own-6"])
        XCTAssertNotNil(reprojected.first?.readAt)

        let lowered = try await client.sync(token: "session", cursor: "11")
        XCTAssertTrue(lowered.events.compactMap(\.payload?.message).isEmpty)
        let cached = await client.cachedChatConversations()
        let viewer = try XCTUnwrap(cached.first?.members.first { $0.accountId == "acct_me" })
        XCTAssertEqual(viewer.readOutboxSequence, 6)
    }

    // MARK: Fixtures

    private let cursorJSON = #"{"conversation_id":"conv","account_id":"acct_peer","last_delivered_sequence":6,"last_read_sequence":6}"#

    private func memberJSON(extra: String) -> Data {
        Data((#"{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-11-10T10:00:00Z","left_at":null"# + extra + "}").utf8)
    }

    private func member(_ accountId: String, read: Int64, watermark: Int64 = 0, state: String = "active") -> CloudChatMember {
        CloudChatMember(
            accountId: accountId, displayName: accountId, avatarUrl: nil, defaultAgentId: nil,
            defaultAgentDisplayName: nil, defaultAgentAvatarUrl: nil, role: "member", membershipState: state,
            version: 1, lastDeliveredSequence: read, lastReadSequence: read,
            joinedAt: "2026-11-10T10:00:00Z", leftAt: nil, readOutboxSequence: watermark
        )
    }

    private func conversation(members: [CloudChatMember]) -> CloudChatConversation {
        CloudChatConversation(
            id: "conv", kind: "group", sharedTitle: "Launch prep", version: 1, createdByAccountId: "acct_me",
            legacySessionId: "session:group:launch", forkedFromSessionId: nil, forkedFromMessageId: nil,
            latestMessageSequence: 10, createdAt: "2026-11-10T10:00:00Z", updatedAt: "2026-11-10T10:00:00Z",
            members: members,
            preferences: CloudChatPreferences(conversationId: "conv", accountId: "acct_me", personalTitle: nil, version: 1)
        )
    }

    private func message(_ sequence: Int64, sender: String = "acct_me") -> CloudChatMessage {
        CloudChatMessage(
            id: "message-\(sequence)", clientMessageId: "client-\(sequence)", conversationId: "conv",
            conversationSequence: sequence, senderAccountId: sender, kind: "text",
            content: CloudChatContent(body: "Hello", attachments: []), replyToMessageId: nil, attachmentIds: [],
            version: 1, generationStatus: nil, providerResponseId: nil, createdAt: "2026-11-10T10:00:00Z",
            editedAt: nil, deletedAt: nil, reactions: nil
        )
    }
}

/// Bootstrap with the viewer's watermark at 5, then one event from a member
/// the snapshot did not list that raises it to 6, and one that would lower it.
private final class ReadOutboxSyncURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "cursor" }?.value
        let body: String
        switch (url.path, cursor) {
        case ("/v2/chat/sync/bootstrap", _): body = Self.bootstrap
        case ("/v2/chat/sync", "10"): body = Self.events(next: "11", outbox: 6, readerCursor: 6)
        case ("/v2/chat/sync", _): body = Self.events(next: "12", outbox: 4, readerCursor: 4)
        default: body = "{}"
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func ownMessage(_ sequence: Int) -> String {
        #"{"id":"own-\#(sequence)","client_message_id":"client-\#(sequence)","conversation_id":"conv","conversation_sequence":\#(sequence),"sender_account_id":"acct_me","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"Hello"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":1,"generation_status":null,"provider_response_id":null,"created_at":"2026-11-10T10:00:00Z","edited_at":null,"deleted_at":null}"#
    }

    private static let member = #"{"account_id":"%@","display_name":"%@","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":%ld,"last_read_sequence":%ld,"joined_at":"2026-11-10T10:00:00Z","left_at":null%@}"#

    private static var bootstrap: String {
        let me = String(format: member, "acct_me", "Me", 10, 10, #","read_outbox_sequence":5"#)
        let peer = String(format: member, "acct_peer", "Peer", 0, 0, "")
        return #"{"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[{"id":"conv","kind":"group","shared_title":"Launch prep","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:group:launch","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":6,"created_at":"2026-11-10T10:00:00Z","updated_at":"2026-11-10T10:00:00Z","members":[\#(me),\#(peer)],"preferences":{"conversation_id":"conv","account_id":"acct_me","personal_title":null,"version":1}}],"latest_messages":[\#(ownMessage(5)),\#(ownMessage(6))],"next_cursor":"10","last_stream_seq":10,"server_time":"2026-11-10T10:01:00Z"}"#
    }

    private static func events(next: String, outbox: Int, readerCursor: Int) -> String {
        let cursor = #"{"conversation_id":"conv","account_id":"acct_new","last_delivered_sequence":\#(readerCursor),"last_read_sequence":\#(readerCursor)}"#
        let event = #"{"stream_seq":\#(next),"event_id":"event-\#(next)","protocol_version":2,"type":"read_cursor.updated","critical":false,"conversation_id":"conv","entity_id":"conv","entity_version":null,"occurred_at":"2026-11-10T10:02:00Z","payload":{"cursor":\#(cursor),"read_outbox":{"conversation_id":"conv","sequence":\#(outbox)}}}"#
        return #"{"protocol_version":2,"events":[\#(event)],"next_cursor":"\#(next)","last_stream_seq":\#(next),"has_more":false,"server_time":"2026-11-10T10:02:00Z"}"#
    }
}
