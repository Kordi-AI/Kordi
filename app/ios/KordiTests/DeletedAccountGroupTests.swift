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

        XCTAssertEqual(
            CloudConversationCatalog.withoutDeletedAccounts(participants, conversation: partial, viewerAccountId: viewer).map(\.accountId),
            [viewer, gone]
        )
        XCTAssertEqual(
            CloudConversationCatalog.withoutDeletedAccounts(participants, conversation: nil, viewerAccountId: viewer).map(\.accountId),
            [viewer, gone]
        )
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
