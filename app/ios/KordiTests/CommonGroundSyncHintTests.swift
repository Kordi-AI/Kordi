import XCTest
@testable import Kordi

/// Grounding sync hints: routing from the sync stream, which screens they
/// wake, coalescing, and the slower polls once hints are known to arrive.
@MainActor
final class CommonGroundSyncHintTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17083")!
    private static let roomPath = "/v1/cloud/common-ground/rooms/4821"
    private static let resultsPath = "/v1/cloud/common-ground/rooms/4821/results"
    private static let openRoom = #"{"code":"4821","open":true,"members":[]}"#
    private static let ready = #"{"status":"ready","people":[]}"#
    private static let matching = #"{"status":"matching","people":[]}"#
    private static let pendingMatch = #"{"status":"matching","person":{"accountId":"acct_b","name":"Priya","avatarUrl":null}}"#
    private static let readyMatch = #"{"status":"ready","person":{"accountId":"acct_b","name":"Priya","avatarUrl":null},"score":80}"#

    private func api() -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        return CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
    }

    private func stubbedModel(hintsArrived: Bool) -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let api = api()
        let model = CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex")) { (api, "session-value") }
        model.hintsArrived = hintsArrived
        return model
    }

    private func count(_ method: String, _ path: String) -> Int {
        CommonGroundURLProtocol.paths.filter { $0 == "\(method) \(path)" }.count
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), "Timed out", file: file, line: line)
    }

    private func event(_ type: String, payload: String, seq: Int) -> String {
        #"{"stream_seq":\#(seq),"event_id":"evt_\#(seq)","protocol_version":2,"type":"\#(type)","critical":false,"#
            + #""conversation_id":null,"entity_id":null,"entity_version":null,"occurred_at":"2026-11-12T09:00:00Z","payload":\#(payload)}"#
    }

    // MARK: Routing

    func testHintsDecodeFromSyncEvents() throws {
        func hint(_ json: String) throws -> CommonGroundSyncHint? {
            CommonGroundSyncHint(event: try JSONDecoder().decode(CloudChatEvent.self, from: Data(json.utf8)))
        }
        XCTAssertEqual(try hint(event("common_ground.room.updated", payload: #"{"code":"4821"}"#, seq: 1)), .room(code: "4821"))
        XCTAssertEqual(try hint(event("common_ground.matches.updated", payload: #"{"profileId":"p_1"}"#, seq: 2)), .matches)
        XCTAssertEqual(try hint(event("common_ground.matches.updated", payload: "{}", seq: 3)), .matches)
        XCTAssertEqual(try hint(event("common_ground.invitations.updated", payload: "{}", seq: 6)), .invitations)
        XCTAssertTrue(CommonGroundSyncHint.eventTypes.contains("common_ground.invitations.updated"))
        XCTAssertNil(try hint(event("common_ground.room.updated", payload: "{}", seq: 4)), "A room hint names its room")
        XCTAssertNil(try hint(event("document.updated", payload: #"{"attachmentId":"att_1"}"#, seq: 5)))
    }

    func testSyncStreamPostsHintsAndKeepsThemOutOfChatEvents() async throws {
        let model = stubbedModel(hintsArrived: false)
        let events = [
            event("common_ground.room.updated", payload: #"{"code":"4821"}"#, seq: 1),
            event("common_ground.matches.updated", payload: #"{"profileId":"p_1"}"#, seq: 2),
        ].joined(separator: ",")
        CommonGroundURLProtocol.stub("GET", "/v2/chat/sync", [(200, #"""
        {"protocol_version":2,"events":[\#(events)],"next_cursor":"c2","last_stream_seq":2,"has_more":false,"server_time":"2026-11-12T09:00:00Z"}
        """#)])

        let response = try await api().sync(token: "session-value", cursor: "c1")
        XCTAssertTrue(response.events.isEmpty, "Hints are not chat events")
        XCTAssertEqual(response.cursor, "c2")
        try await waitUntil { model.hintsArrived }
        XCTAssertTrue(CommonGroundSyncHint.arrivedThisSession)
        try await Task.sleep(for: .milliseconds(20))
    }

    func testHintTargets() {
        let room = CommonGroundSyncHint.room(code: "4821")
        XCTAssertTrue(CommonGroundHintTarget.rooms.wakes(on: room))
        XCTAssertFalse(CommonGroundHintTarget.rooms.wakes(on: .matches))
        XCTAssertTrue(CommonGroundHintTarget.lobby("4821").wakes(on: room))
        XCTAssertFalse(CommonGroundHintTarget.lobby("4821").wakes(on: .room(code: "1234")))
        XCTAssertFalse(CommonGroundHintTarget.lobby("4821").wakes(on: .matches))
        XCTAssertTrue(CommonGroundHintTarget.results("4821").wakes(on: room))
        XCTAssertFalse(CommonGroundHintTarget.results("4821").wakes(on: .room(code: "1234")))
        XCTAssertTrue(CommonGroundHintTarget.results("4821").wakes(on: .matches))
        XCTAssertTrue(CommonGroundHintTarget.match("acct_b").wakes(on: .matches))
        XCTAssertFalse(CommonGroundHintTarget.match("acct_b").wakes(on: room))
    }

    // MARK: Refresh

    func testHintWithNothingOnDisplayRequestsNothing() async throws {
        let model = stubbedModel(hintsArrived: false)
        model.receive(.room(code: "4821"))
        model.receive(.matches)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(model.hintsArrived)
        XCTAssertTrue(CommonGroundURLProtocol.requests.isEmpty)
    }

    func testRoomHintRefreshesResultsAtOnceAndCoalescesHintsDuringARefresh() async throws {
        let model = stubbedModel(hintsArrived: true)
        CommonGroundURLProtocol.stub("GET", Self.roomPath, [(200, Self.openRoom)])
        CommonGroundURLProtocol.stub("POST", Self.resultsPath, [(200, Self.ready)])

        let following = Task { await model.followRoomResults("4821") }
        try await waitUntil { model.results["4821"] != nil }
        XCTAssertEqual(count("POST", Self.resultsPath), 1)

        // Ready results wait for the 60-second fallback; a hint for another room does not wake them.
        model.receive(.room(code: "1234"))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(count("POST", Self.resultsPath), 1)

        CommonGroundURLProtocol.hold(Self.resultsPath)
        model.receive(.room(code: "4821"))
        try await waitUntil { CommonGroundURLProtocol.hasHeldResponse(Self.resultsPath) }
        XCTAssertEqual(count("POST", Self.resultsPath), 2)

        // Three hints while that refresh is in flight cause exactly one more.
        model.receive(.room(code: "4821"))
        model.receive(.matches)
        model.receive(.room(code: "4821"))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(count("POST", Self.resultsPath), 2, "Refreshes never overlap")
        CommonGroundURLProtocol.release(Self.resultsPath)
        try await waitUntil { count("POST", Self.resultsPath) == 3 }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(count("POST", Self.resultsPath), 3)
        XCTAssertEqual(count("GET", Self.roomPath), 3)

        following.cancel()
        await following.value
        XCTAssertTrue(model.hintWakes.isEmpty, "A screen that left stops listening")
        model.receive(.room(code: "4821"))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(count("POST", Self.resultsPath), 3)
    }

    func testPollsRelaxOnlyAfterAHintArrived() async throws {
        let model = stubbedModel(hintsArrived: false)
        CommonGroundURLProtocol.stub("POST", Self.resultsPath, [(200, Self.matching), (200, Self.ready)])
        await model.loadResults("4821", quiet: true)
        XCTAssertEqual(model.resultsPollInterval("4821"), CommonGroundModel.matchPollInterval)
        XCTAssertEqual(model.matchingPollInterval, CommonGroundModel.matchPollInterval)
        model.receive(.matches)
        XCTAssertEqual(model.resultsPollInterval("4821"), CommonGroundModel.hintedMatchPollInterval)
        XCTAssertEqual(model.matchingPollInterval, .seconds(10))

        await model.loadResults("4821", quiet: true)
        XCTAssertEqual(model.resultsPollInterval("4821"), .seconds(60))
        model.hintsArrived = false
        XCTAssertEqual(model.resultsPollInterval("4821"), CommonGroundModel.matchPollInterval, "Today's poll until hints arrive")
    }

    func testMatchHintEndsAMatchWaitWithoutTheTimer() async throws {
        let model = stubbedModel(hintsArrived: true)
        model.matches["acct_b"] = try JSONDecoder().decode(CommonGroundMatch.self, from: Data(Self.pendingMatch.utf8))
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/people/acct_b/match", [(200, Self.readyMatch)])

        let waiting = Task { await model.waitForMatch("acct_b") }
        try await waitUntil { !model.hintWakes.isEmpty }
        model.receive(.room(code: "4821"))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(CommonGroundURLProtocol.requests.isEmpty, "A room hint does not concern a match")

        model.receive(.matches)
        await waiting.value
        XCTAssertEqual(model.matches["acct_b"]?.isReady, true)
        XCTAssertTrue(model.hintWakes.isEmpty)
    }

    func testRoomsListReloadsOnRoomHintsOnly() async throws {
        let model = stubbedModel(hintsArrived: true)
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms", [(200, #"{"rooms":[{"code":"4821","name":"","memberCount":2,"themeCount":0}]}"#)])

        let following = Task { await model.followRoomHints() }
        try await waitUntil { !model.hintWakes.isEmpty }
        model.receive(.matches)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(CommonGroundURLProtocol.requests.isEmpty, "Home loads rooms itself on appear")

        model.receive(.room(code: "4821"))
        try await waitUntil { model.roomList?.first?.code == "4821" }
        XCTAssertEqual(count("GET", "/v1/cloud/common-ground/rooms"), 1)
        following.cancel()
        await following.value
    }
}
