import Foundation
import XCTest
@testable import Kordi

final class CloudSyncCatchUpTests: XCTestCase {
    override func tearDown() {
        SyncCatchUpURLProtocol.reset()
        super.tearDown()
    }

    func testNetworkErrorKeepsTheCursorAndTheNextReadResumesFromIt() async throws {
        let (api, session) = await client()
        defer { session.invalidateAndCancel() }
        SyncCatchUpURLProtocol.script = [.networkFailure, .page(next: "cursor-2", sequence: 2)]

        do {
            _ = try await api.sync(token: "session", cursor: "cursor-1")
            XCTFail("A dropped connection must fail the read")
        } catch {
            XCTAssertEqual((error as? CloudAPIError)?.code, "network_error")
            XCTAssertFalse(CloudSyncReloadPolicy.requiresFullReload(error))
        }
        let response = try await api.sync(token: "session", cursor: "cursor-1")

        XCTAssertFalse(response.isFullReload)
        XCTAssertEqual(response.cursor, "cursor-2")
        XCTAssertEqual(SyncCatchUpURLProtocol.requests, ["sync cursor-1", "sync cursor-1"])
    }

    func testOnlyTheCursorExpiredAnswerReloads() async throws {
        let (api, session) = await client()
        defer { session.invalidateAndCancel() }
        SyncCatchUpURLProtocol.script = [.failure(status: 409, code: "SYNC_CURSOR_EXPIRED", bootstrapRequired: true), .bootstrap]

        let response = try await api.sync(token: "session", cursor: "cursor-old")

        XCTAssertTrue(response.isFullReload)
        XCTAssertEqual(response.cursor, "cursor-bootstrap")
        XCTAssertEqual(SyncCatchUpURLProtocol.requests, ["sync cursor-old", "bootstrap"])
    }

    func testAStreamGapAlsoAsksForABootstrap() async throws {
        let (api, session) = await client()
        defer { session.invalidateAndCancel() }
        SyncCatchUpURLProtocol.script = [
            .failure(status: 500, code: "CHAT_SYNC_INVARIANT_VIOLATION", bootstrapRequired: true), .bootstrap
        ]

        let response = try await api.sync(token: "session", cursor: "cursor-gap")

        XCTAssertTrue(response.isFullReload)
        XCTAssertEqual(SyncCatchUpURLProtocol.requests, ["sync cursor-gap", "bootstrap"])
    }

    func testOtherServerErrorsNeverReload() async {
        for (status, code) in [(500, "SERVER_ERROR"), (503, "CHAT_SYNC_CURSOR_UNAVAILABLE"), (429, "RATE_LIMITED")] {
            let (api, session) = await client()
            SyncCatchUpURLProtocol.reset()
            SyncCatchUpURLProtocol.script = [.failure(status: status, code: code, bootstrapRequired: false)]
            do {
                _ = try await api.sync(token: "session", cursor: "cursor-1")
                XCTFail("\(code) must fail the read")
            } catch {
                XCTAssertEqual((error as? CloudAPIError)?.statusCode, status)
                XCTAssertFalse(CloudSyncReloadPolicy.requiresFullReload(error))
            }
            XCTAssertEqual(SyncCatchUpURLProtocol.requests, ["sync cursor-1"], code)
            session.invalidateAndCancel()
        }
    }

    func testResyncRequiredFrameCarriesItsReason() throws {
        let frame = try JSONDecoder().decode(
            CloudRealtimeServerFrame.self,
            from: Data(#"{"type":"resync_required","reason":"CLIENT_TOO_SLOW"}"#.utf8)
        )
        XCTAssertEqual(frame.type, "resync_required")
        XCTAssertEqual(frame.reason, "CLIENT_TOO_SLOW")
    }

    private func client() async -> (CloudAPIClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SyncCatchUpURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        await api.activateAccount("acct_me")
        return (api, session)
    }
}

/// Answers sync and bootstrap requests from a script, one step per request.
private final class SyncCatchUpURLProtocol: URLProtocol {
    enum Step {
        case page(next: String, sequence: Int)
        case bootstrap
        case networkFailure
        case failure(status: Int, code: String, bootstrapRequired: Bool)
    }

    private static let lock = NSLock()
    private static var steps: [Step] = []
    private static var recorded: [String] = []

    static var script: [Step] {
        get { lock.withLock { steps } }
        set { lock.withLock { steps = newValue } }
    }

    static var requests: [String] { lock.withLock { recorded } }

    static func reset() {
        lock.withLock {
            steps = []
            recorded = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "cursor" }?.value ?? ""
        let label = url.path == "/v2/chat/sync/bootstrap" ? "bootstrap" : "sync \(cursor)"
        let step: Step? = Self.lock.withLock {
            Self.recorded.append(label)
            return Self.steps.isEmpty ? nil : Self.steps.removeFirst()
        }
        switch step {
        case .page(let next, let sequence):
            respond(200, #"{"protocol_version":2,"events":[],"next_cursor":"\#(next)","last_stream_seq":\#(sequence),"has_more":false,"server_time":"2026-11-10T10:00:00Z"}"#)
        case .bootstrap:
            respond(200, #"{"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[]},"conversations":[],"latest_messages":[],"next_cursor":"cursor-bootstrap","last_stream_seq":40,"server_time":"2026-11-10T10:00:00Z"}"#)
        case .networkFailure:
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        case .failure(let status, let code, let bootstrapRequired):
            let details = bootstrapRequired ? #","details":{"bootstrap_required":true}"# : ""
            respond(status, #"{"error":{"code":"\#(code)","message":"Synthetic failure"\#(details)}}"#)
        case nil:
            XCTFail("Unexpected request: \(label)")
            respond(404, #"{"error":{"code":"CHAT_ENTITY_NOT_FOUND","message":"Unexpected"}}"#)
        }
    }

    private func respond(_ status: Int, _ body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
