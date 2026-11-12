import XCTest
import Foundation
import Combine
import SwiftUI
@testable import Kordi

final class OfflineChatRefreshTests: XCTestCase {
    func testWingKeepsItsPoseWhenPullBecomesRefreshAndRefreshBecomesSync() {
        var animation = KordiSyncMarkAnimation()
        animation.transition(to: .pulling(progress: 1), at: 10)
        let raised = animation.sample(at: 10)
        animation.transition(to: .refreshing, at: 11)
        let first = animation.sample(at: 11)
        XCTAssertEqual(first.wingAngle, raised.wingAngle, accuracy: 0.0001)
        XCTAssertEqual(first.bodyOffsetY, raised.bodyOffsetY, accuracy: 0.0001)
        var uninterrupted = animation
        animation.transition(to: .syncing, at: 11.17)
        for time in [11.17, 11.22, 11.50, 12.0] {
            XCTAssertEqual(animation.sample(at: time), uninterrupted.sample(at: time))
        }
        uninterrupted.transition(to: .idle, at: 12)
        XCTAssertEqual(uninterrupted.sample(at: 12), animation.sample(at: 12))
        uninterrupted.transition(to: .offline, at: 12.1)
        XCTAssertEqual(uninterrupted.sample(at: 12.3), .folded)
    }

    func testCancelledPullFoldsSmoothlyAndReboundPoseDoesNotAnimate() {
        var animation = KordiSyncMarkAnimation()
        animation.transition(to: .pulling(progress: 0.7), at: 10)
        let held = animation.sample(at: 10)
        XCTAssertEqual(animation.sample(at: 20), held)
        animation.transition(to: .idle, at: 20)
        XCTAssertEqual(animation.sample(at: 20), held)
        let halfway = animation.sample(at: 20.12)
        XCTAssertGreaterThan(halfway.wingAngle, held.wingAngle)
        XCTAssertLessThan(halfway.wingAngle, KordiBirdFlightSample.folded.wingAngle)
        XCTAssertEqual(animation.sample(at: 20.3), .folded)
    }

    @MainActor
    func testRestAndFlightUseTheSameWingAndPaletteInBothThemes() throws {
        for scheme in [ColorScheme.light, .dark] {
            func render(_ pose: KordiBirdPose) throws -> Data {
                let renderer = ImageRenderer(content: KordiMark(size: 96, pose: pose)
                    .padding(32).environment(\.colorScheme, scheme))
                renderer.scale = 2
                return try XCTUnwrap(renderer.uiImage?.pngData())
            }
            XCTAssertEqual(try render(.still), try render(.flight(.folded)),
                           "Rest and flight must not swap an ink wing for a transparent cutout")
        }
    }

    @MainActor
    func testRepeatedDirectorySnapshotDoesNotInvalidatePagesButProfileChangesDo() throws {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        var account = try XCTUnwrap(model.account)
        var contacts = model.contacts
        XCTAssertFalse(contacts.isEmpty)
        model.applyWorkspaceDirectory(account: account, contacts: contacts)
        var publications = 0
        let observation = model.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }

        model.applyWorkspaceDirectory(account: account, contacts: Array(contacts.reversed()))
        XCTAssertEqual(publications, 0, "An identical refresh must not redraw every observing page")
        account.about = "Updated profile"
        contacts[0].subtitle = "Updated contact"
        model.applyWorkspaceDirectory(account: account, contacts: contacts)
        XCTAssertEqual(publications, 2)
        XCTAssertEqual(model.account?.about, "Updated profile")
        XCTAssertEqual(model.contacts.first { $0.id == contacts[0].id }?.subtitle, "Updated contact")
        model.applyWorkspaceDirectory(account: account, contacts: contacts)
        XCTAssertEqual(publications, 2)
    }

    @MainActor
    func testRepeatedAuthenticationSnapshotDoesNotInvalidatePagesButRevocationDoes() {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let profile = CloudProviderAuthSnapshot(
            snapshotId: "refresh-fixture", provider: "openai", authChoice: "api-key",
            createdAt: "2026-01-01T00:00:00Z", revokedAt: nil
        )
        model.applyProviderAuthProfiles([profile], loaded: true)
        var publications = 0
        let observation = model.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        model.applyProviderAuthProfiles([profile], loaded: true)
        XCTAssertEqual(publications, 0)
        model.applyProviderAuthProfiles([], loaded: true)
        XCTAssertGreaterThan(publications, 0)
        XCTAssertTrue(model.providerAuthProfiles.isEmpty)
        XCTAssertNil(model.authenticationSnapshot(for: "openai"))
        XCTAssertFalse(model.hasConfiguredProviderAuthentication)
    }

    @MainActor
    func testLeavingDuringReboundCancelsOnlyTheQueuedRefresh() {
        let state = ChatPullRefreshState()
        state.setScrollIdle(false)
        state.updatePullDistance(100)
        XCTAssertTrue(state.beginRefresh())
        state.cancelPendingRefresh()
        state.setScrollIdle(true)
        state.updatePullDistance(0)
        XCTAssertFalse(state.takePendingRefresh())
        XCTAssertEqual(state.visualState, .idle)

        state.updatePullDistance(100)
        XCTAssertTrue(state.beginRefresh())
        state.updatePullDistance(0)
        XCTAssertTrue(state.takePendingRefresh())
        state.cancelPendingRefresh()
        XCTAssertEqual(state.visualState, .refreshing, "An already-started request owns its completion")
    }

    @MainActor
    func testRefreshWaitsForReboundGeometryAndIdlePhaseInEitherOrder() {
        for geometryArrivesFirst in [true, false] {
            let state = ChatPullRefreshState()
            state.setScrollIdle(false)
            state.updatePullDistance(100)
            XCTAssertTrue(state.beginRefresh())
            XCTAssertEqual(state.visualState, .rebounding, "Acknowledge the pull immediately")
            let reboundMotion = MessageSyncStatusBehavior.motion(
                pullState: state.visualState, messageSyncState: .syncing, isLoadingMessages: true
            )
            XCTAssertFalse(reboundMotion.runsContinuously, "Do not run a toolbar timeline during native rebound")
            XCTAssertFalse(state.takePendingRefresh(), "Do not invalidate the list while it rebounds")

            if geometryArrivesFirst { state.updatePullDistance(0) }
            else { state.setScrollIdle(true) }
            XCTAssertFalse(state.takePendingRefresh(), "Both settled geometry and an idle phase are required")

            if geometryArrivesFirst { state.setScrollIdle(true) }
            else { state.updatePullDistance(0) }
            XCTAssertTrue(state.takePendingRefresh())
            XCTAssertEqual(state.visualState, .refreshing)
            XCTAssertFalse(state.takePendingRefresh(), "Consume a queued refresh exactly once")
            state.finishRefresh()
            XCTAssertEqual(state.visualState, .idle)
        }
    }

    @MainActor
    func testRegrabbingTheListKeepsRefreshQueuedUntilTheSecondReleaseSettles() {
        let state = ChatPullRefreshState()
        state.setScrollIdle(false)
        state.updatePullDistance(100)
        XCTAssertTrue(state.beginRefresh())
        state.updatePullDistance(0)
        state.updatePullDistance(120)
        XCTAssertFalse(state.beginRefresh())
        state.setScrollIdle(true)
        XCTAssertFalse(state.takePendingRefresh())
        state.updatePullDistance(0)
        XCTAssertTrue(state.takePendingRefresh())
        XCTAssertFalse(state.takePendingRefresh())
    }

    @MainActor
    func testCachedCatalogRestoresArchiveWithoutExposingDeletedOrOtherAccountChats() async throws {
        let cache = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: cache, previewMode: true, previewLaunchFlow: false)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let people = model.conversations.filter { $0.kind == .person }
        XCTAssertGreaterThan(people.count, 1)
        let archived = people[0]
        let deleted = people[1]
        let didArchive = await model.archiveConversation(archived)
        XCTAssertTrue(didArchive)
        XCTAssertTrue(cache.loadConversations(accountId: accountID).contains { $0.id == archived.id },
                      "Archiving must preserve the row in the local catalog")

        model.restoreCachedConversationCatalog(accountId: accountID, visibility: CloudSessionVisibility(
            hiddenSessionIds: [archived.sessionId, deleted.sessionId],
            deletedSessionIds: [deleted.sessionId], pinnedSessionIds: nil,
            mutedSessionIds: nil, unreadSessionIds: nil, pinnedGroupSpaceIds: nil
        ))
        XCTAssertEqual(model.archivedConversations.map(\.id), [archived.id])
        XCTAssertFalse(model.conversations.contains { [archived.id, deleted.id].contains($0.id) })

        let visible = model.conversations
        model.restoreCachedConversationCatalog(accountId: "another-account", visibility: CloudSessionVisibility(
            hiddenSessionIds: [], deletedSessionIds: [], pinnedSessionIds: nil,
            mutedSessionIds: nil, unreadSessionIds: nil, pinnedGroupSpaceIds: nil
        ))
        XCTAssertEqual(model.conversations, visible)
        XCTAssertEqual(model.archivedConversations.map(\.id), [archived.id])
    }

    @MainActor
    func testPullRefreshIgnoresBounceAndRequiresANewPullAfterCompletion() {
        let state = ChatPullRefreshState()
        state.updatePullDistance(20)
        XCTAssertFalse(state.beginRefresh())
        state.updatePullDistance(ChatPullToRefreshBehavior.triggerDistance)
        XCTAssertEqual(state.visualState, .pulling(progress: 1))
        XCTAssertTrue(state.beginRefresh())

        for distance in [0.0, 120.0, 0.0] {
            state.updatePullDistance(distance)
            XCTAssertEqual(state.visualState, .rebounding)
            XCTAssertFalse(state.beginRefresh(), "Bounce and duplicate release events must not launch another request")
        }

        state.finishRefresh()
        XCTAssertEqual(state.visualState, .idle)
        XCTAssertFalse(state.beginRefresh())
        state.updatePullDistance(ChatPullToRefreshBehavior.triggerDistance)
        XCTAssertTrue(state.beginRefresh(), "A later deliberate pull must still work")
    }

    @MainActor
    func testCatalogPublishesOneCompleteAgentActivitySnapshot() async {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        var snapshots: [[String: AgentActivity]] = []
        let subscription = model.$agentRunState.dropFirst().sink { snapshots.append($0) }
        defer { subscription.cancel() }

        await model.rebuildConversationCatalog()

        XCTAssertGreaterThan(model.agentRunState.count, 1)
        XCTAssertEqual(snapshots.count, 1, "A catalog refresh must publish one snapshot, not one per agent session")
        XCTAssertEqual(snapshots.last, model.agentRunState)
    }

    @MainActor
    func testLargeCatalogPublishesOneActivitySnapshotAndNoneForAnUnchangedRefresh() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LargeAgentCatalogProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        let model = AppModel(api: api, cache: try LocalMessageStore(inMemory: true),
                             previewMode: true, previewLaunchFlow: false)
        await api.activateAccount("acct_me")
        _ = try await api.bootstrapChatLatestMessages(token: "synthetic-test-token")
        var activityUpdates = 0
        let subscription = model.$agentRunState.dropFirst().sink { _ in activityUpdates += 1 }
        defer { subscription.cancel() }

        await model.rebuildConversationCatalog()
        XCTAssertGreaterThanOrEqual(model.agentRunState.count, LargeAgentCatalogProtocol.sessionCount)
        XCTAssertEqual(activityUpdates, 1, "Publishing work must not grow with the number of sessions")
        activityUpdates = 0
        await model.rebuildConversationCatalog()
        XCTAssertEqual(activityUpdates, 0)
    }

    @MainActor
    func testUnchangedCatalogDoesNotRepublishAgentActivityOrMessages() async {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        await model.rebuildConversationCatalog()
        let expectedActivity = model.agentRunState
        let expectedMessages = model.messagesByConversation
        XCTAssertFalse(expectedActivity.isEmpty)
        var activityUpdates = 0
        var messageUpdates = 0
        let activitySubscription = model.$agentRunState.dropFirst().sink { _ in activityUpdates += 1 }
        let messageSubscription = model.$messagesByConversation.dropFirst().sink { _ in messageUpdates += 1 }
        defer {
            activitySubscription.cancel()
            messageSubscription.cancel()
        }

        for _ in 0..<5 { await model.rebuildConversationCatalog() }

        XCTAssertEqual(model.agentRunState, expectedActivity)
        XCTAssertEqual(model.messagesByConversation, expectedMessages)
        XCTAssertEqual(activityUpdates, 0, "Unchanged activity must not invalidate every app-model observer")
        XCTAssertEqual(messageUpdates, 0, "An unchanged message-key reconciliation must not publish a write")
    }

    @MainActor
    func testPullToRefreshKeepsOfflineConversationsAndDoesNotContactCloud() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RejectPreviewNetwork.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        let model = AppModel(api: api, previewMode: true, previewLaunchFlow: false)
        let conversations = model.conversations.map(\.id)
        await model.refreshWorkspace()
        XCTAssertEqual(model.conversations.map(\.id), conversations)
        XCTAssertEqual(model.cloudConnectionState, .connected)
        XCTAssertEqual(model.messageSyncState, .upToDate)
        XCTAssertNil(model.errorMessage)
    }
}

private final class RejectPreviewNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Offline chat refresh must not issue an HTTP request")
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}

/// Synthetic catalog only: URLProtocol intercepts every request; no server is used.
private final class LargeAgentCatalogProtocol: URLProtocol {
    static let sessionCount = 2_000

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard request.url?.path == "/v2/chat/sync/bootstrap", let url = request.url else {
            XCTFail("Unexpected request in the synthetic catalog regression")
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let stamp = "2026-08-08T10:00:00Z"
        let conversations = (0..<Self.sessionCount).map { index in
            let id = "synthetic-agent-\(index)"
            return CloudChatConversation(
                id: id, kind: "ai", sharedTitle: "Synthetic session \(index)", version: 1,
                createdByAccountId: "acct_me", legacySessionId: "session:self-agent:synthetic-\(index)",
                forkedFromSessionId: nil, forkedFromMessageId: nil, latestMessageSequence: 1,
                createdAt: stamp, updatedAt: stamp, members: [],
                preferences: CloudChatPreferences(conversationId: id, accountId: "acct_me", personalTitle: nil, version: 1)
            )
        }
        let bootstrap = CloudChatBootstrapResponse(
            sessionVisibility: CloudSessionVisibility(hiddenSessionIds: [], deletedSessionIds: [],
                pinnedSessionIds: [], mutedSessionIds: [], unreadSessionIds: [], pinnedGroupSpaceIds: []),
            protocolVersion: 2, conversations: conversations, latestMessages: [], sessionPins: [],
            nextCursor: "synthetic-cursor", lastStreamSequence: 0, serverTime: stamp
        )
        do {
            let data = try JSONEncoder().encode(bootstrap)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
}
