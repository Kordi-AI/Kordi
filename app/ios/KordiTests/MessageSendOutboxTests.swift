import Foundation
import XCTest
@testable import Kordi

/// Mirrors how `AppModel.send` hands a failed send to the outbox: a kept send
/// is sent again through the same path with the same message.
@MainActor
private final class OutboxSendHarness {
    let api: CloudAPIClient
    let outbox: MessageSendOutbox
    private(set) var delivered: [String] = []
    private(set) var failed: [String] = []

    init(api: CloudAPIClient, outbox: MessageSendOutbox) {
        self.api = api
        self.outbox = outbox
    }

    func send(_ message: ChatMessage, in conversation: ConversationSummary) async {
        do {
            let sent = try await api.sendMessage(
                token: "session",
                peerAccountId: conversation.peerAccountId,
                body: message.text,
                sessionId: conversation.sessionId,
                clientMessageId: message.clientMessageId ?? message.id
            )
            delivered.append(sent.messageId)
        } catch {
            let kept = outbox.keep(message, in: conversation, after: error) { [weak self] conversation, message in
                await self?.send(message, in: conversation)
            }
            if !kept { failed.append(message.id) }
        }
    }
}

@MainActor
final class MessageSendOutboxTests: XCTestCase {
    private let conversation = ConversationSummary(
        id: "person:acct_peer", kind: .person, peerAccountId: "acct_peer", agentId: nil,
        ownerDisplayName: nil, displayName: "Peer", lastMessage: "", lastActivityAt: .distantPast,
        unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: OutboxURLProtocol.sessionID
    )
    private let message = ChatMessage(
        id: "ios_local-1", clientMessageId: CloudAPIClient.stableOperationUUID("ios_local-1"),
        conversationId: "person:acct_peer", author: .me, authorName: "You", text: "Hello",
        createdAt: Date(timeIntervalSince1970: 1_800_000_000), deliveryState: .sending,
        errorMessage: nil, requestMessageId: nil
    )
    private var session: URLSession?

    override func tearDown() async throws {
        session?.invalidateAndCancel()
        OutboxURLProtocol.reset()
        try await super.tearDown()
    }

    func testTimedOutSendKeepsItsClientMessageIdAndIsSentOnceWhenTheServerStoredIt() async {
        OutboxURLProtocol.script = [.storeThenTimeOut, .accept]
        let sleeper = ReconnectTestSleeper()
        let outbox = MessageSendOutbox(makePolicy: { RealtimeReconnectPolicy(random: { 0 }) }, sleep: sleeper.sleep)
        let harness = OutboxSendHarness(api: await client(), outbox: outbox)

        await harness.send(message, in: conversation)
        XCTAssertEqual(outbox.queuedMessageIDs, [message.id])
        XCTAssertTrue(harness.failed.isEmpty)
        XCTAssertTrue(harness.delivered.isEmpty)

        await reconnectEventually("the retry is scheduled") { sleeper.pending == [.zero] }
        sleeper.fireAll()
        await reconnectEventually("the retry was answered") {
            harness.delivered.count == 1 && outbox.queuedMessageIDs.isEmpty
        }

        XCTAssertEqual(harness.delivered, [OutboxURLProtocol.storedMessageID])
        XCTAssertTrue(harness.failed.isEmpty)
        XCTAssertEqual(OutboxURLProtocol.sentClientMessageIDs, [message.clientMessageId, message.clientMessageId])
        XCTAssertEqual(OutboxURLProtocol.storedCount, 1)
    }

    func testAnUnknownOutcomeIsRetriedWithBackoffUntilTheServerAnswers() async {
        OutboxURLProtocol.script = [.timeOut, .timeOut, .accept]
        let sleeper = ReconnectTestSleeper()
        let outbox = MessageSendOutbox(makePolicy: { RealtimeReconnectPolicy(random: { 1 }) }, sleep: sleeper.sleep)
        let harness = OutboxSendHarness(api: await client(), outbox: outbox)

        await harness.send(message, in: conversation)
        await reconnectEventually("the first retry waits") { sleeper.pending == [.seconds(1)] }
        sleeper.fireAll()
        await reconnectEventually("the second retry waits longer") { sleeper.pending == [.seconds(2)] }
        sleeper.fireAll()
        await reconnectEventually("the third attempt was stored") {
            harness.delivered.count == 1 && outbox.queuedMessageIDs.isEmpty
        }

        XCTAssertEqual(sleeper.requested, [.seconds(1), .seconds(2)])
        XCTAssertEqual(Set(OutboxURLProtocol.sentClientMessageIDs), [message.clientMessageId])
        XCTAssertEqual(OutboxURLProtocol.sentClientMessageIDs.count, 3)
        XCTAssertEqual(OutboxURLProtocol.storedCount, 1)
        XCTAssertTrue(harness.failed.isEmpty)
    }

    func testAServerRejectionFailsAndIsNotQueued() async {
        for (status, code) in [(400, "INVALID_REQUEST"), (403, "CHAT_BLOCKED"), (404, "CHAT_ENTITY_NOT_FOUND")] {
            OutboxURLProtocol.reset()
            OutboxURLProtocol.script = [.reject(status: status, code: code)]
            let sleeper = ReconnectTestSleeper()
            let outbox = MessageSendOutbox(makePolicy: { RealtimeReconnectPolicy(random: { 0 }) }, sleep: sleeper.sleep)
            let harness = OutboxSendHarness(api: await client(), outbox: outbox)

            await harness.send(message, in: conversation)

            XCTAssertEqual(harness.failed, [message.id], code)
            XCTAssertTrue(outbox.queuedMessageIDs.isEmpty, code)
            XCTAssertTrue(sleeper.requested.isEmpty, code)
            XCTAssertEqual(OutboxURLProtocol.sentClientMessageIDs.count, 1, code)
            session?.invalidateAndCancel()
        }
    }

    func testRetryAfterHoldsTheRetryEvenWhenTheNetworkReturns() async {
        for status in [429, 503] {
            OutboxURLProtocol.reset()
            OutboxURLProtocol.script = [.rateLimited(status: status, retryAfter: 7), .accept]
            let sleeper = ReconnectTestSleeper()
            let clock = ReconnectTestClock()
            let outbox = MessageSendOutbox(
                makePolicy: { RealtimeReconnectPolicy(random: { 0 }) },
                sleep: sleeper.sleep,
                now: { clock.now }
            )
            let harness = OutboxSendHarness(api: await client(), outbox: outbox)

            await harness.send(message, in: conversation)
            await reconnectEventually("the retry waits for Retry-After") { sleeper.pending == [.seconds(7)] }
            XCTAssertTrue(harness.failed.isEmpty)

            // The network returning does not shorten the server's Retry-After.
            clock.advance(by: .seconds(6))
            outbox.retryNow()
            for _ in 0..<1_000 { await Task.yield() }
            XCTAssertEqual(OutboxURLProtocol.sentClientMessageIDs.count, 1)
            XCTAssertEqual(sleeper.pending, [.seconds(7)])

            clock.advance(by: .seconds(1))
            outbox.retryNow()
            await reconnectEventually("the held retry ran once Retry-After passed") {
                harness.delivered.count == 1 && outbox.queuedMessageIDs.isEmpty
            }
            XCTAssertEqual(OutboxURLProtocol.sentClientMessageIDs, [message.clientMessageId, message.clientMessageId])
            session?.invalidateAndCancel()
        }
    }

    func testRetryNowSendsAWaitingMessageAtOnce() async {
        OutboxURLProtocol.script = [.timeOut, .accept]
        let sleeper = ReconnectTestSleeper()
        let outbox = MessageSendOutbox(makePolicy: { RealtimeReconnectPolicy(random: { 1 }) }, sleep: sleeper.sleep)
        let harness = OutboxSendHarness(api: await client(), outbox: outbox)

        await harness.send(message, in: conversation)
        await reconnectEventually("the retry waits") { sleeper.pending == [.seconds(1)] }
        outbox.retryNow()
        await reconnectEventually("the waiting message was sent") {
            harness.delivered.count == 1 && outbox.queuedMessageIDs.isEmpty
        }
        XCTAssertEqual(OutboxURLProtocol.storedCount, 1)
    }

    func testVerdicts() {
        func api(_ status: Int, _ code: String, retryAfter: Int? = nil) -> CloudAPIError {
            CloudAPIError(code: code, message: "Synthetic", statusCode: status, retryAfterSeconds: retryAfter)
        }
        XCTAssertEqual(MessageSendOutbox.verdict(for: URLError(.timedOut)), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: CancellationError()), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(0, "network_error")), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(0, "proxy_unreachable")), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(408, "REQUEST_TIMEOUT")), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(500, "SERVER_ERROR")), .unknown(retryAfter: nil))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(429, "RATE_LIMITED", retryAfter: 5)), .unknown(retryAfter: .seconds(5)))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(503, "UNAVAILABLE", retryAfter: 2)), .unknown(retryAfter: .seconds(2)))
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(409, "IDEMPOTENCY_KEY_REUSED")), .stored)
        for status in [400, 401, 403, 404, 409, 413, 422] {
            XCTAssertEqual(MessageSendOutbox.verdict(for: api(status, "REJECTED")), .rejected, "\(status)")
        }
        XCTAssertEqual(MessageSendOutbox.verdict(for: api(0, "invalid_response")), .rejected)
        XCTAssertEqual(MessageSendOutbox.verdict(for: URLError(.badURL)), .rejected)
    }

    private func client() async -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OutboxURLProtocol.self]
        let session = URLSession(configuration: configuration)
        self.session = session
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        await api.activateAccount("acct_me")
        return api
    }
}

/// A direct conversation whose send endpoint follows a script. The server keeps
/// one message per client message id and answers a repeat with it.
private final class OutboxURLProtocol: URLProtocol {
    enum Step {
        case storeThenTimeOut
        case timeOut
        case accept
        case reject(status: Int, code: String)
        case rateLimited(status: Int, retryAfter: Int)
    }

    static let sessionID = "session:direct-person:acct_me:acct_peer"
    static let conversationID = "00000000-0000-4000-8000-0000000000c1"
    static let storedMessageID = "00000000-0000-4000-8000-0000000000d1"

    private static let lock = NSLock()
    private static var steps: [Step] = []
    private static var clientIDs: [String] = []
    private static var stored: Set<String> = []
    private static var inserts = 0

    static var script: [Step] {
        get { lock.withLock { steps } }
        set { lock.withLock { steps = newValue } }
    }

    static var sentClientMessageIDs: [String?] { lock.withLock { clientIDs.map { Optional($0) } } }
    static var storedCount: Int { lock.withLock { inserts } }

    static func reset() {
        lock.withLock {
            steps = []
            clientIDs = []
            stored = []
            inserts = 0
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let path = request.url!.path
        if path == "/v2/chat/sync/bootstrap" {
            return respond(200, Self.bootstrap)
        }
        guard request.httpMethod == "POST", path == "/v2/chat/conversations/\(Self.conversationID)/messages" else {
            XCTFail("Unexpected request: \(request.httpMethod ?? "") \(path)")
            return respond(404, #"{"error":{"code":"CHAT_ENTITY_NOT_FOUND","message":"Unexpected"}}"#)
        }
        let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any]
        let clientID = body?["client_message_id"] as? String ?? ""
        let step: Step? = Self.lock.withLock {
            Self.clientIDs.append(clientID)
            return Self.steps.isEmpty ? nil : Self.steps.removeFirst()
        }
        switch step {
        case .storeThenTimeOut:
            Self.store(clientID)
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
        case .timeOut:
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
        case .accept:
            Self.store(clientID)
            respond(200, #"{"message":\#(Self.message(clientID: clientID))}"#)
        case .reject(let status, let code):
            respond(status, #"{"error":{"code":"\#(code)","message":"Synthetic rejection"}}"#)
        case .rateLimited(let status, let retryAfter):
            respond(status, #"{"error":{"code":"RATE_LIMITED","message":"Try again shortly."}}"#,
                    headers: ["Retry-After": "\(retryAfter)"])
        case nil:
            XCTFail("Unexpected send for \(clientID)")
            respond(500, #"{"error":{"code":"SERVER_ERROR","message":"Unexpected"}}"#)
        }
    }

    private static func store(_ clientID: String) {
        lock.withLock {
            if stored.insert(clientID).inserted { inserts += 1 }
        }
    }

    private func respond(_ status: Int, _ body: String, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: headers.merging(["Content-Type": "application/json"]) { $1 })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func message(clientID: String) -> String {
        #"{"id":"\#(storedMessageID)","client_message_id":"\#(clientID)","conversation_id":"\#(conversationID)","conversation_sequence":1,"sender_account_id":"acct_me","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"Hello"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":1,"generation_status":null,"provider_response_id":null,"created_at":"2026-11-10T10:00:00Z","edited_at":null,"deleted_at":null}"#
    }

    private static let bootstrap = #"{"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[]},"conversations":[{"id":"\#(conversationID)","kind":"direct","shared_title":null,"version":1,"created_by_account_id":"acct_me","legacy_session_id":"\#(sessionID)","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":0,"created_at":"2026-11-10T10:00:00Z","updated_at":"2026-11-10T10:00:00Z","members":[],"preferences":{"conversation_id":"\#(conversationID)","account_id":"acct_me","personal_title":null,"version":1}}],"latest_messages":[],"next_cursor":"cursor-1","last_stream_seq":1,"server_time":"2026-11-10T10:00:00Z"}"#

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
