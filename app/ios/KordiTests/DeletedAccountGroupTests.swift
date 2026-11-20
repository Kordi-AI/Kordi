import XCTest
@testable import Kordi

/// A group whose creator's account was deleted while this iPhone was open
/// (docs/development/account-deletion.md): the creator leaves the member
/// list without a relaunch, the longest-standing admin becomes owner, and
/// the owner keeps managing the group.
final class DeletedAccountGroupTests: XCTestCase {
    private let viewer = "acct_rowan"
    private let gone = "acct_dana"
    private let lee = "acct_lee"
    private let sessionId = "session:group:planning"

    private lazy var account: CloudAccount = {
        let avatar = CanonicalAvatarDescriptor(
            entityType: "human", entityId: viewer, source: "generated",
            style: CanonicalAvatarSystem.humanStyle, seed: viewer,
            rendererVersion: CanonicalAvatarSystem.rendererVersion, uploadedAsset: nil,
            version: 1, updatedAt: "2026-11-01T00:00:00Z"
        )
        return CloudAccount(accountId: viewer, kordiId: nil, displayName: "Rowan Sample",
            primaryEmail: "rowan@example.test", avatarUrl: nil, avatar: avatar, nodeId: nil, passwordSet: true)
    }()

    func testDeletedMemberLeavesTheGroupWhenTheMemberListChanges() throws {
        let before = try catalogGroup(members: [
            member(viewer, "Rowan Sample", role: "member"),
            member(gone, "Dana Sample", role: "owner"),
            member(lee, "Lee Example", role: "admin"),
        ], creator: gone)
        XCTAssertEqual(Set(before.groupParticipants.map(\.accountId)), [viewer, gone, lee])

        // `membership.updated` after the deletion: the creator's row is gone,
        // the stand-in is a member who left, and Lee owns the group.
        let after = try catalogGroup(members: [
            member(viewer, "Rowan Sample", role: "member"),
            member(lee, "Lee Example", role: "owner"),
            member(KordiDeletedAccount.accountId, "Deleted account", role: "member", state: "left"),
        ], creator: KordiDeletedAccount.accountId)

        XCTAssertEqual(Set(after.groupParticipants.map(\.accountId)), [viewer, lee], "Older envelopes still name the deleted creator.")
        XCTAssertFalse(after.groupParticipants.contains { $0.displayName == "Dana Sample" })
        let space = try XCTUnwrap(GroupSpaceCatalog.build(conversations: [after], ownAccountId: viewer).first)
        XCTAssertEqual(Set(space.participants.map(\.accountId)), [viewer, lee])
    }

    func testTheNewOwnerManagesTheGroupAndItsChannels() throws {
        let group = try catalogGroup(members: [
            member(viewer, "Rowan Sample", role: "member"),
            member(lee, "Lee Example", role: "owner"),
            member(KordiDeletedAccount.accountId, "Deleted account", role: "member", state: "left"),
        ], creator: KordiDeletedAccount.accountId)

        // The member list's role wins over the role an older envelope listed.
        XCTAssertEqual(group.groupParticipants.first { $0.accountId == lee }?.role, "owner")
        XCTAssertTrue(group.canManageGroup(accountId: lee), "An owner renames channels as an admin does.")
        XCTAssertFalse(group.canManageGroup(accountId: viewer))
        XCTAssertEqual(group.groupCreatorAccountId, KordiDeletedAccount.accountId)
        let space = try XCTUnwrap(GroupSpaceCatalog.build(conversations: [group], ownAccountId: viewer).first)
        XCTAssertTrue(space.canManage(accountId: lee), "and renames the group")
    }

    func testOwnerTakesTheDeletedCreatorsPlaceInAnUnnamedGroupTitle() {
        let members = [
            CloudGroupParticipant(accountId: viewer, displayName: "Rowan Sample", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: lee, displayName: "Lee Example", avatarUrl: nil, role: "owner"),
            CloudGroupParticipant(accountId: "acct_sky", displayName: "Sky Example", avatarUrl: nil, role: "member"),
        ]
        XCTAssertEqual(
            GroupSpaceCatalog.participantTitle(members, creatorAccountId: KordiDeletedAccount.accountId),
            GroupSpaceCatalog.participantTitle(members, creatorAccountId: lee)
        )
        XCTAssertEqual(GroupSpaceCatalog.participantTitle(members, creatorAccountId: KordiDeletedAccount.accountId), "Rowan Sample, Sky Example")
    }

    func testAMemberListWithoutTheViewerDropsOnlyTheStandIn() throws {
        let participants = [
            CloudGroupParticipant(accountId: viewer, displayName: "Rowan Sample", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: gone, displayName: "Dana Sample", avatarUrl: nil, role: "owner"),
            CloudGroupParticipant(accountId: KordiDeletedAccount.accountId, displayName: "Deleted account", avatarUrl: nil, role: "member"),
        ]
        let partial = try conversation(members: [member(lee, "Lee Example", role: "owner")], creator: gone)
        let viewerLeft = try conversation(members: [
            member(viewer, "Rowan Sample", role: "member", state: "left"), member(lee, "Lee Example", role: "owner"),
        ], creator: gone)

        for list in [partial, viewerLeft] {
            XCTAssertEqual(
                CloudConversationCatalog.currentMembers(participants, conversation: list, viewerAccountId: viewer).map(\.accountId),
                [viewer, gone]
            )
        }
        XCTAssertEqual(
            CloudConversationCatalog.currentMembers(participants, conversation: nil, viewerAccountId: viewer).map(\.accountId),
            [viewer, gone]
        )
    }

    /// Envelopes carry the participant list of their moment: one written
    /// before someone left names them, but only the newest member list counts.
    func testAnOlderEnvelopeNeverListsSomeoneTheMemberListHasNot() throws {
        let group = try catalogGroup(members: [
            member(viewer, "Rowan Sample", role: "member"),
            member(gone, "Dana Sample", role: "owner", state: "left"),
            member(lee, "Lee Example", role: "admin"),
        ], creator: gone)

        XCTAssertEqual(Set(group.groupParticipants.map(\.accountId)), [viewer, lee])
        // Their messages keep their own name, never the group's.
        let earlier = ChatMessage(
            id: "group-old", conversationId: group.id, author: .person, authorName: "Dana Sample",
            text: "Earlier plan", createdAt: Date(timeIntervalSince1970: 1), deliveryState: .read,
            errorMessage: nil, requestMessageId: nil
        )
        let identity = MessageAuthorIdentity.resolve(earlier, in: group, account: account, mentionTargets: [])
        XCTAssertEqual(identity.name, "Dana Sample")
        XCTAssertNil(identity.source)
    }

    // MARK: Two deletions at nearly the same moment

    /// Dana's deletion rewrites a message and sends it with the member list of
    /// its moment, where Sky is still active; Sky's deletion sends a newer
    /// list without Sky. Whatever order they arrive in, and in one batch,
    /// Sky stays gone.
    func testANewerMemberListWinsInEveryArrivalOrder() async throws {
        for scenario in TwoDeletionsURLProtocol.Scenario.allCases {
            TwoDeletionsURLProtocol.scenario = scenario
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [TwoDeletionsURLProtocol.self]
            let client = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:9")!, session: URLSession(configuration: configuration))
            await client.activateAccount(viewer)
            let latest = try await client.bootstrapChatLatestMessages(token: "synthetic")
            var synced: [CloudMessageDTO] = []
            var cursor = "1"
            while cursor != "3" {
                let page = try await client.sync(token: "synthetic", cursor: cursor)
                synced += page.events.compactMap { $0.payload?.message }
                cursor = page.cursor
            }

            let conversations = await client.cachedChatConversations()
            let stored = try XCTUnwrap(conversations.first)
            XCTAssertEqual(stored.version, 3, "\(scenario)")
            XCTAssertEqual(Set(stored.members.filter { $0.membershipState == "active" }.map(\.accountId)), [viewer, lee], "\(scenario)")
            let canonicalParticipants = await client.cachedChatParticipantsBySessionId()
            XCTAssertEqual(Set(canonicalParticipants[sessionId, default: []].map(\.accountId)), [viewer, lee], "\(scenario)")

            // The rewritten message still names Sky in its envelope.
            XCTAssertFalse(synced.isEmpty, "\(scenario)")
            let catalog = CloudConversationCatalog.build(
                account: account, contacts: [], ownedAgents: [], sharedAgents: [],
                messagesByPeer: [KordiDeletedAccount.accountId: latest + synced],
                canonicalConversations: conversations,
                canonicalParticipantsBySessionId: canonicalParticipants
            )
            let group = try XCTUnwrap(catalog.first { $0.sessionId == sessionId }, "\(scenario)")
            XCTAssertEqual(Set(group.groupParticipants.map(\.accountId)), [viewer, lee], "\(scenario)")
            let space = try XCTUnwrap(GroupSpaceCatalog.build(conversations: [group], ownAccountId: viewer).first)
            XCTAssertFalse(space.participants.contains { $0.accountId == TwoDeletionsURLProtocol.sky }, "\(scenario)")
        }
    }

    func testAGroupMessageFromTheStandInIsNamedTheDeletedAccount() throws {
        let group = try catalogGroup(members: [
            member(viewer, "Rowan Sample", role: "member"),
            member(lee, "Lee Example", role: "owner"),
            member(KordiDeletedAccount.accountId, "Deleted account", role: "member", state: "left"),
        ], creator: KordiDeletedAccount.accountId)
        let fromStandIn = CloudMessageDTO(
            messageId: "group-plain-1", fromAccountId: KordiDeletedAccount.accountId, toAccountId: viewer,
            body: "Earlier plan", createdAt: "2026-11-18T09:05:00Z", deliveredAt: nil, readAt: nil,
            direction: "incoming", sessionId: sessionId, attachments: [],
            conversationId: "conversation-planning", conversationSequence: 5
        )

        let messages = AppModel.mapGroupMessages([fromStandIn], conversation: group, ownAccountId: viewer)

        let message = try XCTUnwrap(messages.first { $0.id == "group-plain-1" })
        XCTAssertEqual(message.authorName, "Deleted account", "not the group's own name")
        XCTAssertTrue(MessageAuthorIdentity.isDeletedAccount(message, in: group))
    }

    // MARK: Fixture

    /// The group as the catalog builds it from an older envelope that still
    /// lists Dana as owner and creator, and the conversation's member list.
    private func catalogGroup(members: [String], creator: String) throws -> ConversationSummary {
        let canonical = try conversation(members: members, creator: creator)
        let legacy = [
            CloudGroupParticipant(accountId: viewer, displayName: "Rowan Sample", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: gone, displayName: "Dana Sample", avatarUrl: nil, role: "owner"),
            CloudGroupParticipant(accountId: lee, displayName: "Lee Example", avatarUrl: nil, role: "admin"),
        ]
        let invite = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite", groupId: sessionId, groupSpaceId: sessionId, groupTitle: nil,
            createdByAccountId: gone, actor: legacy[1], participants: legacy, message: nil
        ))
        let wire = CloudMessageDTO(
            messageId: "invite-1", fromAccountId: gone, toAccountId: viewer, body: invite,
            createdAt: "2026-11-01T09:00:00Z", deliveredAt: nil, readAt: nil, direction: "incoming",
            sessionId: sessionId, attachments: [], conversationId: "conversation-planning", conversationSequence: 1
        )
        // The active members, as `CloudAPIClient.cachedChatParticipantsBySessionId` lists them.
        let active = canonical.members.filter { $0.membershipState == "active" }.map {
            CloudGroupParticipant(accountId: $0.accountId, displayName: $0.displayName ?? "", avatarUrl: nil, role: $0.role)
        }
        let catalog = CloudConversationCatalog.build(
            account: account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [gone: [wire]],
            canonicalConversations: [canonical],
            canonicalParticipantsBySessionId: [sessionId: active, canonical.id: active]
        )
        return try XCTUnwrap(catalog.first { $0.sessionId == sessionId })
    }

    private func conversation(members: [String], creator: String) throws -> CloudChatConversation {
        let json = """
        {"id":"conversation-planning","kind":"group","shared_title":null,"version":2,"created_by_account_id":"\(creator)","legacy_session_id":"\(sessionId)","group_space_id":"\(sessionId)","group_title":null,"forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":4,"created_at":"2026-11-01T09:00:00Z","updated_at":"2026-11-18T10:00:00Z","members":[\(members.joined(separator: ","))],"preferences":{"conversation_id":"conversation-planning","account_id":"\(viewer)","personal_title":null,"version":1}}
        """
        return try JSONDecoder().decode(CloudChatConversation.self, from: Data(json.utf8))
    }

    private func member(_ accountId: String, _ name: String, role: String, state: String = "active") -> String {
        let leftAt = state == "active" ? "null" : "\"2026-11-18T10:00:00Z\""
        return """
        {"account_id":"\(accountId)","display_name":"\(name)","avatar_url":null,"role":"\(role)","membership_state":"\(state)","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-11-01T09:00:00Z","left_at":\(leftAt)}
        """
    }
}

/// One group, two members deleted at nearly the same moment. Dana's deletion
/// moves her message to the stand-in and sends it with the member list of
/// its moment (version 2, Sky still active); Sky's deletion sends version 3
/// without Sky. `scenario` picks the order they arrive in.
private final class TwoDeletionsURLProtocol: URLProtocol {
    enum Scenario: CaseIterable {
        /// Version 2 on the first page, version 3 on the next.
        case newerLast
        /// Version 3 on the first page, the older version 2 on the next.
        case olderLast
        /// Both in one sync batch, the older one last.
        case oneBatch
    }

    static let viewer = "acct_rowan"
    static let dana = "acct_dana"
    static let lee = "acct_lee"
    static let sky = "acct_sky"
    static let sessionId = "session:group:planning"
    static let conversationId = "conversation-planning"
    private static let lock = NSLock()
    private static var current = Scenario.newerLast
    static var scenario: Scenario {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "cursor" }?.value
        let body: String
        if url.path.hasSuffix("/sync/bootstrap") {
            body = Self.bootstrap()
        } else {
            let moved = Self.event(2, type: "message.updated", payload: #"{"conversation":\#(Self.afterDana),"message":\#(Self.movedMessage)}"#)
            let removed = Self.event(3, type: "membership.updated", payload: #"{"conversation":\#(Self.afterSky)}"#)
            switch (Self.scenario, cursor) {
            case (.newerLast, "1"): body = Self.page([moved], next: "2")
            case (.newerLast, _): body = Self.page([removed], next: "3")
            case (.olderLast, "1"): body = Self.page([removed], next: "2")
            case (.olderLast, _): body = Self.page([moved], next: "3")
            case (.oneBatch, _): body = Self.page([removed, moved], next: "3")
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    // MARK: Payloads

    private static let beforeDeletions = conversation(version: 1, creator: dana, members: [
        member(viewer, "Rowan Sample", role: "member"), member(dana, "Dana Sample", role: "owner"),
        member(lee, "Lee Example", role: "admin"), member(sky, "Sky Example", role: "member"),
    ])
    private static let afterDana = conversation(version: 2, creator: KordiDeletedAccount.accountId, members: [
        member(viewer, "Rowan Sample", role: "member"), member(lee, "Lee Example", role: "owner"),
        member(sky, "Sky Example", role: "member"),
        member(KordiDeletedAccount.accountId, "Deleted account", role: "member", state: "left"),
    ])
    private static let afterSky = conversation(version: 3, creator: KordiDeletedAccount.accountId, members: [
        member(viewer, "Rowan Sample", role: "member"), member(lee, "Lee Example", role: "owner"),
        member(KordiDeletedAccount.accountId, "Deleted account", role: "member", state: "left"),
    ])

    private static var movedMessage: String {
        message(version: 2, sender: KordiDeletedAccount.accountId, senderName: "Deleted account",
                participants: [(viewer, "Rowan Sample"), (lee, "Lee Example"), (sky, "Sky Example")])
    }

    private static func bootstrap() -> String {
        let original = message(version: 1, sender: dana, senderName: "Dana Sample",
                               participants: [(viewer, "Rowan Sample"), (dana, "Dana Sample"), (lee, "Lee Example"), (sky, "Sky Example")])
        return """
        {"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[\(beforeDeletions)],"latest_messages":[\(original)],"next_cursor":"1","last_stream_seq":1,"server_time":"2026-11-18T09:30:00Z"}
        """
    }

    private static func message(version: Int, sender: String, senderName: String, participants: [(String, String)]) -> String {
        let people = participants.map { CloudGroupParticipant(accountId: $0.0, displayName: $0.1, avatarUrl: nil, role: "member") }
        let actor = people.first { $0.accountId == sender }
            ?? CloudGroupParticipant(accountId: sender, displayName: senderName, avatarUrl: nil, role: "member")
        let envelope = (try? CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message", groupId: sessionId, groupSpaceId: sessionId, groupTitle: "Planning",
            createdByAccountId: sender == dana ? dana : KordiDeletedAccount.accountId,
            actor: actor, participants: people,
            message: CloudGroupMessagePayload(
                id: "group-message-1", senderAccountId: sender, text: "Earlier plan",
                createdAtMs: 1_795_000_000_000, senderKind: "human", senderDisplayName: senderName,
                deliveryState: "complete", replyToMessageId: nil, requestId: nil
            )
        ))) ?? ""
        return """
        {"id":"message-1","client_message_id":"client-message-1","conversation_id":"\(conversationId)","conversation_sequence":1,"sender_account_id":"\(sender)","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"\(envelope)"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":\(version),"generation_status":null,"provider_response_id":null,"created_at":"2026-11-18T09:01:00Z","edited_at":null,"deleted_at":null}
        """
    }

    private static func conversation(version: Int, creator: String, members: [String]) -> String {
        """
        {"id":"\(conversationId)","kind":"group","shared_title":null,"version":\(version),"created_by_account_id":"\(creator)","legacy_session_id":"\(sessionId)","group_space_id":"\(sessionId)","group_title":"Planning","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":1,"created_at":"2026-11-01T09:00:00Z","updated_at":"2026-11-18T10:0\(version):00Z","members":[\(members.joined(separator: ","))],"preferences":{"conversation_id":"\(conversationId)","account_id":"\(viewer)","personal_title":null,"version":1}}
        """
    }

    private static func member(_ accountId: String, _ name: String, role: String, state: String = "active") -> String {
        let leftAt = state == "active" ? "null" : "\"2026-11-18T10:00:00Z\""
        return """
        {"account_id":"\(accountId)","display_name":"\(name)","avatar_url":null,"role":"\(role)","membership_state":"\(state)","version":1,"last_delivered_sequence":1,"last_read_sequence":1,"joined_at":"2026-11-01T09:00:00Z","left_at":\(leftAt)}
        """
    }

    private static func event(_ sequence: Int, type: String, payload: String) -> String {
        """
        {"stream_seq":\(sequence),"event_id":"event-\(sequence)","protocol_version":2,"type":"\(type)","critical":true,"conversation_id":"\(conversationId)","entity_id":"\(conversationId)","entity_version":\(sequence),"occurred_at":"2026-11-18T10:00:00Z","payload":\(payload)}
        """
    }

    private static func page(_ events: [String], next: String) -> String {
        """
        {"protocol_version":2,"events":[\(events.joined(separator: ","))],"next_cursor":"\(next)","last_stream_seq":\(next),"has_more":false,"server_time":"2026-11-18T10:00:00Z"}
        """
    }
}
