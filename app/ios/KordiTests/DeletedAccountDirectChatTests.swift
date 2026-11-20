import XCTest
@testable import Kordi

/// Direct conversations kept after the other account was deleted
/// (docs/development/account-deletion.md#kept-direct-conversations-on-clients).
final class DeletedAccountDirectChatTests: XCTestCase {
    private typealias Fixture = DeletedDirectFixture

    // MARK: Detection

    func testDirectConversationWithoutThePeerRowIsKeptFromItsMemberList() throws {
        let beforeClose = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: false)
        let afterClose = try Fixture.decodeConversation(
            members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true
        )

        XCTAssertEqual(KordiDeletedAccount.peerAccountId(in: beforeClose), Fixture.gone)
        XCTAssertEqual(KordiDeletedAccount.peerAccountId(in: afterClose), Fixture.gone)
        XCTAssertTrue(KordiDeletedAccount.isKeptDirect(beforeClose))
        XCTAssertTrue(KordiDeletedAccount.isKeptDirect(afterClose))
        XCTAssertEqual(
            GroupClosedState.closedSessionIds(in: [beforeClose]), [Fixture.sessionId],
            "The chat is read-only from the new member list on, before the close arrives."
        )
    }

    func testOrdinaryConversationsAreNotKept() throws {
        let open = try Fixture.decodeConversation(members: [Fixture.viewerRow(), Fixture.peerRow()], closed: false)
        let peerLeft = try Fixture.decodeConversation(
            members: [Fixture.viewerRow(), Fixture.peerRow(state: "left")], closed: false
        )
        let withoutViewerRow = try Fixture.decodeConversation(members: [], closed: false)
        let group = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: false, kind: "group")

        for conversation in [open, peerLeft, withoutViewerRow, group] {
            XCTAssertNil(KordiDeletedAccount.peerAccountId(in: conversation))
            XCTAssertFalse(KordiDeletedAccount.isKeptDirect(conversation))
        }
        XCTAssertTrue(GroupClosedState.closedSessionIds(in: [open, peerLeft, withoutViewerRow, group]).isEmpty)
    }

    /// A person's own deletion empties the direct conversation: their row goes,
    /// every message goes, and the other person's row becomes `removed`. The
    /// server keeps its message count, and the phone may still hold old copies.
    func testEmptiedConversationIsNeverAKeptChat() throws {
        let emptied = try Fixture.decodeConversation(
            members: [Fixture.viewerRow(state: "removed")], closed: false, latestSequence: 3
        )
        let emptiedAfterAClose = try Fixture.decodeConversation(
            members: [Fixture.viewerRow(state: "removed"), Fixture.standInRow()], closed: true, latestSequence: 3
        )

        for conversation in [emptied, emptiedAfterAClose] {
            XCTAssertNil(KordiDeletedAccount.peerAccountId(in: conversation))
            XCTAssertFalse(KordiDeletedAccount.isKeptDirect(conversation))
            XCTAssertTrue(KordiDeletedAccount.keptDirectConversations(
                in: [conversation], viewerAccountId: Fixture.viewer
            ).isEmpty)
            let catalog = CloudConversationCatalog.build(
                account: Fixture.account, contacts: [], ownedAgents: [], sharedAgents: [],
                messagesByPeer: [Fixture.gone: Fixture.keptMessages], canonicalConversations: [conversation]
            )
            XCTAssertFalse(catalog.contains { $0.peerAccountId == Fixture.gone }, "Stale copies list nothing.")
            XCTAssertFalse(catalog.contains { $0.sessionId == Fixture.sessionId })
        }
        XCTAssertTrue(GroupClosedState.closedSessionIds(in: [emptied]).isEmpty)
    }

    /// `membership.removed` carries no conversation snapshot: the client drops
    /// its copy and deletes the session, so the kept chat and its stale
    /// messages leave the list.
    func testKeptChatLeavesTheListWhenTheViewerIsRemoved() async throws {
        let client = Fixture.client(protocolClass: DeletedDirectURLProtocol.self)
        await client.activateAccount(Fixture.viewer)
        _ = try await client.bootstrapChatLatestMessages(token: "synthetic")
        let kept = await client.cachedChatConversations()
        XCTAssertEqual(KordiDeletedAccount.keptDirectConversations(in: kept, viewerAccountId: Fixture.viewer).count, 1)

        let response = try await client.sync(token: "synthetic", cursor: "1")

        let deleted = try XCTUnwrap(response.events.first { $0.eventType == "session.deleted" })
        XCTAssertEqual(deleted.payload?.sessionId, Fixture.sessionId)
        let remaining = await client.cachedChatConversations()
        XCTAssertTrue(remaining.isEmpty)
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [Fixture.gone: Fixture.keptMessages], canonicalConversations: remaining
        )
        XCTAssertFalse(catalog.contains { $0.peerAccountId == Fixture.gone })

        // A snapshot that still arrives with the viewer removed lists nothing either.
        let removedSnapshot = try Fixture.decodeConversation(
            members: [Fixture.viewerRow(state: "removed"), Fixture.standInRow()], closed: true
        )
        let fromSnapshot = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [Fixture.gone: Fixture.keptMessages], canonicalConversations: [removedSnapshot]
        )
        XCTAssertFalse(fromSnapshot.contains { $0.peerAccountId == Fixture.gone })
    }

    // MARK: Chat list

    func testKeptConversationStaysInTheChatListAsTheDeletedAccount() throws {
        let kept = try Fixture.decodeConversation(members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true)
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account,
            contacts: [Fixture.contact(Fixture.lee, name: "Lee Example")],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                Fixture.gone: Fixture.keptMessages,
                Fixture.lee: [Fixture.wire("lee-1", from: Fixture.lee, to: Fixture.viewer, text: "Earlier",
                    session: directPersonSessionId(Fixture.viewer, Fixture.lee), minute: 1)],
            ],
            canonicalConversations: [kept]
        )
        let people = catalog.filter { $0.kind == .person }
        let row = try XCTUnwrap(people.first { $0.peerAccountId == Fixture.gone })

        XCTAssertEqual(row.id, "person:\(Fixture.gone)", "The chat keeps its id, so local copies stay attached.")
        XCTAssertEqual(row.sessionId, Fixture.sessionId)
        XCTAssertEqual(row.displayName, "Deleted account")
        XCTAssertTrue(row.peerAccountDeleted)
        XCTAssertNil(row.avatarSource)
        XCTAssertEqual(row.avatarSeed, KordiDeletedAccount.accountId)
        XCTAssertEqual(row.peerAvatarSeed, KordiDeletedAccount.accountId)
        XCTAssertEqual(row.lastMessage, "See you soon")
        XCTAssertEqual(people.map(\.peerAccountId), [Fixture.gone, Fixture.lee], "Placed by recency.")
    }

    func testKeptConversationReplacesAContactEntryNotYetRemoved() throws {
        let kept = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: false)
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account,
            contacts: [Fixture.contact(Fixture.gone, name: "Dana Sample")],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [Fixture.gone: Fixture.keptMessages],
            canonicalConversations: [kept]
        )
        let rows = catalog.filter { $0.peerAccountId == Fixture.gone }

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.displayName, "Deleted account")
        XCTAssertFalse(catalog.contains { $0.displayName == "Dana Sample" })
    }

    func testKeptConversationNobodyWroteInIsNotListed() throws {
        let empty = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: true, latestSequence: 0)
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [:], canonicalConversations: [empty]
        )
        XCTAssertFalse(catalog.contains { $0.peerAccountId == Fixture.gone })
    }

    func testTheOtherSideIsAttributedToTheDeletedAccount() throws {
        let row = try Fixture.keptRow()
        let messages = CloudDirectMessageProjector.project(
            Fixture.keptMessages, conversation: row, ownAccountId: Fixture.viewer
        )
        let incoming = try XCTUnwrap(messages.first { $0.id == "dana-1" })
        let outgoing = try XCTUnwrap(messages.first { $0.id == "rowan-1" })

        XCTAssertEqual(messages.count, 2, "Both sides' messages stay in the chat.")
        XCTAssertEqual(incoming.authorName, "Deleted account")
        XCTAssertEqual(outgoing.author, .me)
        let identity = MessageAuthorIdentity.resolve(incoming, in: row, account: Fixture.account, mentionTargets: [])
        XCTAssertEqual(identity.seed, KordiDeletedAccount.accountId)
    }

    // MARK: Contacts and pickers

    func testKeptConversationIsInNoPeoplePicker() throws {
        let row = try Fixture.keptRow()
        let lee = ConversationSummary(
            id: "person:\(Fixture.lee)", kind: .person, peerAccountId: Fixture.lee, agentId: nil,
            ownerDisplayName: "Lee Example", displayName: "Lee Example", lastMessage: "",
            lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: directPersonSessionId(Fixture.viewer, Fixture.lee)
        )

        XCTAssertFalse(row.isPickablePerson)
        XCTAssertTrue(lee.isPickablePerson)
        let destinations = MessageForwardCatalog.build(
            conversations: [row, lee], contacts: [], ownAccountID: Fixture.viewer
        )
        XCTAssertEqual(destinations.map(\.conversation.id), [lee.id])
    }

    func testKeptConversationNeverBecomesAContact() throws {
        let kept = try Fixture.decodeConversation(members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true)
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [Fixture.gone: Fixture.keptMessages], canonicalConversations: [kept]
        )

        XCTAssertFalse(catalog.contains { KordiDeletedAccount.isStandIn($0.peerAccountId) })
        XCTAssertEqual(catalog.filter(\.isPickablePerson).count, 0)
    }

    // MARK: Read-only composer

    func testComposerIsReplacedByTheDeletedAccountLine() throws {
        let row = try Fixture.keptRow()
        let notice = ClosedConversationNotice(conversation: row) { true }

        XCTAssertEqual(notice, .accountDeleted)
        XCTAssertEqual(notice.line, "This account was deleted.")
        XCTAssertFalse(notice.offersDelete)
    }

    func testClosedGroupsKeepTheirWording() {
        let group = ConversationSummary(
            id: "group:session:group:space", kind: .group, peerAccountId: Fixture.lee, agentId: nil,
            ownerDisplayName: "Planning", displayName: "Channel 1", lastMessage: "",
            lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: "session:group:space"
        )

        XCTAssertEqual(ClosedConversationNotice(conversation: group) { true }.line, "This group was closed")
        XCTAssertEqual(ClosedConversationNotice(conversation: group) { false }.line, "This channel was closed")
        XCTAssertTrue(ClosedConversationNotice(conversation: group) { true }.offersDelete)
    }

    @MainActor
    func testRefusedWriteSaysTheAccountWasDeleted() throws {
        let kept = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: true)
        let group = try Fixture.decodeConversation(members: [Fixture.viewerRow()], closed: true, kind: "group")
        let refused = CloudAPIError(code: "group_closed", message: "This group was closed.", statusCode: 409)
        let model = AppModel(previewMode: true, previewLaunchFlow: false)

        let rewritten = KordiDeletedAccount.refusal(refused, in: kept)
        XCTAssertEqual(rewritten.code, "group_closed", "Closed handling still applies.")
        XCTAssertTrue(GroupClosedState.isClosedError(rewritten))
        XCTAssertEqual(model.userFacing(rewritten, fallback: "Message not sent."), "This account was deleted.")

        let groupRefusal = KordiDeletedAccount.refusal(refused, in: group)
        XCTAssertEqual(model.userFacing(groupRefusal, fallback: "Message not sent."), "This group was closed.")
        XCTAssertEqual(
            KordiDeletedAccount.conversationId(inRequestPath: "/v2/chat/conversations/\(Fixture.conversationId)/messages"),
            Fixture.conversationId
        )
        XCTAssertNil(KordiDeletedAccount.conversationId(inRequestPath: "/v2/chat/sync"))
    }

    func testRefusedRequestToAKeptConversationIsRewrittenByTheClient() async throws {
        let client = Fixture.client(protocolClass: DeletedDirectURLProtocol.self)
        await client.activateAccount(Fixture.viewer)
        _ = try await client.bootstrapChatLatestMessages(token: "synthetic")

        do {
            try await client.sendWithoutResponse(
                path: "/v2/chat/conversations/\(Fixture.conversationId)/messages",
                method: "POST",
                token: "synthetic",
                fallback: "Message not sent."
            )
            XCTFail("The write should be refused.")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "group_closed")
            XCTAssertEqual(error.message, "This account was deleted.")
        }
    }

    // MARK: Profile

    @MainActor
    func testDeletedAccountOpensNoProfile() throws {
        let row = try Fixture.keptRow()
        let incoming = try XCTUnwrap(CloudDirectMessageProjector.project(
            Fixture.keptMessages, conversation: row, ownAccountId: Fixture.viewer
        ).first { $0.id == "dana-1" })
        let group = ConversationSummary(
            id: "group:session:group:space", kind: .group, peerAccountId: Fixture.lee, agentId: nil,
            ownerDisplayName: "Planning", displayName: "Channel 1", lastMessage: "",
            lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: "session:group:space"
        )
        let standIn = CloudGroupParticipant(
            accountId: KordiDeletedAccount.accountId, displayName: "Deleted account", avatarUrl: nil, role: "member"
        )
        let formerMember = CloudGroupParticipant(
            accountId: Fixture.gone, displayName: "Deleted account", avatarUrl: nil, role: "member"
        )

        XCTAssertFalse(ConversationDetailsPage.showsContactProfile(for: row))
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: row, message: incoming, selfAccountID: Fixture.viewer,
            contacts: [], conversations: [row]
        ))
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: group, participant: standIn, selfAccountID: Fixture.viewer,
            contacts: [], conversations: [row]
        ))
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: group, participant: formerMember, selfAccountID: Fixture.viewer,
            contacts: [], conversations: [row]
        ))

        // Even when asked, the stand-in's profile is never requested.
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let profile = model.makeContactProfileModel(for: ContactProfileSubject(
            accountId: KordiDeletedAccount.accountId, name: "Deleted account"
        ))
        XCTAssertFalse(profile.isLoading)
        XCTAssertTrue(profile.isFallback)
        XCTAssertFalse(profile.canDelete)
    }

    // MARK: Live order

    /// `membership.updated`, then `message.updated`, then `conversation.updated`
    /// with the close, as the server sends them from one transaction.
    func testDeletionWhileRunningSwitchesTheChatInEventOrder() async throws {
        let client = Fixture.client(protocolClass: DeletedDirectLiveURLProtocol.self)
        await client.activateAccount(Fixture.viewer)

        let before = try await client.bootstrapChatLatestMessages(token: "synthetic")
        XCTAssertEqual(before.first?.fromAccountId, Fixture.gone)
        let open = await client.cachedChatConversations()
        XCTAssertTrue(GroupClosedState.closedSessionIds(in: open).isEmpty)

        _ = try await client.sync(token: "synthetic", cursor: "1")
        let afterMembers = await client.cachedChatConversations()
        XCTAssertEqual(GroupClosedState.closedSessionIds(in: afterMembers), [Fixture.sessionId])
        let early = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [Fixture.contact(Fixture.gone, name: "Dana Sample")],
            ownedAgents: [], sharedAgents: [], messagesByPeer: [Fixture.gone: before],
            canonicalConversations: afterMembers
        )
        XCTAssertEqual(early.first { $0.peerAccountId == Fixture.gone }?.displayName, "Deleted account")

        let response = try await client.sync(token: "synthetic", cursor: "2")
        let upsert = try XCTUnwrap(response.events.first { $0.eventType == "message.upsert" })
        XCTAssertEqual(upsert.peerAccountId, Fixture.gone, "The stand-in's message stays in the same chat.")
        XCTAssertEqual(upsert.payload?.message?.fromAccountId, Fixture.gone)
        XCTAssertEqual(upsert.payload?.message?.sessionId, Fixture.sessionId)
        let afterClose = await client.cachedChatConversations()
        XCTAssertEqual(afterClose.count, 1)
        XCTAssertEqual(afterClose.first?.closed?.closedByAccountId, KordiDeletedAccount.accountId)
        XCTAssertEqual(GroupClosedState.closedSessionIds(in: afterClose), [Fixture.sessionId])
    }

    // MARK: Local copy

    @MainActor
    func testCachedChatKeepsTheDeletedAccountMark() throws {
        let cache = try LocalMessageStore(inMemory: true)
        let row = try Fixture.keptRow()

        cache.saveConversations([row], accountId: Fixture.viewer)

        let restored = try XCTUnwrap(cache.loadConversations(accountId: Fixture.viewer).first)
        XCTAssertTrue(restored.peerAccountDeleted)
        XCTAssertEqual(restored.id, row.id)
        XCTAssertEqual(restored.sessionId, row.sessionId)
    }

    // MARK: Calls

    func testDetailsOfAKeptChatOfferNoCall() throws {
        let row = try Fixture.keptRow()
        let lee = ConversationSummary(
            id: "person:\(Fixture.lee)", kind: .person, peerAccountId: Fixture.lee, agentId: nil,
            ownerDisplayName: "Lee Example", displayName: "Lee Example", lastMessage: "",
            lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: directPersonSessionId(Fixture.viewer, Fixture.lee)
        )

        XCTAssertEqual(SessionHeroAction.items(for: row), [.mute, .chat])
        XCTAssertEqual(SessionHeroAction.items(for: lee), [.call, .video, .mute, .chat])
    }

    @MainActor
    func testNoCallStartsInAKeptChat() async throws {
        let row = try Fixture.keptRow()
        let calls = KordiCallCoordinator()

        await calls.start(conversation: row, kind: .voice)

        XCTAssertNil(calls.activeCall)
        XCTAssertFalse(calls.isStartingCall)
        XCTAssertEqual(calls.phase, .failed("This account was deleted."))
    }

    // MARK: Sender

    func testTheDeletedSenderIsAPictureNotAProfileButton() throws {
        let row = try Fixture.keptRow()
        let messages = CloudDirectMessageProjector.project(
            Fixture.keptMessages, conversation: row, ownAccountId: Fixture.viewer
        )
        let incoming = try XCTUnwrap(messages.first { $0.id == "dana-1" })
        let outgoing = try XCTUnwrap(messages.first { $0.id == "rowan-1" })

        XCTAssertTrue(MessageAuthorIdentity.isDeletedAccount(incoming, in: row))
        XCTAssertFalse(MessageAuthorIdentity.isDeletedAccount(outgoing, in: row))
        XCTAssertEqual(
            MessageAuthorIdentity.resolve(incoming, in: row, account: Fixture.account, mentionTargets: []),
            MessageAuthorIdentity.deletedAccount
        )
    }

    func testTheStandInSpeaksAsTheDeletedAccountInAGroup() {
        func makeGroup(_ participants: [CloudGroupParticipant]) -> ConversationSummary {
            ConversationSummary(
                id: "group:session:group:space", kind: .group, peerAccountId: Fixture.lee, agentId: nil,
                ownerDisplayName: "Planning", displayName: "Channel 1", lastMessage: "",
                lastActivityAt: .distantPast, unreadCount: 0, avatarSource: "kordi-avatar://group",
                agentActivity: nil, sessionId: "session:group:space", groupParticipants: participants
            )
        }
        let members = [
            CloudGroupParticipant(accountId: Fixture.viewer, displayName: "Rowan Sample", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: Fixture.lee, displayName: "Lee Example", avatarUrl: nil, role: "owner"),
        ]
        let group = makeGroup(members)
        let scrubbed = ChatMessage(
            id: "group-1", conversationId: group.id, author: .person, authorName: "Deleted account",
            text: "Earlier plan", createdAt: Date(timeIntervalSince1970: 1), deliveryState: .read,
            errorMessage: nil, requestMessageId: nil
        )
        let lee = ChatMessage(
            id: "group-2", conversationId: group.id, author: .person, authorName: "Lee Example",
            text: "Thanks", createdAt: Date(timeIntervalSince1970: 2), deliveryState: .read,
            errorMessage: nil, requestMessageId: nil
        )

        XCTAssertTrue(MessageAuthorIdentity.isDeletedAccount(scrubbed, in: group))
        XCTAssertFalse(MessageAuthorIdentity.isDeletedAccount(lee, in: group))
        // Not the group's own name and picture.
        XCTAssertEqual(
            MessageAuthorIdentity.resolve(scrubbed, in: group, account: Fixture.account, mentionTargets: []),
            MessageAuthorIdentity.deletedAccount
        )
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: group, message: scrubbed, selfAccountID: Fixture.viewer, contacts: [], conversations: []
        ))
        // A message without an envelope names its sender by account.
        XCTAssertEqual(KordiSystemIdentity.groupAuthorName(
            messageKind: "text", fromAccountId: KordiDeletedAccount.accountId,
            participantNames: [Fixture.lee: "Lee Example"], fallback: "Channel 1"
        ), "Deleted account")

        // A member who chose that name is still that member.
        let namesake = makeGroup(members + [
            CloudGroupParticipant(accountId: "acct_sky", displayName: "Deleted account", avatarUrl: nil, role: "member"),
        ])
        XCTAssertFalse(MessageAuthorIdentity.isDeletedAccount(scrubbed, in: namesake))
    }

    // MARK: Quotes

    /// The server stores Deleted account as a quote's `senderLabel` and keeps
    /// its `sourceSessionId`, so the quote names the stand-in, never a cached
    /// contact name, and jumps within the same chat.
    func testQuoteOfTheDeletedPersonShowsTheStoredLabelAndStaysInTheChat() throws {
        let kept = try Fixture.decodeConversation(members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true)
        let source = MessageActionSource(
            sourceSessionId: Fixture.sessionId,
            sourceMessageId: "dana-1",
            senderLabel: "Deleted account",
            textPreview: "Hello",
            attachmentCount: 0
        )
        let quoteBody = try CloudMessageCodec.encodeDirect(
            text: "Agreed", agentId: nil, agentName: nil, ownerAccountId: nil, ownerName: nil,
            messageAction: .quote(source)
        )
        let messages = Fixture.keptMessages + [
            Fixture.wire("rowan-quote", from: Fixture.viewer, to: Fixture.gone, text: quoteBody, session: Fixture.sessionId, minute: 4),
        ]
        // A contact entry under the old name has not been removed yet.
        let catalog = CloudConversationCatalog.build(
            account: Fixture.account, contacts: [Fixture.contact(Fixture.gone, name: "Dana Sample")],
            ownedAgents: [], sharedAgents: [], messagesByPeer: [Fixture.gone: messages], canonicalConversations: [kept]
        )
        let row = try XCTUnwrap(catalog.first { $0.peerAccountId == Fixture.gone })
        let projected = CloudDirectMessageProjector.project(messages, conversation: row, ownAccountId: Fixture.viewer)
        let quote = try XCTUnwrap(projected.first { $0.id == "rowan-quote" }?.messageAction)

        XCTAssertEqual(quote.kind, "quote")
        XCTAssertEqual(quote.source.senderLabel, "Deleted account")
        XCTAssertEqual(MessageQuotePresentation.senderLabel(quote.source.senderLabel, selfDisplayName: "Rowan Sample"), "Deleted account")
        XCTAssertEqual(quote.source.sourceSessionId, row.sessionId, "The reference names this chat.")
        let quoted = try XCTUnwrap(MessageReferenceIndex(messages: projected).message(for: quote.source.sourceMessageId))
        XCTAssertEqual(quoted.id, "dana-1")
        XCTAssertEqual(quoted.authorName, "Deleted account")
        XCTAssertFalse(projected.contains { $0.authorName == "Dana Sample" })
    }
}

private enum DeletedDirectFixture {
    static let viewer = "acct_rowan"
    static let gone = "acct_dana"
    static let lee = "acct_lee"
    static let conversationId = "conversation-direct-dana"
    static let sessionId = "session:direct-person:acct_dana:acct_rowan"

    static let account: CloudAccount = {
        let avatar = CanonicalAvatarDescriptor(
            entityType: "human", entityId: viewer, source: "generated",
            style: CanonicalAvatarSystem.humanStyle, seed: viewer,
            rendererVersion: CanonicalAvatarSystem.rendererVersion, uploadedAsset: nil,
            version: 1, updatedAt: "2026-11-01T00:00:00Z"
        )
        return CloudAccount(accountId: viewer, kordiId: nil, displayName: "Rowan Sample",
            primaryEmail: "rowan@example.test", avatarUrl: nil, avatar: avatar, nodeId: nil, passwordSet: true)
    }()

    static func contact(_ accountId: String, name: String) -> CloudContact {
        CloudContact(accountId: accountId, kordiId: nil, displayName: name,
            avatarUrl: nil, nodeId: nil, createdAt: "2026-11-01T00:00:00Z")
    }

    static func wire(
        _ id: String, from: String, to: String, text: String, session: String, minute: Int
    ) -> CloudMessageDTO {
        CloudMessageDTO(messageId: id, fromAccountId: from, toAccountId: to, body: text,
            createdAt: String(format: "2026-11-18T09:%02d:00Z", minute), deliveredAt: nil, readAt: nil,
            direction: from == viewer ? "outgoing" : "incoming", sessionId: session, attachments: [],
            conversationId: conversationId, conversationSequence: Int64(minute))
    }

    /// Both sides, keyed by the deleted account as the client keys them.
    static let keptMessages = [
        wire("dana-1", from: gone, to: viewer, text: "Hello", session: sessionId, minute: 2),
        wire("rowan-1", from: viewer, to: gone, text: "See you soon", session: sessionId, minute: 3),
    ]

    static func keptRow() throws -> ConversationSummary {
        let kept = try decodeConversation(members: [viewerRow(), standInRow()], closed: true)
        let catalog = CloudConversationCatalog.build(
            account: account, contacts: [], ownedAgents: [], sharedAgents: [],
            messagesByPeer: [gone: keptMessages], canonicalConversations: [kept]
        )
        return try XCTUnwrap(catalog.first { $0.peerAccountId == gone })
    }

    static func viewerRow(state: String = "active") -> String { member(viewer, name: "Rowan Sample", state: state) }
    static func peerRow(state: String = "active") -> String { member(gone, name: "Dana Sample", state: state) }
    static func standInRow() -> String { member(KordiDeletedAccount.accountId, name: "Deleted account", state: "left") }

    static func member(_ accountId: String, name: String, state: String = "active") -> String {
        let leftAt = state == "active" ? "null" : "\"2026-11-18T10:00:00Z\""
        return """
        {"account_id":"\(accountId)","display_name":"\(name)","avatar_url":null,"role":"member","membership_state":"\(state)","version":1,"last_delivered_sequence":3,"last_read_sequence":3,"joined_at":"2026-11-01T09:00:00Z","left_at":\(leftAt)}
        """
    }

    static func conversation(
        members: [String],
        closed: Bool,
        kind: String = "direct",
        version: Int = 1,
        latestSequence: Int64 = 3
    ) -> String {
        let closedField = closed
            ? #","closed":{"closed_at":"2026-11-18T10:00:00Z","closed_by_account_id":"acct_kordi_deleted"}"#
            : ""
        return """
        {"id":"\(conversationId)","kind":"\(kind)","shared_title":null,"version":\(version),"created_by_account_id":"\(gone)","legacy_session_id":"\(sessionId)"\(closedField),"forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":\(latestSequence),"created_at":"2026-11-01T09:00:00Z","updated_at":"2026-11-18T10:00:00Z","members":[\(members.joined(separator: ","))],"preferences":{"conversation_id":"\(conversationId)","account_id":"\(viewer)","personal_title":null,"version":1}}
        """
    }

    static func decodeConversation(
        members: [String],
        closed: Bool,
        kind: String = "direct",
        latestSequence: Int64 = 3
    ) throws -> CloudChatConversation {
        try JSONDecoder().decode(
            CloudChatConversation.self,
            from: Data(conversation(members: members, closed: closed, kind: kind, latestSequence: latestSequence).utf8)
        )
    }

    static func message(_ id: String, sender: String, text: String, sequence: Int, version: Int = 1) -> String {
        """
        {"id":"\(id)","client_message_id":"client-\(id)","conversation_id":"\(conversationId)","conversation_sequence":\(sequence),"sender_account_id":"\(sender)","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"\(text)"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":\(version),"generation_status":null,"provider_response_id":null,"created_at":"2026-11-18T09:0\(sequence):00Z","edited_at":null,"deleted_at":null}
        """
    }

    static func bootstrap(conversation: String, latest: String) -> String {
        """
        {"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[\(conversation)],"latest_messages":[\(latest)],"next_cursor":"1","last_stream_seq":1,"server_time":"2026-11-18T09:30:00Z"}
        """
    }

    static func event(_ sequence: Int, type: String, payload: String) -> String {
        """
        {"stream_seq":\(sequence),"event_id":"event-\(sequence)","protocol_version":2,"type":"\(type)","critical":true,"conversation_id":"\(conversationId)","entity_id":"\(conversationId)","entity_version":\(sequence),"occurred_at":"2026-11-18T10:00:00Z","payload":\(payload)}
        """
    }

    static func syncPage(_ events: [String], nextCursor: String) -> String {
        """
        {"protocol_version":2,"events":[\(events.joined(separator: ","))],"next_cursor":"\(nextCursor)","last_stream_seq":\(nextCursor),"has_more":false,"server_time":"2026-11-18T10:00:00Z"}
        """
    }

    static func client(protocolClass: URLProtocol.Type) -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
    }

    static func respond(to urlProtocol: URLProtocol, status: Int, body: String) {
        let response = HTTPURLResponse(
            url: urlProtocol.request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        urlProtocol.client?.urlProtocol(urlProtocol, didReceive: response, cacheStoragePolicy: .notAllowed)
        urlProtocol.client?.urlProtocol(urlProtocol, didLoad: Data(body.utf8))
        urlProtocol.client?.urlProtocolDidFinishLoading(urlProtocol)
    }
}

/// A kept conversation, closed; every write to it is refused as a closed
/// group's. The next sync page removes the viewer, as the server's
/// `membership.removed` does: ids only, no conversation snapshot.
private final class DeletedDirectURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        typealias Fixture = DeletedDirectFixture
        if request.httpMethod == "POST" {
            Fixture.respond(to: self, status: 409, body: #"{"error":{"code":"group_closed","message":"This group was closed."}}"#)
            return
        }
        if request.url?.path.hasSuffix("/v2/chat/sync") == true {
            let removed = #"{"conversation_id":"\#(Fixture.conversationId)","account_id":"\#(Fixture.viewer)","membership_state":"removed","version":5}"#
            Fixture.respond(to: self, status: 200, body: Fixture.syncPage([
                Fixture.event(2, type: "membership.removed", payload: removed),
            ], nextCursor: "2"))
            return
        }
        let kept = Fixture.conversation(
            members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true, version: 4
        )
        Fixture.respond(to: self, status: 200, body: Fixture.bootstrap(
            conversation: kept,
            latest: Fixture.message("message-3", sender: Fixture.viewer, text: "See you soon", sequence: 3)
        ))
    }

    override func stopLoading() {}
}

/// An open direct conversation, then the deletion's three events over two sync pages.
private final class DeletedDirectLiveURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        typealias Fixture = DeletedDirectFixture
        let url = request.url!
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "cursor" }?.value
        let body: String
        if url.path.hasSuffix("/sync/bootstrap") {
            body = Fixture.bootstrap(
                conversation: Fixture.conversation(members: [Fixture.viewerRow(), Fixture.peerRow()], closed: false),
                latest: Fixture.message("message-2", sender: Fixture.gone, text: "Hello", sequence: 2)
            )
        } else if cursor == "1" {
            let members = Fixture.conversation(
                members: [Fixture.viewerRow(), Fixture.standInRow()], closed: false, version: 2
            )
            body = Fixture.syncPage([
                Fixture.event(2, type: "membership.updated", payload: #"{"conversation":\#(members)}"#),
            ], nextCursor: "2")
        } else {
            let members = Fixture.conversation(
                members: [Fixture.viewerRow(), Fixture.standInRow()], closed: false, version: 2
            )
            let closed = Fixture.conversation(
                members: [Fixture.viewerRow(), Fixture.standInRow()], closed: true, version: 3
            )
            let moved = Fixture.message(
                "message-2", sender: KordiDeletedAccount.accountId, text: "Hello", sequence: 2, version: 2
            )
            body = Fixture.syncPage([
                Fixture.event(3, type: "message.updated", payload: #"{"conversation":\#(members),"message":\#(moved)}"#),
                Fixture.event(4, type: "conversation.updated", payload: #"{"conversation":\#(closed)}"#),
            ], nextCursor: "4")
        }
        Fixture.respond(to: self, status: 200, body: body)
    }

    override func stopLoading() {}
}
