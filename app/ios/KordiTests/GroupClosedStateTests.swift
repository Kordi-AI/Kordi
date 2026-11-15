import XCTest
@testable import Kordi

/// Closed groups (docs/development/group-closed-state.md).
final class GroupClosedStateTests: XCTestCase {
    func testConversationSnapshotDecodesClosed() throws {
        let closed = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: Data(GroupClosedStateFixture.conversation(closed: true).utf8)
        )
        XCTAssertEqual(closed.closed?.closedAt, "2026-11-13T10:00:00Z")
        XCTAssertEqual(closed.closed?.closedByAccountId, "acct_owner")

        let open = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: Data(GroupClosedStateFixture.conversation(closed: false).utf8)
        )
        XCTAssertNil(open.closed)
    }

    func testClosedSessionIdsUseTheLegacySessionId() throws {
        let closed = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: Data(GroupClosedStateFixture.conversation(closed: true).utf8)
        )
        let open = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: Data(GroupClosedStateFixture.conversation(closed: false, id: "conversation-other", sessionId: nil).utf8)
        )
        XCTAssertEqual(
            GroupClosedState.closedSessionIds(in: [closed, open]),
            [GroupClosedStateFixture.sessionId]
        )
    }

    func testConversationUpdatedEventMarksTheSessionClosed() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GroupClosedSyncURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        await client.activateAccount("acct_me")

        _ = try await client.bootstrapChatLatestMessages(token: "synthetic")
        let beforeClose = await client.cachedChatConversations()
        XCTAssertEqual(beforeClose.count, 1)
        XCTAssertTrue(GroupClosedState.closedSessionIds(in: beforeClose).isEmpty)

        let response = try await client.sync(token: "synthetic", cursor: "1")

        XCTAssertFalse(response.events.contains { $0.eventType == "session.deleted" })
        let afterClose = await client.cachedChatConversations()
        XCTAssertEqual(afterClose.count, 1, "Closing keeps the conversation and its history.")
        XCTAssertEqual(GroupClosedState.closedSessionIds(in: afterClose), [GroupClosedStateFixture.sessionId])
    }

    func testGroupIsClosedWhenItsFirstChannelIsClosed() throws {
        let root = channel("session:group:root", groupSpaceId: "session:group:root")
        let child = channel("session:group:child", groupSpaceId: "session:group:root")
        let space = try XCTUnwrap(GroupSpaceCatalog.build(conversations: [root, child], ownAccountId: "acct_me").first)

        XCTAssertEqual(space.authoritySession?.sessionId, root.sessionId)
        XCTAssertTrue(space.isClosed(closedSessionIds: [root.sessionId]))
        XCTAssertFalse(space.isClosed(closedSessionIds: [child.sessionId]))
        XCTAssertFalse(space.isClosed(closedSessionIds: []))
    }

    func testGroupWithoutItsFirstChannelIsClosedOnlyWhenEveryChannelIs() throws {
        let first = channel("session:group:a", groupSpaceId: "session:group:space")
        let second = channel("session:group:b", groupSpaceId: "session:group:space")
        let space = try XCTUnwrap(GroupSpaceCatalog.build(conversations: [first, second], ownAccountId: "acct_me").first)

        XCTAssertNil(space.authoritySession)
        XCTAssertFalse(space.isClosed(closedSessionIds: [first.sessionId]))
        XCTAssertTrue(space.isClosed(closedSessionIds: [first.sessionId, second.sessionId]))
    }

    @MainActor
    func testClosedWriteIsRejectedNotRetried() {
        let error = CloudAPIError(code: "group_closed", message: "This group was closed.", statusCode: 409)
        XCTAssertTrue(GroupClosedState.isClosedError(error))
        XCTAssertEqual(MessageSendOutbox.verdict(for: error), .rejected)
        XCTAssertFalse(GroupClosedState.isClosedError(
            CloudAPIError(code: "IDEMPOTENCY_KEY_REUSED", message: "", statusCode: 409)
        ))
    }

    @MainActor
    func testClosedWriteShowsTheClosedCopy() {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let error = CloudAPIError(code: "group_closed", message: "", statusCode: 409)
        XCTAssertEqual(model.userFacing(error, fallback: "Message not sent."), "This group was closed.")
    }

    @MainActor
    func testCreatorKeepsTheGroupAfterClosingIt() async throws {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let accountId = model.account?.accountId
        let space = GroupSpaceCatalog.build(conversations: model.conversations, ownAccountId: accountId ?? "")
            .first { $0.canManage(accountId: accountId) }
        let manageable = try XCTUnwrap(space, "Preview data has no group this account can manage.")

        let closed = await model.dissolveGroupSpace(manageable)

        XCTAssertTrue(closed)
        XCTAssertTrue(model.isGroupSpaceClosed(manageable))
        for session in manageable.membershipSessions {
            XCTAssertTrue(model.conversations.contains { $0.sessionId == session.sessionId })
            XCTAssertTrue(model.isConversationClosed(session))
        }
        XCTAssertEqual(model.closedChatDeleteTarget(for: manageable.membershipSessions[0]).id, "group:\(manageable.id)")
    }

    private func channel(_ sessionId: String, groupSpaceId: String) -> ConversationSummary {
        ConversationSummary(
            id: sessionId, kind: .group, peerAccountId: "acct_peer", agentId: nil,
            ownerDisplayName: "Infrastructure", displayName: "Channel", lastMessage: "",
            lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: sessionId, groupSpaceId: groupSpaceId,
            groupParticipants: []
        )
    }
}

private enum GroupClosedStateFixture {
    static let sessionId = "session:group:infrastructure"

    static func conversation(
        closed: Bool,
        id: String = "conversation-group",
        sessionId: String? = Self.sessionId,
        version: Int = 1
    ) -> String {
        let legacy = sessionId.map { "\"\($0)\"" } ?? "null"
        let closedField = closed
            ? #","closed":{"closed_at":"2026-11-13T10:00:00Z","closed_by_account_id":"acct_owner"}"#
            : ""
        return """
        {"id":"\(id)","kind":"group","shared_title":"Infrastructure","version":\(version),"created_by_account_id":"acct_owner","legacy_session_id":\(legacy),"group_space_id":"\(Self.sessionId)"\(closedField),"forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":3,"created_at":"2026-11-13T09:00:00Z","updated_at":"2026-11-13T10:00:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":3,"last_read_sequence":3,"joined_at":"2026-11-13T09:00:00Z","left_at":null}],"preferences":{"conversation_id":"\(id)","account_id":"acct_me","personal_title":null,"version":1}}
        """
    }
}

private final class GroupClosedSyncURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body: String
        if request.url?.path.hasSuffix("/sync/bootstrap") == true {
            body = """
            {"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[\(GroupClosedStateFixture.conversation(closed: false))],"latest_messages":[],"next_cursor":"1","last_stream_seq":1,"server_time":"2026-11-13T09:30:00Z"}
            """
        } else {
            body = """
            {"protocol_version":2,"events":[{"stream_seq":2,"event_id":"event-group-closed","protocol_version":2,"type":"conversation.updated","critical":true,"conversation_id":"conversation-group","entity_id":"conversation-group","entity_version":2,"occurred_at":"2026-11-13T10:00:00Z","payload":{"conversation":\(GroupClosedStateFixture.conversation(closed: true, version: 2))}}],"next_cursor":"2","last_stream_seq":2,"has_more":false,"server_time":"2026-11-13T10:00:00Z"}
            """
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
