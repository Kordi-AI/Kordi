import Foundation
import Testing
@testable import Kordi

@MainActor
struct AgentResponseDeduplicationTests {
    private var conversation: ConversationSummary {
        ConversationSummary(id: "agent-session:test", kind: .agent, peerAccountId: "acct_test", agentId: nil,
            ownerDisplayName: "Test owner", displayName: "Test chat", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "session:test")
    }

    private func wire(_ id: String, body: String, sender: String = "acct_test", second: Int = 1) -> CloudMessageDTO {
        CloudMessageDTO(messageId: id, fromAccountId: sender, toAccountId: "acct_test", body: body,
            createdAt: String(format: "2026-09-13T10:00:%02dZ", second), deliveredAt: nil, readAt: nil,
            direction: "outgoing", sessionId: conversation.sessionId)
    }

    private func response(_ id: String, request: String = "request", text: String = "Completed answer",
                          state: String = "complete", sender: String = "acct_test", second: Int = 1,
                          execution: [String: Any]? = nil) throws -> CloudMessageDTO {
        var payload: [String: Any] = ["kind": "agent-response", "requestId": request, "text": text, "deliveryState": state]
        if let execution { payload["execution"] = execution }
        let body = CloudMessageCodec.agentResponsePrefix + (try JSONSerialization.data(withJSONObject: payload)).base64EncodedString()
        return wire(id, body: body, sender: sender, second: second)
    }

    private func project(_ rows: [CloudMessageDTO]) -> [ChatMessage] {
        CloudDirectMessageProjector.project(rows, conversation: conversation, ownAccountId: "acct_test")
    }

    @Test func completedCloudCopiesProduceOneCardAndRetainExecutionDetails() throws {
        let start = parseCloudDate("2026-09-13T10:00:00Z").timeIntervalSince1970 * 1_000
        let execution: [String: Any] = ["phase": "writing", "summary": "Preparing answer", "steps": [],
            "thinkingText": "Check the evidence", "startedAtMs": start, "updatedAtMs": start + 5_000, "completed": false,
            "tools": [["id": "tool:read", "name": "read_session", "status": "complete", "arguments": "{}", "liveOutput": "", "isError": false]]]
        let earlier = try response("desktop-enriched", execution: execution)
        let terminal = try response("terminal", second: 5)
        let projected = project([earlier, terminal, terminal])
        #expect(projected.count == 1)
        let answer = try #require(projected.first)
        #expect(answer.text == "Completed answer")
        #expect(answer.agentExecution?.thinkingText == "Check the evidence")
        #expect(answer.agentExecution?.tools?.count == 1)
        #expect(answer.agentExecution?.completed == true)
        #expect(AgentExecutionTimelinePresentation(execution: try #require(answer.agentExecution)).completionLabel == "Worked for 5s")
        let merged = AppModel.mergePartialProjection(project([terminal]), preserving: project([earlier]))
        #expect(merged.count == 1)
        #expect(AppModel.timelineIdentity(for: answer, requestPresentationIds: [:])
            == AppModel.timelineIdentity(for: try #require(project([earlier]).first), requestPresentationIds: [:]))
    }

    @Test(arguments: ["Request canceled.", "Response stopped.", "Partial answer before cancellation"])
    func cancellationControlAndTerminalCopiesProduceOneNotice(text: String) throws {
        let request = wire("request", body: "Summarize work", second: 0)
        let cancelBody = CloudMessageCodec.agentCancelPrefix
            + (try JSONSerialization.data(withJSONObject: ["kind": "agent-cancel", "requestId": "request"])).base64EncodedString()
        let cancel = wire("cancel", body: cancelBody)
        let first = try response("cancelled-one", text: text, state: "cancelled", second: 2)
        let second = try response("cancelled-two", text: text, state: "cancelled", second: 3)
        let rows = project([request, cancel, first, second])
        #expect(rows.count == 2)
        #expect(rows.filter { $0.author == .agent }.map(\.text) == [text])
        #expect(rows.last?.deliveryState == .cancelled)
        #expect(rows.last?.errorMessage == nil)
        let cached = project([request, cancel])
        #expect(AppModel.mergePartialProjection(rows, preserving: cached).count == 2)
    }

    @Test func equalAnswersToDifferentRequestsOrFromDifferentOwnersStaySeparate() throws {
        let first = try response("first")
        #expect(project([first, try response("second", request: "another-request")]).count == 2)
        #expect(project([first, try response("peer", sender: "acct_peer")]).count == 2)
    }

    @Test(arguments: ["complete", "cancelled"])
    func groupLifecycleCopiesCollapseWithoutHidingAnotherOwnersReply(state: String) {
        func payload(_ id: String, owner: String = "acct_test", request: String = "request", at: Double) -> CloudGroupMessagePayload {
            CloudGroupMessagePayload(id: id, senderAccountId: owner, text: "Same response", createdAtMs: at,
                senderKind: "agent", senderDisplayName: "Agent", deliveryState: state,
                replyToMessageId: request, requestId: request)
        }
        let visible = CloudGroupAgentLifecycleProjector.visibleMessageIds(in: [
            payload("first", at: 1), payload("duplicate", at: 2),
            payload("peer", owner: "acct_peer", at: 3), payload("another-request", request: "another", at: 4)
        ])
        #expect(visible == ["duplicate", "peer", "another-request"])
    }
    @Test func sentRequestNeedsARealProcessingEventBeforeShowingProcessing() throws {
        let request = wire("request", body: "Hello", second: 0)
        let sent = project([request])
        #expect(sent.count == 1)
        #expect([MessageDeliveryState.sent, .delivered, .read].contains(try #require(sent.first).deliveryState))
        #expect(sent.allSatisfy { $0.agentExecution == nil })
        let progress = try response("progress", text: "", state: "processing")
        let processing = AppModel.mergePartialProjection(project([request, progress]), preserving: sent)
        let active = try #require(processing.first { $0.author == .agent })
        #expect(processing.count == 2)
        #expect(MessageBubble.showsAgentWaitingIndicator(execution: try #require(active.agentExecution), responseText: active.text))
        let complete = AppModel.mergePartialProjection(project([request, try response("complete", second: 2)]), preserving: processing)
        #expect(complete.count == 2)
        #expect(complete.allSatisfy { $0.agentExecution?.completed != false })
    }

    @Test(arguments: [MessageDeliveryState.sending, .sent, .delivered, .read, .failed, .cancelled])
    func processingCannotOvertakeItsRequestsSendState(state: MessageDeliveryState) throws {
        let request = wire("request", body: "Hello", second: 0)
        let progress = try response("progress", text: "", state: "processing")
        var rows = project([request, progress])
        let index = try #require(rows.firstIndex { $0.author == .me })
        rows[index].deliveryState = state
        for kind: ConversationKind in [.agent, .group, .person] {
            let visible = AgentSessionQueuePresentation.apply(to: rows, kind: kind)
            #expect(visible.count == ([.sent, .delivered, .read].contains(state) ? 2 : 1))
        }
    }

    // MARK: Reply slot

    private var group: ConversationSummary {
        ConversationSummary(id: "group:slot", kind: .group, peerAccountId: "acct_owner", agentId: nil,
            ownerDisplayName: "Group", displayName: "Group", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:group:slot")
    }

    private func groupWire(_ id: String, sender: String, agent: Bool, text: String, state: String? = nil,
                           sequence: Int64, request: String? = nil) throws -> CloudMessageDTO {
        let participant = CloudGroupParticipant(accountId: sender, displayName: sender, avatarUrl: nil, role: "member")
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message", groupId: group.sessionId, groupSpaceId: group.sessionId, groupTitle: "Group",
            createdByAccountId: "acct_owner", actor: participant, participants: [participant],
            message: CloudGroupMessagePayload(
                id: id, senderAccountId: sender, text: text, createdAtMs: Double(sequence) * 1_000,
                senderKind: agent ? "agent" : "person", senderDisplayName: agent ? "Kordi" : sender,
                deliveryState: state, replyToMessageId: request, requestId: request
            )
        )
        return CloudMessageDTO(messageId: "wire-\(sequence)", fromAccountId: sender, toAccountId: "acct_viewer",
            body: try CloudGroupMessageCodec.encode(envelope),
            createdAt: String(format: "2026-11-08T10:00:%02dZ", sequence), deliveredAt: nil, readAt: nil,
            direction: "incoming", sessionId: group.sessionId, conversationSequence: sequence)
    }

    private func projectGroup(_ rows: [CloudMessageDTO]) -> [ChatMessage] {
        AppModel.mapGroupMessages(rows, conversation: group, ownAccountId: "acct_viewer")
    }

    @Test func groupReplyTakesOverItsWaitingRowSlot() throws {
        let request = try groupWire("request", sender: "acct_peer", agent: false, text: "@Kordi share progress", sequence: 17)
        let waiting = try groupWire("waiting", sender: "acct_owner", agent: true, text: "", state: "processing",
                                    sequence: 18, request: "request")
        let unrelated = try groupWire("unrelated", sender: "acct_peer", agent: false, text: "Keep talking", sequence: 19)
        let reply = try groupWire("reply", sender: "acct_owner", agent: true, text: "Here is the progress.",
                                  state: "complete", sequence: 20, request: "request")

        #expect(projectGroup([request, waiting, unrelated]).map(\.id) == ["request", "waiting", "unrelated"])
        // History hydration sees the rows in any order and renders the live order.
        for rows in [[request, waiting, unrelated, reply], [reply, unrelated, waiting, request]] {
            let projected = projectGroup(rows)
            #expect(projected.map(\.id) == ["request", "reply", "unrelated"])
            let answer = try #require(projected.first { $0.id == "reply" })
            #expect(answer.conversationSequence == 20, "read state keeps the reply's own sequence")
            #expect(answer.timelineSequence == 18)
            let cached = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(answer))
            #expect(cached.timelineSequence == 18)
            #expect(projected.sorted(by: ChatMessage.timelinePrecedes).map(\.id) == ["request", "reply", "unrelated"])
        }
    }

    @Test func groupReplyWithoutWaitingRowKeepsItsPlace() throws {
        let request = try groupWire("request", sender: "acct_peer", agent: false, text: "@Kordi share progress", sequence: 17)
        let unrelated = try groupWire("unrelated", sender: "acct_peer", agent: false, text: "Keep talking", sequence: 19)
        let reply = try groupWire("reply", sender: "acct_owner", agent: true, text: "Here is the progress.",
                                  state: "complete", sequence: 20, request: "request")
        let projected = projectGroup([request, unrelated, reply])
        #expect(projected.map(\.id) == ["request", "unrelated", "reply"])
        #expect(projected.allSatisfy { $0.timelineSequence == nil })
    }

    @Test func directReplyTakesOverItsFirstWaitingRowSlot() throws {
        func sequenced(_ message: CloudMessageDTO, _ sequence: Int64) -> CloudMessageDTO {
            CloudMessageDTO(messageId: message.messageId, fromAccountId: message.fromAccountId,
                toAccountId: message.toAccountId, body: message.body, createdAt: message.createdAt,
                deliveredAt: nil, readAt: nil, direction: message.direction, sessionId: message.sessionId,
                conversationSequence: sequence)
        }
        let request = sequenced(wire("request", body: "Summarize work", second: 0), 1)
        let firstProgress = sequenced(try response("progress-1", text: "", state: "processing", second: 1), 2)
        let unrelated = sequenced(wire("unrelated", body: "Also check the logs", second: 2), 3)
        let laterProgress = sequenced(try response("progress-2", text: "", state: "processing", second: 3), 4)
        let complete = sequenced(try response("complete", second: 4), 5)

        #expect(project([request, firstProgress, unrelated, laterProgress]).map(\.id)
            == ["request", "progress-2", "unrelated"])
        let answered = project([complete, laterProgress, unrelated, firstProgress, request])
        #expect(answered.map(\.id) == ["request", "complete", "unrelated"])
        #expect(try #require(answered.first { $0.id == "complete" }).conversationSequence == 5)
        #expect(project([request, unrelated, complete]).map(\.id) == ["request", "unrelated", "complete"])
    }

}
