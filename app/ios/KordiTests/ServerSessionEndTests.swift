import XCTest
@testable import Kordi

/// Which answers end the session. Only a real server answer counts.
final class ServerSessionEndClassificationTests: XCTestCase {
    private func server(_ code: String, _ status: Int = 401) -> CloudAPIError {
        CloudAPIError(code: code, message: "", statusCode: status, fromServer: true)
    }

    func testServerAnswersEndTheSession() {
        XCTAssertEqual(ServerSessionEnd(server("account_deleted")), .accountDeleted)
        XCTAssertEqual(ServerSessionEnd(server("invalid_session")), .signedOut)
        XCTAssertEqual(ServerSessionEnd(server("login_required")), .signedOut)
    }

    func testLocalErrorsOtherCodesAndNetworkFailuresDoNot() {
        // Made up by the app itself, without a server answer.
        XCTAssertNil(ServerSessionEnd(CloudAPIError(code: "invalid_session", message: "", statusCode: 401)))
        XCTAssertNil(ServerSessionEnd(CloudAPIError(code: "account_deleted", message: "", statusCode: 401)))
        XCTAssertNil(ServerSessionEnd(CloudAPIError(code: "account_missing", message: "", statusCode: 401)))
        // Other server answers.
        XCTAssertNil(ServerSessionEnd(server("unauthorized")))
        XCTAssertNil(ServerSessionEnd(server("server_error")))
        XCTAssertNil(ServerSessionEnd(server("account_deleted", 403)))
        XCTAssertNil(ServerSessionEnd(server("invalid_session", 409)))
        // Transport failures.
        XCTAssertNil(ServerSessionEnd(CloudAPIError(code: "network_error", message: "", statusCode: 0)))
        XCTAssertNil(ServerSessionEnd(URLError(.notConnectedToInternet)))
        XCTAssertNil(ServerSessionEnd(CancellationError()))
    }

    func testLaunchErrorsCountAsServerAnswers() {
        XCTAssertEqual(ServerSessionEnd(ServerSessionEnd.accountDeleted.launchError), .accountDeleted)
        XCTAssertEqual(ServerSessionEnd(ServerSessionEnd.signedOut.launchError), .signedOut)
    }
}

/// `CloudAPIClient` marks only errors it read from a server response.
final class ServerSessionEndClientTests: XCTestCase {
    private func client() -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionEndStub.self]
        return CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:9")!, session: URLSession(configuration: configuration))
    }

    override func tearDown() {
        SessionEndStub.reset()
        super.tearDown()
    }

    func testServerRefusalIsMarked() async {
        SessionEndStub.configure { _ in .accountDeleted }
        do {
            _ = try await client().me(token: "synthetic-session")
            XCTFail("Expected a refusal")
        } catch {
            let apiError = error as? CloudAPIError
            XCTAssertEqual(apiError?.code, "account_deleted")
            XCTAssertEqual(apiError?.statusCode, 401)
            XCTAssertEqual(apiError?.fromServer, true)
            XCTAssertEqual(ServerSessionEnd(error), .accountDeleted)
        }
    }

    func testRefusalWithoutAServerErrorCodeIsNotMarked() async {
        // A proxy or captive portal page, not Kordi Cloud.
        SessionEndStub.configure { _ in .init(status: 401, body: "<html>Sign in to Wi-Fi</html>") }
        do {
            _ = try await client().me(token: "synthetic-session")
            XCTFail("Expected a refusal")
        } catch {
            XCTAssertEqual((error as? CloudAPIError)?.fromServer, false)
            XCTAssertNil(ServerSessionEnd(error))
        }
    }

    func testNetworkFailureIsNotMarked() async {
        SessionEndStub.configure { _ in .offline }
        do {
            _ = try await client().me(token: "synthetic-session")
            XCTFail("Expected a failure")
        } catch {
            XCTAssertEqual((error as? CloudAPIError)?.code, "network_error")
            XCTAssertEqual((error as? CloudAPIError)?.fromServer, false)
            XCTAssertNil(ServerSessionEnd(error))
        }
    }
}

/// A browser sign-in refresh refused for a deleted account.
final class ServerSessionEndRefreshTests: XCTestCase {
    private var keychain: KeychainSessionStore!

    override func setUp() {
        super.setUp()
        let suite = "kordi.tests.session-end-refresh.\(UUID().uuidString)"
        keychain = KeychainSessionStore(service: suite, developmentDefaults: UserDefaults(suiteName: suite)!)
    }

    override func tearDown() {
        try? keychain.deleteToken()
        super.tearDown()
    }

    private func refresh(status: Int, body: String) async throws -> AppSignInSessionStore.RefreshResult {
        let stored = AppSignInCredential(
            accountId: "acct_viewer",
            clientId: "kordi-ios-beta",
            tokenEndpoint: URL(string: "https://cloud.example.test/v1/cloud/auth/app/token")!,
            accessToken: "kordi_cs_old",
            refreshToken: "kordi_rt_old",
            expiresAt: Date().addingTimeInterval(60)
        )
        try keychain.saveAppSignInCredential(stored)
        try keychain.saveToken(stored.accessToken)
        let store = AppSignInSessionStore(keychain: keychain, transport: { request in
            let response: URLResponse = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), response)
        }, holdsBackgroundTime: false)
        return await store.refresh(ifExpiringWithin: 300)
    }

    func testAClearlyMarkedDeletionIsReportedAsDeletion() async throws {
        let marked = [
            #"{"error":"invalid_grant","errorCode":"account_deleted"}"#,
            #"{"error":"invalid_grant","error_code":"account_deleted"}"#,
            #"{"error":"invalid_grant","reason":"account_deleted"}"#,
            #"{"error":"account_deleted"}"#,
        ]
        for body in marked {
            let result = try await refresh(status: 400, body: body)
            XCTAssertEqual(result, .accountDeleted, body)
        }
        let unauthorized = try await refresh(status: 401, body: marked[0])
        XCTAssertEqual(unauthorized, .accountDeleted)
    }

    func testEveryOtherRefusalBehavesAsBefore() async throws {
        let plain = try await refresh(status: 400, body: #"{"error":"invalid_grant","errorCode":"invalid_grant"}"#)
        XCTAssertEqual(plain, .rejected)
        // Free text never counts as the marker.
        let described = try await refresh(status: 400, body: #"{"error":"invalid_grant","error_description":"account_deleted"}"#)
        XCTAssertEqual(described, .rejected)
        // Not a refusal: no usable answer, as before.
        let outage = try await refresh(status: 503, body: #"{"errorCode":"account_deleted"}"#)
        XCTAssertEqual(outage, .unavailable)
    }
}

/// The app model's handler, its launch path, and what a sign-out forgets.
@MainActor
final class ServerSessionEndAppModelTests: XCTestCase {
    private let accountId = "acct_viewer"
    private var suite = ""
    private var defaults: UserDefaults!
    private var keychain: KeychainSessionStore!
    private var directory: URL!
    private var cache: LocalMessageStore!
    private var wireCache: CloudWireCache!
    private var session: URLSession!
    private var notificationRemovals = 0
    private var callTeardowns = 0

    override func setUp() async throws {
        try await super.setUp()
        suite = "kordi.tests.session-end.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        keychain = KeychainSessionStore(service: suite, developmentDefaults: defaults)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite, isDirectory: true)
        cache = try LocalMessageStore(inMemory: true)
        wireCache = CloudWireCache(directory: directory)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionEndStub.self]
        session = URLSession(configuration: configuration)
        notificationRemovals = 0
        callTeardowns = 0
    }

    override func tearDown() async throws {
        SessionEndStub.reset()
        session.invalidateAndCancel()
        try? keychain.deleteToken()
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    // MARK: Running session

    func testDeletedAccountIsWipedOnceWhileRequestsFailTogether() async throws {
        try await seedSignedInData()
        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .accountDeleted }
        let model = makeModel()

        // The sync pass and the workspace refresh both hear `account_deleted`.
        await model.start()
        try await eventually("the teardown finished") { model.phase == .signedOut && model.serverSessionEndTask == nil }

        XCTAssertEqual(callTeardowns, 1)
        XCTAssertEqual(notificationRemovals, 1)
        XCTAssertNil(model.account)
        XCTAssertNil(model.sessionToken)
        XCTAssertTrue(model.conversations.isEmpty)
        XCTAssertNil(model.errorMessage, "a deleted account shows no retry notice")
        XCTAssertNil(try keychain.loadToken())
        try await assertAccountCachesCleared()
        assertReaderIdentityForgotten()
        XCTAssertNil(defaults.string(forKey: "organization.selected.\(accountId)"), "the wipe removes account-scoped defaults")
        XCTAssertNil(defaults.string(forKey: "commonGround.nearby.device"))
        XCTAssertFalse(SessionEndStub.paths.contains("/v1/cloud/auth/logout"), "no logout call for an ended session")
        XCTAssertFalse(SessionEndStub.paths.contains("/v1/cloud/presence/offline"))
    }

    func testSignedOutSessionShowsSignInWithoutWipingOrLoggingOut() async throws {
        try await seedSignedInData()
        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .invalidSession }
        let model = makeModel()

        await model.start()
        try await eventually("the sign-out finished") { model.phase == .signedOut && model.serverSessionEndTask == nil }

        XCTAssertEqual(callTeardowns, 0)
        XCTAssertEqual(notificationRemovals, 1)
        XCTAssertNil(model.account)
        XCTAssertEqual(model.errorMessage, AppModel.sessionEndedNotice)
        XCTAssertNil(try keychain.loadToken())
        try await assertAccountCachesCleared()
        assertReaderIdentityForgotten()
        XCTAssertEqual(defaults.string(forKey: "organization.selected.\(accountId)"), "org_personal", "no wipe for a sign-out")
        XCTAssertFalse(SessionEndStub.paths.contains("/v1/cloud/auth/logout"))
    }

    func testNetworkFailuresAndUnavailableAnswersKeepTheSession() async throws {
        try await seedSignedInData()
        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .offline }
        let model = makeModel()

        await model.start()
        XCTAssertEqual(model.phase, .signedIn)
        XCTAssertNil(model.serverSessionEndTask)

        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .unavailable }
        await model.refreshWorkspace()
        XCTAssertEqual(model.phase, .signedIn)
        XCTAssertNil(model.serverSessionEndTask)
        XCTAssertEqual(callTeardowns, 0)
        XCTAssertEqual(notificationRemovals, 0)
        XCTAssertNotNil(try keychain.loadToken())
        await model.signOut()
    }

    func testOnlyTheCurrentSignInCanBeEnded() async throws {
        try await seedSignedInData()
        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .unavailable }
        let model = makeModel()
        await model.start()

        // A token this sign-in never used, and one that may have rotated out.
        XCTAssertNil(model.endSession(.accountDeleted, token: "kordi_cs_other"))
        XCTAssertNil(model.endSession(.signedOut, token: "kordi_cs_rotated"))
        XCTAssertNil(model.endSession(.signedOut, token: nil))
        XCTAssertEqual(model.phase, .signedIn)
        await model.signOut()

        // Signed out and preview sessions are never ended again.
        XCTAssertNil(model.endSession(.accountDeleted, token: "synthetic-session"))
        let preview = AppModel(previewMode: true, previewLaunchFlow: false)
        XCTAssertNil(preview.endSession(.accountDeleted, token: preview.sessionToken))
        XCTAssertEqual(preview.phase, .signedIn)
    }

    func testReportsArrivingTogetherShareOneTeardown() async throws {
        try await seedSignedInData()
        SessionEndStub.configure { path in path == "/v1/cloud/auth/me" ? .account : .unavailable }
        let model = makeModel()
        await model.start()
        let token = model.sessionToken

        let first = try XCTUnwrap(model.endSession(.signedOut, token: token))
        let second = model.endSession(.accountDeleted, token: token)
        let third = model.endSession(.accountDeleted, token: token)
        XCTAssertEqual(second, first)
        XCTAssertEqual(third, first)
        await first.value

        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(callTeardowns, 1, "the deletion reported during the sign-out still ends calls")
        XCTAssertEqual(notificationRemovals, 1)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(defaults.string(forKey: "organization.selected.\(accountId)"), "and still wipes")
        XCTAssertNil(model.endSession(.accountDeleted, token: token))
    }

    // MARK: Launch

    func testRefusedLaunchClearsWhatASignOutClears() async throws {
        try await seedSignedInData()
        cache.saveConversations([conversation("person:other-account")], accountId: "acct_other")
        await wireCache.save(accountId: "acct_other", cursor: "cursor-other", messagesByPeer: [:])
        SessionEndStub.configure { _ in .invalidSession }
        let model = makeModel()

        await model.start()

        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.account)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(try keychain.loadToken())
        try await assertAccountCachesCleared()
        // Nobody is signed in, so no account's cache stays.
        XCTAssertTrue(cache.loadConversations(accountId: "acct_other").isEmpty)
        let other = await wireCache.load(accountId: "acct_other")
        XCTAssertNil(other)
        assertReaderIdentityForgotten()
        XCTAssertNil(CommonGroundNearbyLocator.shared.state)
        XCTAssertEqual(notificationRemovals, 1)
        XCTAssertEqual(callTeardowns, 0)
        XCTAssertEqual(SessionEndStub.paths, ["/v1/cloud/auth/me"], "nothing else is asked of the server")
    }

    func testDeletedAccountAtLaunchIsWiped() async throws {
        try await seedSignedInData()
        // A browser sign-in names the stored account before the server refuses it.
        let endpoint = KordiAppEnvironment.current.cloudBaseURL.appendingPathComponent("v1/cloud/auth/app/token")
        try keychain.saveAppSignInCredential(AppSignInCredential(
            accountId: accountId, clientId: "kordi-ios-beta", tokenEndpoint: endpoint,
            accessToken: "synthetic-session", refreshToken: "synthetic-refresh",
            expiresAt: Date().addingTimeInterval(3_600)
        ))
        SessionEndStub.configure { _ in .accountDeleted }
        let model = makeModel()

        await model.start()

        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(try keychain.loadToken())
        XCTAssertNil(try keychain.loadAppSignInCredential())
        try await assertAccountCachesCleared()
        assertReaderIdentityForgotten()
        XCTAssertNil(defaults.string(forKey: "organization.selected.\(accountId)"))
        XCTAssertEqual(callTeardowns, 1)
        XCTAssertFalse(SessionEndStub.paths.contains("/v1/cloud/auth/app/revoke"))
    }

    // MARK: Reader identity

    func testReaderIdentityDoesNotCarryOverToTheNextAccount() async {
        defaults.set("reader-key-of-the-first-account", forKey: DocumentReaderModel.readerKeyDefaultsKey)
        defaults.set("Avery", forKey: DocumentReaderModel.readerNameDefaultsKey)
        let model = makeModel()

        await model.signOut()

        assertReaderIdentityForgotten()
        let reader = DocumentReaderModel(
            request: DocumentReaderRequest(source: .attachment("att_synthetic"), title: "Plan"),
            service: PreviewDocumentService(),
            defaults: defaults
        )
        XCTAssertNil(reader.storedReaderName, "the next account is asked for its own name")
    }

    // MARK: Helpers

    private func makeModel() -> AppModel {
        let model = AppModel(
            api: CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:9")!, session: session),
            keychain: keychain,
            shareCredentialStore: ShareExtensionCredentialStore(configuration: nil),
            cache: cache,
            wireCache: wireCache,
            localDefaults: defaults,
            removeAccountNotifications: { [weak self] in self?.notificationRemovals += 1 },
            previewMode: false,
            previewLaunchFlow: false
        )
        model.prepareCallsForAccountTeardown = { [weak self] in self?.callTeardowns += 1 }
        return model
    }

    private func seedSignedInData() async throws {
        try keychain.saveToken("synthetic-session")
        cache.saveConversations([conversation("person:acct_nadia")], accountId: accountId)
        await wireCache.save(accountId: accountId, cursor: "cursor-start", messagesByPeer: [:], sessionForksById: [:],
                             visibility: CloudSessionVisibility(
                                hiddenSessionIds: [], deletedSessionIds: [], pinnedSessionIds: [],
                                mutedSessionIds: [], unreadSessionIds: [], pinnedGroupSpaceIds: []))
        defaults.set("reader-key-of-the-first-account", forKey: DocumentReaderModel.readerKeyDefaultsKey)
        defaults.set("Avery", forKey: DocumentReaderModel.readerNameDefaultsKey)
        defaults.set("org_personal", forKey: "organization.selected.\(accountId)")
        defaults.set("on", forKey: "commonGround.nearby.device")
    }

    private func assertAccountCachesCleared(file: StaticString = #filePath, line: UInt = #line) async throws {
        XCTAssertTrue(cache.loadConversations(accountId: accountId).isEmpty, "cached conversations", file: file, line: line)
        let snapshot = await wireCache.load(accountId: accountId)
        XCTAssertNil(snapshot, "sync snapshot", file: file, line: line)
    }

    private func assertReaderIdentityForgotten(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(defaults.string(forKey: DocumentReaderModel.readerKeyDefaultsKey), file: file, line: line)
        XCTAssertNil(defaults.string(forKey: DocumentReaderModel.readerNameDefaultsKey), file: file, line: line)
    }

    private func conversation(_ id: String) -> ConversationSummary {
        ConversationSummary(
            id: id, kind: .person, peerAccountId: "acct_nadia", agentId: nil,
            ownerDisplayName: "Nadia", displayName: "Nadia", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "session:\(id)"
        )
    }

    private func eventually(
        _ description: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                return XCTFail("Timed out waiting until \(description)", file: file, line: line)
            }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

/// Answers every request from a per-test rule; nothing reaches a backend.
private final class SessionEndStub: URLProtocol {
    struct Reply {
        var status: Int
        var body: String
        var fails = false

        static let account = Reply(status: 200, body: #"{"accountId":"acct_viewer","displayName":"Viewer","passwordSet":true,"avatar":{"entityType":"account","entityId":"acct_viewer","source":"generated","style":"lorelei","seed":"viewer","rendererVersion":"test","version":1,"updatedAt":""}}"#)
        static let accountDeleted = Reply(status: 401, body: #"{"errorCode":"account_deleted","message":"This account was deleted."}"#)
        static let invalidSession = Reply(status: 401, body: #"{"errorCode":"invalid_session","message":"Session is expired or revoked."}"#)
        static let unavailable = Reply(status: 503, body: #"{"errorCode":"temporarily_unavailable","message":"Try again."}"#)
        static let offline = Reply(status: 0, body: "", fails: true)
    }

    private static let lock = NSLock()
    private static var rule: (String) -> Reply = { _ in .offline }
    private static var recorded: [String] = []

    static var paths: [String] { lock.withLock { recorded } }

    static func configure(_ rule: @escaping (String) -> Reply) {
        lock.withLock { self.rule = rule }
    }

    static func reset() {
        lock.withLock {
            rule = { _ in .offline }
            recorded = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let reply = Self.lock.withLock {
            Self.recorded.append(path)
            return Self.rule(path)
        }
        if reply.fails {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
