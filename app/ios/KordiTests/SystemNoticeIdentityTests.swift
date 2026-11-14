import XCTest
@testable import Kordi

final class SystemNoticeIdentityTests: XCTestCase {
    func testFacilitatorAssignmentSurvivesCacheRoundTripAndLateSnapshot() throws {
        func wire(result: String, revision: Int) throws -> CloudMessageDTO {
            let payload = """
            {"type":"facilitator_card","kind":"task","cardId":"06a0b648-f091-4102-8a45-7bb30f40292d",
             "title":"Create the CSV checklist","detail":"Attach the Markdown document.",
             "revision":\(revision),"result":"\(result)","options":null,"counts":[],
             "managerIds":["acct_me"],"assigneeId":"acct_me","assigneeName":"Alex"}
            """
            let decoder = JSONDecoder()
            let block = try decoder.decode(CloudChatBlock.self, from: Data(payload.utf8))
            let restored = try decoder.decode(CloudChatBlock.self, from: JSONEncoder().encode(block))
            var message = makeWire(id: "assignment", kind: "system-notice", body: "Create the CSV checklist", version: revision)
            message.facilitatorCard = try XCTUnwrap(restored.facilitatorCard)
            return try decoder.decode(CloudMessageDTO.self, from: JSONEncoder().encode(message))
        }

        let pending = try wire(result: "pending", revision: 1)
        XCTAssertEqual(pending.facilitatorCard?.options, [])
        XCTAssertEqual(pending.facilitatorCard?.canApprove(accountId: "acct_me"), true)
        XCTAssertEqual(pending.facilitatorCard?.canApprove(accountId: "acct_maya"), false)
        let completed = try wire(result: "done", revision: 4)
        let messages = AppModel.mapGroupMessages([completed, pending], conversation: makeGroup(), ownAccountId: "acct_me")
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.authorName, "Facilitator")
        XCTAssertEqual(messages.first?.facilitatorCard?.status, "Completed")
        XCTAssertEqual(messages.first?.facilitatorCard?.canApprove(accountId: "acct_me"), false)
    }

    func testFacilitatorReplyKeepsOneSlotAndItsDocumentOnRefresh() throws {
        let group = makeGroup()
        let facilitator = CloudGroupParticipant(
            accountId: KordiSystemAgentIdentity.accountId, displayName: "Facilitator", avatarUrl: nil, role: "member"
        )
        let owner = group.groupParticipants[0]
        let handoff = "facilitator-handoff:assignment"
        func wire(id: String, actor: CloudGroupParticipant, request: String?, state: String?, version: Int,
                  attachments: [CloudMessageAttachment] = []) throws -> CloudMessageDTO {
            let envelope = CloudGroupControlEnvelope(
                kind: "group-message", groupId: group.sessionId, groupSpaceId: group.groupSpaceId,
                groupTitle: group.displayName, createdByAccountId: owner.accountId, actor: actor,
                participants: group.groupParticipants + [facilitator], message: CloudGroupMessagePayload(
                    id: id, senderAccountId: actor.accountId,
                    text: state == "complete" ? "The checklist is attached." : "", createdAtMs: 1_000,
                    senderKind: "agent", senderDisplayName: "Kordi", deliveryState: state,
                    replyToMessageId: request, requestId: request
                )
            )
            return CloudMessageDTO(messageId: id, fromAccountId: actor.accountId, toAccountId: "acct_maya",
                body: try CloudGroupMessageCodec.encode(envelope), createdAt: "2026-11-11T22:00:00Z",
                deliveredAt: nil, readAt: nil, direction: "incoming", sessionId: group.sessionId,
                attachments: attachments, version: version)
        }
        let request = try wire(id: handoff, actor: facilitator, request: nil, state: nil, version: 1)
        let queued = try wire(id: "reply", actor: owner, request: handoff, state: "queued", version: 1)
        let working = try wire(id: "reply", actor: owner, request: handoff, state: "processing", version: 2)
        let attachment = CloudMessageAttachment(attachmentId: "csv", name: "CSV Checklist.md", kind: "file",
            mimeType: "text/markdown", sizeBytes: 240, downloadUrl: nil, previewUrl: nil)
        let completed = try wire(id: "reply", actor: owner, request: handoff, state: "complete", version: 3,
                                 attachments: [attachment])
        XCTAssertEqual(AppModel.mapGroupMessages([queued], conversation: group, ownAccountId: "acct_maya").first?.agentExecution?.progressLabel, "Queued")
        XCTAssertEqual(AppModel.mapGroupMessages([working, queued], conversation: group, ownAccountId: "acct_maya").first?.agentExecution?.progressLabel, "Working")
        let refreshed = AppModel.mapGroupMessages([completed, request, working, queued], conversation: group, ownAccountId: "acct_maya")
        XCTAssertEqual(refreshed.count, 2)
        XCTAssertEqual(refreshed.first { $0.id == handoff }?.authorName, "Facilitator")
        let reply = try XCTUnwrap(refreshed.first { $0.id == "reply" })
        XCTAssertEqual(reply.replyToMessageId, handoff)
        XCTAssertNil(reply.agentExecution)
        XCTAssertEqual(reply.attachments.first?.name, "CSV Checklist.md")
    }

    func testFacilitatorWorkingRowBecomesItsReplyInPlace() throws {
        // Bea asks "@Facilitator hi"; the server shows the Facilitator's reply
        // row working, then edits it in place into the reply.
        let group = makeGroup()
        let owner = group.groupParticipants[0]
        func row(state: String, text: String, version: Int) throws -> CloudMessageDTO {
            let envelope = CloudGroupControlEnvelope(
                kind: "group-message", groupId: group.sessionId, groupSpaceId: group.groupSpaceId,
                groupTitle: group.displayName, createdByAccountId: owner.accountId, actor: owner,
                participants: group.groupParticipants, message: CloudGroupMessagePayload(
                    id: "facilitator-reply:request", senderAccountId: KordiSystemAgentIdentity.accountId,
                    text: text, createdAtMs: 1_000, senderKind: "agent", senderDisplayName: "Facilitator",
                    deliveryState: state, replyToMessageId: "request", requestId: "request"
                )
            )
            return CloudMessageDTO(messageId: "facilitator-row", fromAccountId: KordiSystemAgentIdentity.accountId,
                toAccountId: "acct_maya", body: try CloudGroupMessageCodec.encode(envelope),
                createdAt: "2026-11-13T10:00:00Z", deliveredAt: nil, readAt: nil, direction: "incoming",
                sessionId: group.sessionId, version: version)
        }
        let working = try row(state: "processing", text: "", version: 1)
        let shown = try XCTUnwrap(AppModel.mapGroupMessages([working], conversation: group, ownAccountId: "acct_maya").first)
        XCTAssertEqual(shown.author, .agent)
        XCTAssertEqual(shown.authorName, "Facilitator")
        XCTAssertEqual(shown.agentExecution?.progressLabel, "Working")
        XCTAssertEqual(MessageAuthorIdentity.resolve(shown, in: group, account: nil, mentionTargets: []),
                       KordiSystemAgentIdentity.avatar)

        let replied = try row(state: "complete", text: "Hi! I can find a time or open a vote.", version: 2)
        let refreshed = AppModel.mapGroupMessages([replied, working], conversation: group, ownAccountId: "acct_maya")
        XCTAssertEqual(refreshed.count, 1, "the reply takes the working row")
        XCTAssertEqual(refreshed.first?.text, "Hi! I can find a time or open a vote.")
        XCTAssertEqual(refreshed.first?.authorName, "Facilitator")
        XCTAssertNil(refreshed.first?.agentExecution)

        // The person who asked sees the working row too, even while their own
        // message still says sending.
        let ask = ChatMessage(
            id: "request", conversationId: group.id, author: .me, authorName: "You", text: "@Facilitator hi",
            createdAt: .distantPast, deliveryState: .sending, errorMessage: nil, requestMessageId: nil
        )
        XCTAssertEqual(shown.requestMessageId, ask.id)
        XCTAssertNotNil(shown.cloudMessageVersion)
        let asked = AgentSessionQueuePresentation.apply(to: [ask, shown], kind: .group)
        XCTAssertEqual(asked.map(\.id), [ask.id, shown.id])

        // A row the server removed (a card answered, or the run failed) is gone.
        let removed = CloudMessageDTO(messageId: "facilitator-row", fromAccountId: KordiSystemAgentIdentity.accountId,
            toAccountId: "acct_maya", body: "", createdAt: "2026-11-13T10:00:00Z", deliveredAt: nil, readAt: nil,
            direction: "incoming", sessionId: group.sessionId, version: 3)
        XCTAssertTrue(AppModel.mapGroupMessages([removed], conversation: group, ownAccountId: "acct_maya").isEmpty)
    }

    func testSystemNoticeFromSystemAgentProjectsAsSystem() throws {
        let conversation = makeGroup()
        let notice = makeWire(id: "notice", kind: KordiSystemIdentity.messageKind, body: "Maya joined.")
        let reply = makeWire(id: "reply", kind: nil, body: "Here is the plan.")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [notice, reply]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first { $0.id == "notice" })
        let systemAgentReply = try XCTUnwrap(projected.first { $0.id == "reply" })

        XCTAssertEqual(message.authorName, "Facilitator")
        XCTAssertEqual(message.text, "Maya joined.")
        XCTAssertFalse(message.isSystemNotice, "Notices keep the normal bubble layout")
        XCTAssertEqual(systemAgentReply.authorName, KordiSystemAgentIdentity.displayName)
        XCTAssertEqual(
            MessageAuthorIdentity.resolve(systemAgentReply, in: conversation, account: nil, mentionTargets: []),
            KordiSystemAgentIdentity.avatar
        )
    }

    func testSystemNoticeResolvesToSystemNotSystemAgent() {
        let conversation = makeGroup()
        let notice = ChatMessage(
            id: "notice", conversationId: conversation.id, author: .person, authorName: KordiSystemAgentIdentity.legacyName,
            text: "Welcome", createdAt: .distantPast, deliveryState: .sent, errorMessage: nil,
            requestMessageId: nil, messageKind: KordiSystemIdentity.messageKind
        )

        let identity = MessageAuthorIdentity.resolve(notice, in: conversation, account: nil, mentionTargets: [])

        XCTAssertEqual(identity.name, "Facilitator")
        XCTAssertNil(identity.source)
        XCTAssertEqual(identity.seed, KordiSystemIdentity.seed)
        XCTAssertFalse(KordiSystemAgentIdentity.matches(name: identity.name, seed: identity.seed))
        XCTAssertTrue(KordiSystemIdentity.matches(seed: identity.seed))
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: conversation, message: notice, selfAccountID: "acct_me",
            contacts: [], conversations: []
        ))
    }

    func testPlanAgentMessageWithoutTheKindShowsAsSystem() {
        let conversation = makeGroup()
        for authorName in ["Facilitator", KordiSystemIdentity.legacyDisplayName, KordiSystemAgentIdentity.legacyName] {
            let message = ChatMessage(
                id: "system-agent", conversationId: conversation.id, author: .person, authorName: authorName,
                text: "Plan", createdAt: .distantPast, deliveryState: .sent, errorMessage: nil,
                requestMessageId: nil
            )

            let identity = MessageAuthorIdentity.resolve(message, in: conversation, account: nil, mentionTargets: [])

            XCTAssertEqual(identity, KordiSystemIdentity.avatar, authorName)
        }
    }

    private func makeGroup() -> ConversationSummary {
        ConversationSummary(
            id: "group:mobile", kind: .group, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Mobile builders", displayName: "Mobile builders", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Shu Yang", avatarUrl: nil, role: "owner"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member")
            ]
        )
    }

    private func makeWire(id: String, kind: String?, body: String, version: Int? = nil) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: KordiSystemAgentIdentity.accountId,
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-10-21T10:00:00Z",
            deliveredAt: "2026-10-21T10:00:01Z",
            readAt: nil,
            direction: "incoming",
            sessionId: "session:group:mobile",
            messageKind: kind,
            version: version
        )
    }
}
