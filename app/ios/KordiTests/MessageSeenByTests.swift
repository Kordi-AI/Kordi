import XCTest
@testable import Kordi

/// The message menu's "Seen by" row and its full list (#2455).
@MainActor
final class MessageSeenByTests: XCTestCase {
    // MARK: When the row exists

    func testOwnSentOrReadGroupMessageGetsARow() throws {
        let group = group(participants: 8)
        for state in [MessageDeliveryState.sent, .read] {
            let target = try XCTUnwrap(MessageSeenByPresentation.target(for: own(state: state), in: group))
            XCTAssertEqual(target.sessionId, group.sessionId)
            XCTAssertEqual(target.messageId, "server-message")
            XCTAssertEqual(target.participants.count, 8)
        }
    }

    func testRowIsAbsentOnIncomingMessages() {
        let incoming = own(state: .read, author: .person)
        XCTAssertNil(MessageSeenByPresentation.target(for: incoming, in: group(participants: 3)))
    }

    func testRowIsAbsentOutsideGroups() {
        let direct = ConversationSummary(
            id: "person:acct_maya", kind: .person, peerAccountId: "acct_maya", agentId: nil, ownerDisplayName: "Maya",
            displayName: "Maya", lastMessage: "", lastActivityAt: Date(), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:direct"
        )
        XCTAssertNil(MessageSeenByPresentation.target(for: own(state: .read), in: direct))
    }

    func testRowIsAbsentInGroupsOfMoreThanOneHundredMembers() {
        XCTAssertNotNil(MessageSeenByPresentation.target(for: own(state: .read), in: group(participants: 100)))
        XCTAssertNil(MessageSeenByPresentation.target(for: own(state: .read), in: group(participants: 101)))
    }

    func testRowIsAbsentBeforeTheServerHasTheMessage() {
        XCTAssertNil(MessageSeenByPresentation.target(for: own(state: .sending), in: group(participants: 3)))
        XCTAssertNil(MessageSeenByPresentation.target(for: own(state: .failed), in: group(participants: 3)))
        XCTAssertNil(MessageSeenByPresentation.target(for: own(state: .read, serverId: nil), in: group(participants: 3)))
        XCTAssertNotNil(MessageSeenByPresentation.target(
            for: own(state: .read, serverId: nil), in: group(participants: 3), isPreviewMode: true
        ))
    }

    func testRowIsAbsentOnSystemNotices() {
        var notice = own(state: .read)
        notice.messageKind = ChatMessage.groupMemberJoinMessageKind
        XCTAssertNil(MessageSeenByPresentation.target(for: notice, in: group(participants: 3)))
    }

    // MARK: Row state from a readers response

    func testNoReadersSaysNotSeenYetAndCannotBeChosen() {
        let state = MessageSeenByPresentation.state(for: response([], total: 0), participants: participants(3))
        XCTAssertEqual(state, .none)
        XCTAssertEqual(state.label, "Not seen yet")
        XCTAssertFalse(state.opensList)
        XCTAssertTrue(state.faces.isEmpty)
        XCTAssertTrue(state.isVisible)
    }

    func testOneReaderShowsTheirNameAndOpensTheList() {
        let state = MessageSeenByPresentation.state(for: response(["acct_1"]), participants: participants(3))
        guard case let .one(reader) = state else { return XCTFail("Expected one reader, got \(state)") }
        XCTAssertEqual(reader.displayName, "Person 1")
        XCTAssertEqual(state.label, "Person 1")
        XCTAssertEqual(state.faces.map(\.accountId), ["acct_1"])
        XCTAssertTrue(state.opensList)
        XCTAssertEqual(state.accessibilityLabel, "Seen by Person 1")
    }

    func testSeveralReadersShowTheTotalAndTheFirstFourFaces() {
        let state = MessageSeenByPresentation.state(
            for: response(["acct_3", "acct_1", "acct_5", "acct_2"], total: 8),
            participants: participants(9)
        )
        XCTAssertEqual(state.label, "8 Seen")
        XCTAssertEqual(state.faces.map(\.accountId), ["acct_3", "acct_1", "acct_5", "acct_2"])
        XCTAssertTrue(state.opensList)
    }

    func testFacesStopAtFourEvenWhenMoreReadersArrive() {
        let state = MessageSeenByPresentation.state(
            for: response(["acct_1", "acct_2", "acct_3", "acct_4", "acct_5"]),
            participants: participants(6)
        )
        XCTAssertEqual(state.label, "5 Seen")
        XCTAssertEqual(state.faces.count, 4)
    }

    func testOneTotalWithoutItsReaderStillCountsThem() {
        let state = MessageSeenByPresentation.state(for: response([], total: 1), participants: participants(3))
        XCTAssertEqual(state.label, "1 Seen")
        XCTAssertTrue(state.faces.isEmpty)
    }

    func testLoadingAndHiddenRows() {
        XCTAssertNil(MessageSeenByState.loading.label)
        XCTAssertTrue(MessageSeenByState.loading.isVisible)
        XCTAssertFalse(MessageSeenByState.loading.opensList)
        XCTAssertEqual(MessageSeenByState.loading.accessibilityLabel, "Loading who has seen this")
        XCTAssertFalse(MessageSeenByState.hidden.isVisible)
    }

    // MARK: Loading and stale responses

    func testModelLoadsTheRowWithFourReaders() async throws {
        let model = MessageSeenByModel()
        let target = try XCTUnwrap(MessageSeenByPresentation.target(for: own(state: .read), in: group(participants: 6)))
        var requestedLimit: Int?
        await model.load(target) { _, limit in
            requestedLimit = limit
            return self.response(["acct_1", "acct_2"])
        }
        XCTAssertEqual(requestedLimit, 4)
        XCTAssertEqual(model.state.label, "2 Seen")
    }

    func testFailedFetchHidesTheRow() async throws {
        let model = MessageSeenByModel()
        let target = try XCTUnwrap(MessageSeenByPresentation.target(for: own(state: .read), in: group(participants: 6)))
        await model.load(target) { _, _ in
            throw CloudAPIError(code: "readers_unavailable", message: "Unavailable", statusCode: 409)
        }
        XCTAssertEqual(model.state, .hidden)
    }

    func testNoTargetHidesTheRowWithoutFetching() async {
        let model = MessageSeenByModel()
        var fetched = false
        await model.load(nil) { _, _ in
            fetched = true
            return self.response([])
        }
        XCTAssertFalse(fetched)
        XCTAssertEqual(model.state, .hidden)
    }

    func testResponseForAnEarlierMessageIsIgnored() {
        let model = MessageSeenByModel()
        let first = model.begin(target(messageId: "first"))
        let second = model.begin(target(messageId: "second"))
        model.finish(.success(response(["acct_1"])), participants: participants(3), token: first)
        XCTAssertEqual(model.state, .loading)
        model.finish(.success(response([], total: 0)), participants: participants(3), token: second)
        XCTAssertEqual(model.state, .none)
    }

    func testRowShowsLoadingForATargetNotYetStarted() {
        let model = MessageSeenByModel()
        let first = target(messageId: "first")
        let token = model.begin(first)
        model.finish(.success(response(["acct_1"])), participants: participants(3), token: token)
        XCTAssertEqual(model.state(for: first).label, "Person 1")
        XCTAssertEqual(model.state(for: target(messageId: "second")), .loading)
        XCTAssertEqual(model.state(for: nil), .hidden)
    }

    func testResponseAfterTheMenuClosedIsIgnored() {
        let model = MessageSeenByModel()
        let token = model.begin(target(messageId: "first"))
        model.close()
        model.finish(.success(response(["acct_1"])), participants: participants(3), token: token)
        XCTAssertEqual(model.state, .hidden)
        XCTAssertNil(model.target)
    }

    func testALateDuplicateResponseDoesNotReplaceTheRow() {
        let model = MessageSeenByModel()
        let token = model.begin(target(messageId: "first"))
        model.finish(.success(response(["acct_1"])), participants: participants(3), token: token)
        model.finish(.failure(CancellationError()), participants: participants(3), token: token)
        XCTAssertEqual(model.state.label, "Person 1")
    }

    // MARK: Full list

    func testListKeepsTheServerOrderAndMissingTimes() {
        let readers = MessageSeenByPresentation.readers(
            in: CloudMessageReadersResponse(total: 3, readers: [
                CloudMessageReader(accountId: "acct_2", readAt: nil),
                CloudMessageReader(accountId: "acct_1", readAt: "2026-11-10T10:41:00Z"),
                CloudMessageReader(accountId: "acct_3", readAt: "2026-11-10T10:43:00.250Z"),
            ]),
            participants: participants(4)
        )
        XCTAssertEqual(readers.map(\.accountId), ["acct_2", "acct_1", "acct_3"])
        XCTAssertNil(readers[0].readAt)
        XCTAssertEqual(readers[1].readAt, ISO8601DateFormatter().date(from: "2026-11-10T10:41:00Z"))
        XCTAssertNotNil(readers[2].readAt)
    }

    func testListNamesUnknownReadersAndDropsDuplicatesAndBadTimes() {
        let readers = MessageSeenByPresentation.readers(
            in: CloudMessageReadersResponse(total: 3, readers: [
                CloudMessageReader(accountId: "acct_gone", readAt: "not a time"),
                CloudMessageReader(accountId: "acct_1", readAt: nil),
                CloudMessageReader(accountId: "acct_1", readAt: nil),
                CloudMessageReader(accountId: "", readAt: nil),
            ]),
            participants: participants(2)
        )
        XCTAssertEqual(readers.map(\.displayName), ["Kordi user", "Person 1"])
        XCTAssertNil(readers[0].readAt)
        XCTAssertNil(readers[0].avatarUrl)
    }

    func testReadTimeLabels() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-10T15:00:00Z"))
        func label(_ value: String) throws -> String? {
            MessageSeenByPresentation.readTimeLabel(
                try XCTUnwrap(ISO8601DateFormatter().date(from: value)), now: now, calendar: calendar, locale: locale
            )
        }
        let today = try XCTUnwrap(label("2026-11-10T10:41:00Z"))
        XCTAssertTrue(today.hasPrefix("10:41"), today)
        let yesterday = try XCTUnwrap(label("2026-11-09T10:41:00Z"))
        XCTAssertTrue(yesterday.hasPrefix("Yesterday, 10:41"), yesterday)
        let older = try XCTUnwrap(label("2026-11-03T10:41:00Z"))
        XCTAssertTrue(older.hasPrefix("Nov 3, 10:41"), older)
        let lastYear = try XCTUnwrap(label("2025-11-03T10:41:00Z"))
        XCTAssertTrue(lastYear.contains("2025"), lastYear)
        XCTAssertNil(MessageSeenByPresentation.readTimeLabel(nil, now: now, calendar: calendar, locale: locale))
    }

    // MARK: Decoding

    func testReadersResponseDecodesEitherCasing() throws {
        let camel = try JSONDecoder().decode(CloudMessageReadersResponse.self, from: Data(
            #"{"total":2,"readers":[{"accountId":"acct_1","readAt":null},{"accountId":"acct_2","readAt":"2026-11-10T10:41:00Z"}]}"#.utf8
        ))
        let snake = try JSONDecoder().decode(CloudMessageReadersResponse.self, from: Data(
            #"{"total":5,"readers":[{"account_id":"acct_1","read_at":"2026-11-10T10:41:00Z"}]}"#.utf8
        ))
        XCTAssertEqual(camel, CloudMessageReadersResponse(total: 2, readers: [
            CloudMessageReader(accountId: "acct_1", readAt: nil),
            CloudMessageReader(accountId: "acct_2", readAt: "2026-11-10T10:41:00Z"),
        ]))
        XCTAssertEqual(snake.total, 5)
        XCTAssertEqual(snake.readers.first?.readAt, "2026-11-10T10:41:00Z")
    }

    func testReadersResponseWithoutTotalCountsItsReaders() throws {
        let decoded = try JSONDecoder().decode(CloudMessageReadersResponse.self, from: Data(
            #"{"readers":[{"accountId":"acct_1"}]}"#.utf8
        ))
        XCTAssertEqual(decoded.total, 1)
    }

    func testPreviewResponseUsesTheBubbleReaders() {
        var target = target(messageId: "preview")
        target.previewReaderIds = ["acct_1", "acct_2"]
        let response = MessageSeenByPresentation.previewResponse(for: target, limit: 1)
        XCTAssertEqual(response.total, 2)
        XCTAssertEqual(response.readers.map(\.accountId), ["acct_1"])
    }

    // MARK: Fixtures

    private func participants(_ count: Int) -> [CloudGroupParticipant] {
        (0..<count).map { index in
            CloudGroupParticipant(
                accountId: index == 0 ? "acct_me" : "acct_\(index)",
                displayName: index == 0 ? "Me" : "Person \(index)",
                avatarUrl: nil,
                role: index == 0 ? "owner" : "member"
            )
        }
    }

    private func group(participants count: Int) -> ConversationSummary {
        ConversationSummary(
            id: "group:launch", kind: .group, peerAccountId: "acct_1", agentId: nil, ownerDisplayName: "Launch prep",
            displayName: "Launch prep", lastMessage: "", lastActivityAt: Date(), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:group:launch", groupParticipants: participants(count)
        )
    }

    private func own(
        state: MessageDeliveryState, serverId: String? = "server-message", author: MessageAuthor = .me
    ) -> ChatMessage {
        ChatMessage(
            id: "local-message", conversationId: "group:launch", conversationSequence: 12, author: author,
            authorName: "You", text: "I moved the demo to Thursday at 3.", createdAt: Date(),
            deliveryState: state, errorMessage: nil, requestMessageId: nil, reactionTargetMessageId: serverId
        )
    }

    private func target(messageId: String) -> MessageSeenByTarget {
        MessageSeenByTarget(sessionId: "session:group:launch", messageId: messageId, participants: participants(3))
    }

    private func response(_ accountIds: [String], total: Int? = nil) -> CloudMessageReadersResponse {
        CloudMessageReadersResponse(
            total: total ?? accountIds.count,
            readers: accountIds.map { CloudMessageReader(accountId: $0, readAt: nil) }
        )
    }
}
