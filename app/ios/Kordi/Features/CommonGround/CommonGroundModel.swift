import Foundation
import SwiftUI

/// Common ground state for the signed-in account: the owner's card, rooms,
/// results, matches and people. Screens drive polling
/// through the wait and refresh calls; every failure becomes `notice`.
@MainActor
final class CommonGroundModel: ObservableObject {
    typealias Context = @MainActor () throws -> (CloudAPIClient, String)

    nonisolated static let buildPollInterval: Duration = .seconds(3)
    /// Looks at the card after a build request got no answer, this far apart.
    nonisolated static let buildCheckInterval: Duration = .seconds(2)
    static let buildStartChecks = 3
    static let buildNotStarted = "Could not start building. Try again."
    nonisolated static let lobbyPollInterval: Duration = .seconds(2)
    nonisolated static let matchPollInterval: Duration = .seconds(3)
    /// The matching poll once a sync hint showed that hints arrive.
    nonisolated static let hintedMatchPollInterval: Duration = .seconds(20)
    /// An open room's ready Results look again this often, in case a hint was missed.
    nonisolated static let fallbackPollInterval: Duration = .seconds(60)
    /// Home reloads cards on appear and on foreground at most this often.
    nonisolated static let syncInterval: TimeInterval = 30
    /// Typed tags stay short enough to read at a glance.
    static let tagMax = 40
    static let roomNotFound = "Room not found."

    let me: CommonGroundPerson
    private let context: Context
    /// `commonGroundVersion` 2: profiles. Off, every call acts as before.
    let profilesEnabled: Bool
    /// `memoryVersion` 2: memories routed to profiles, listed on the card page.
    let memoriesEnabled: Bool
    /// `memoryVersion` 3: Add to card and Remove from card on the card page.
    let cardChoicesEnabled: Bool
    /// `commonGroundNearbyVersion` 1: the Nearby row and screens.
    let nearbyEnabled: Bool
    let defaults: UserDefaults

    @Published private(set) var owner: CommonGroundOwnerView?
    @Published private(set) var loaded = false
    @Published private(set) var recent: [CommonGroundRecentEntry] = []
    @Published private(set) var rooms: [String: CommonGroundRoom] = [:]
    /// Rooms to come back to; nil while unknown or when the server has no list.
    @Published private(set) var roomList: [CommonGroundRoomSummary]?
    @Published private(set) var results: [String: CommonGroundResults] = [:]
    /// Set here and in CommonGroundModel+People.swift.
    @Published var matches: [String: CommonGroundMatch] = [:]
    @Published var people: [String: CommonGroundPersonCard] = [:]
    /// Relationship updates after an action, newer than any loaded view.
    @Published var relationships: [String: CommonGroundRelationship] = [:]
    @Published var busy: String?
    /// One line shown as a toast over every screen.
    @Published var notice: String?
    /// Shows "AI models are off" when the server refuses AI work.
    var onAIConsentRequired: (() -> Void)?
    /// Set in CommonGroundModel+Profiles.swift.
    @Published var profiles: [CommonGroundProfileSummary] = []
    @Published var currentProfileID: String?
    /// Each profile's shared topics for the wallet, set in CommonGroundModel+Wallet.swift.
    @Published var walletTopics: [String: [String]] = [:]
    /// Rooms looked up by code before joining.
    @Published var roomPreviews: [String: CommonGroundRoomPreview] = [:]
    /// The current profile's routed memories, set in CommonGroundModel+Memories.swift.
    @Published var profileMemories: [CloudProfileMemory] = []
    /// Nearby settings, people and requests, set in CommonGroundModel+Nearby.swift.
    @Published var nearby = CommonGroundNearbyState()
    /// The viewer's profile to see each person through, from Recent or a room.
    var viewerProfiles: [String: String] = [:]
    /// The last code looked up; an answer for any other code is stale.
    var latestLookup: String?
    /// When Home last reloaded, for the 30-second throttle.
    var lastSync: Date?
    /// The one-time move of designs kept on this device, run in the background.
    var designMove: Task<Void, Never>?
    /// Whether a sync hint has arrived, so polls can slow down; set in CommonGroundSyncHints.swift.
    var hintsArrived: Bool
    /// The refresh loops of screens on display, woken by sync hints.
    var hintWakes: [CommonGroundHintWake] = []
    private var hintObserver: NSObjectProtocol?

    init(me: CommonGroundPerson, profilesEnabled: Bool = false, memoriesEnabled: Bool = false, cardChoicesEnabled: Bool = false,
         nearbyEnabled: Bool = false, defaults: UserDefaults = .standard, context: @escaping Context) {
        self.me = me
        self.context = context
        self.profilesEnabled = profilesEnabled
        self.memoriesEnabled = memoriesEnabled
        self.cardChoicesEnabled = cardChoicesEnabled
        self.nearbyEnabled = nearbyEnabled
        self.defaults = defaults
        hintsArrived = CommonGroundSyncHint.arrivedThisSession
        hintObserver = NotificationCenter.default.addObserver(
            forName: .kordiCommonGroundHint, object: nil, queue: .main
        ) { [weak self] notification in
            guard let hint = notification.object as? CommonGroundSyncHint else { return }
            MainActor.assumeIsolated { self?.receive(hint) }
        }
    }

    deinit {
        if let hintObserver { NotificationCenter.default.removeObserver(hintObserver) }
    }

    /// The profile card calls act on; nil before profiles.
    var activeProfileID: String? { profilesEnabled ? currentProfileID : nil }

    /// The active profile's kind; Work when there is none, as the server builds.
    var activeProfileKind: CommonGroundProfileKind {
        profiles.first { $0.profileId == activeProfileID }
            .flatMap { CommonGroundProfileKind(rawValue: $0.kind) } ?? .work
    }

    var card: CommonGroundOwnCard? { owner?.card }
    var hasCard: Bool { owner?.card != nil }
    var isBuilding: Bool { owner?.build.status == "building" }
    var buildFailed: Bool { owner?.build.status == "failed" }
    var sharing: Bool { owner?.sharing ?? true }
    /// The "Rebuild automatically" switch; nil hides the row (older server).
    var autoRebuild: Bool? { owner?.autoRebuild }

    /// The topics others see: the card minus hidden ones.
    var myTopics: [String] {
        guard let card else { return [] }
        let hidden = Set(card.hidden)
        return card.topics.all.filter { !hidden.contains($0) }
    }

    func isHidden(_ topic: String) -> Bool { card?.hidden.contains(topic) ?? false }

    // MARK: Errors

    static let messages: [String: String] = [
        "common_ground_no_sources": "Turn on a source first.",
        // A build that found nothing for the profile; trying again cannot help.
        "no_topics": "Nothing here fits this profile. Add a note or choose other sources.",
        "build_timed_out": "Building took too long. Try again.",
        "common_ground_build_in_progress": "Your card is already being built.",
        "common_ground_room_not_found": roomNotFound,
        "common_ground_code_not_found": "Code not found.",
        "common_ground_sharing_off": "Turn on sharing first.",
        "common_ground_no_card": "Build your profile first.",
        "common_ground_profile_exists": "You already have this profile.",
        "common_ground_too_many_profiles": "You can have up to 5 profiles.",
        "common_ground_room_closed": "This room is closed.",
        "ai_consent_required": AIConsentCopy.declinedTitle,
    ]

    /// One line for a failed call; nil for a cancelled one.
    static func message(for error: Error) -> String? {
        if error is CancellationError { return nil }
        guard let error = error as? CloudAPIError else { return "Something went wrong. Try again." }
        if error.statusCode == 429 || error.code == "rate_limited" {
            let seconds = Double(error.retryAfterSeconds ?? 60)
            return "Try again in \(max(1, Int((seconds / 60).rounded(.up)))) min."
        }
        return messages[error.code] ?? nearbyMessages[error.code] ?? error.message
    }

    func report(_ error: Error) {
        if AIConsentGate.isConsentRequired(error) { onAIConsentRequired?() }
        if let message = Self.message(for: error) { notice = message }
    }

    func call<T>(_ work: (CloudAPIClient, String) async throws -> T) async throws -> T {
        let (api, token) = try context()
        return try await work(api, token)
    }

    /// Runs one user action: marks it busy, clears the notice, reports failures.
    func run<T>(_ key: String, _ work: (CloudAPIClient, String) async throws -> T) async -> T? {
        busy = key
        notice = nil
        defer { if busy == key { busy = nil } }
        do {
            return try await call(work)
        } catch {
            report(error)
            return nil
        }
    }

    // MARK: Home

    /// Loads Home when it appears or the app comes back, at most once per
    /// `syncInterval`, so a card's look or name changed on another device
    /// shows here too.
    func refreshHome(now: Date = Date()) async {
        if let lastSync, now.timeIntervalSince(lastSync) < Self.syncInterval { return }
        lastSync = now
        await loadHome()
        await loadWalletTopics()
    }

    func loadHome() async {
        if profilesEnabled { await loadProfiles() }
        do {
            let profileId = activeProfileID
            apply(try await call { try await $0.commonGroundCard(token: $1, profileId: profileId) })
        } catch {
            loaded = true
            report(error)
            return
        }
        guard hasCard || anyProfileHasCard else { return }
        if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) {
            recent = response.people
        }
        await loadRooms()
    }

    func apply(_ view: CommonGroundOwnerView) {
        // A late answer for a profile that is no longer current is dropped.
        if let id = view.profile?.profileId, let current = activeProfileID, id != current { return }
        if profilesEnabled, currentProfileID == nil, let id = view.profile?.profileId { currentProfileID = id }
        let wasBuilding = isBuilding
        let revision = owner?.card?.revision
        owner = view
        loaded = true
        if let id = view.profile?.profileId { walletTopics[id] = Self.visibleTopics(view.card) }
        if (wasBuilding && !isBuilding) || revision != view.card?.revision {
            matches = [:]
            results = [:]
            if profilesEnabled { Task { await loadProfiles() } }
        }
    }

    func applyRecent(_ entries: [CommonGroundRecentEntry]) { recent = entries }

    /// Forgets the shown card while another profile's card loads.
    func resetOwner() {
        owner = nil
        loaded = false
        profileMemories = []
    }

    /// One line for a failed build, from the last build state.
    var buildFailureMessage: String? {
        guard buildFailed else { return nil }
        if owner?.build.errorCode == "links_unread" {
            let several = (owner?.build.unreadLinks?.count ?? 0) > 1
            return "Kordi couldn't read your \(several ? "links" : "link"), so there's nothing to build from."
        }
        return owner?.build.errorCode.flatMap { Self.messages[$0] } ?? "Could not build your card."
    }

    // MARK: Card

    func build(_ request: CommonGroundBuildRequest, checkEvery interval: Duration = buildCheckInterval) async {
        var request = request
        let profileId = activeProfileID
        request.profileId = profileId
        busy = "build"
        notice = nil
        defer { if busy == "build" { busy = nil } }
        do {
            apply(try await call { try await $0.buildCommonGroundCard(token: $1, request: request) })
        } catch {
            // No answer is not "never started": a slow server may have started the build, and a
            // build already running (from an earlier attempt) is followed rather than reported.
            let unknown = Self.isUnknownOutcome(error)
            let running = (error as? CloudAPIError)?.code == "common_ground_build_in_progress"
            if unknown || running, await followStartedBuild(profileId: profileId, every: interval) { return }
            if unknown {
                notice = Self.buildNotStarted
            } else {
                report(error)
            }
        }
    }

    /// True for a failure that says nothing about whether the server did the work: no answer,
    /// or a server error other than Grounding being unavailable.
    static func isUnknownOutcome(_ error: Error) -> Bool {
        if CloudTransportErrorPolicy.isCancellation(error) { return false }
        if let error = error as? CloudAPIError {
            return error.statusCode == 0 || error.statusCode == 408
                || (error.statusCode >= 500 && error.code != "common_ground_unavailable")
        }
        return error is URLError || (error as NSError).domain == NSURLErrorDomain
    }

    /// Looks at the card a few times; true once it shows the build running, which then polls as usual.
    private func followStartedBuild(profileId: String?, every interval: Duration) async -> Bool {
        for check in 0..<Self.buildStartChecks {
            if check > 0 { try? await Task.sleep(for: interval) }
            guard !Task.isCancelled, activeProfileID == profileId else { return false }
            if let view = try? await call({ try await $0.commonGroundCard(token: $1, profileId: profileId) }),
               view.build.status == "building" {
                apply(view)
                return true
            }
        }
        return false
    }

    func refreshCard() async {
        do {
            let profileId = activeProfileID
            apply(try await call { try await $0.commonGroundCard(token: $1, profileId: profileId) })
        } catch {
            report(error)
        }
    }

    /// Polls `GET card` until the build ends or the caller is cancelled.
    func waitForBuild(every interval: Duration = buildPollInterval) async {
        while isBuilding, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await refreshCard()
        }
    }

    func saveTopics(_ topics: CommonGroundTopics) async {
        guard let previous = owner, var next = previous.card else { return }
        next.topics = topics
        owner?.card = next
        let profileId = activeProfileID
        if let saved = await run("topics", { try await $0.saveCommonGroundTopics(token: $1, topics: topics, profileId: profileId) }) {
            apply(saved)
        } else {
            owner = previous
        }
    }

    /// Adds a typed topic to one section; ignores blanks and duplicates.
    func addTopic(_ text: String, to key: WritableKeyPath<CommonGroundTopics, [String]>) async {
        let clean = String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(Self.tagMax))
        guard !clean.isEmpty, var topics = card?.topics,
              !topics[keyPath: key].contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) else { return }
        topics[keyPath: key].append(clean)
        await saveTopics(topics)
    }

    func removeTopic(_ topic: String, from key: WritableKeyPath<CommonGroundTopics, [String]>) async {
        guard var topics = card?.topics else { return }
        topics[keyPath: key].removeAll { $0 == topic }
        await saveTopics(topics)
    }

    func toggleHidden(_ topic: String) async {
        guard let card else { return }
        let hidden = card.hidden.contains(topic) ? card.hidden.filter { $0 != topic } : card.hidden + [topic]
        let profileId = activeProfileID
        if let saved = await run("hidden", { try await $0.setCommonGroundHidden(token: $1, hidden: hidden, profileId: profileId) }) {
            apply(saved)
        }
    }

    func setSharing(_ sharing: Bool) async {
        let profileId = activeProfileID
        guard let saved = await run("sharing", {
            try await $0.setCommonGroundSharing(token: $1, sharing: sharing, profileId: profileId)
        }) else { return }
        apply(saved)
    }

    func setAutoRebuild(_ autoRebuild: Bool) async {
        let profileId = activeProfileID
        guard let saved = await run("autoRebuild", {
            try await $0.setCommonGroundAutoRebuild(token: $1, autoRebuild: autoRebuild, profileId: profileId)
        }) else { return }
        apply(saved)
    }

    func deleteCard() async -> Bool {
        let profileId = activeProfileID
        guard let view = await run("delete", { try await $0.deleteCommonGroundCard(token: $1, profileId: profileId) }) else { return false }
        apply(view)
        rooms = [:]
        people = [:]
        if profilesEnabled {
            await loadProfiles()
            if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) { recent = response.people }
        } else {
            recent = []
        }
        return true
    }

    // MARK: Rooms

    /// Loads the rooms list. A 404 without a Common ground code means the
    /// server has no list yet, so the section stays hidden.
    func loadRooms() async {
        do {
            roomList = try await call { try await $0.commonGroundRooms(token: $1) }.rooms
        } catch let error as CloudAPIError where error.statusCode == 404 && !error.code.hasPrefix("common_ground") {
            roomList = nil
        } catch {}
    }

    /// Whether a room is closed, from the room or the rooms list.
    func isClosed(_ code: String) -> Bool {
        if let room = rooms[code] { return !room.open }
        return roomList?.first { $0.code == code }?.open == false
    }

    func roomTitle(_ code: String) -> String {
        rooms[code]?.title ?? roomList?.first { $0.code == code }?.title ?? roomPreviews[code]?.title ?? "Room \(code)"
    }

    func joinRoom(_ code: String, request: CommonGroundJoinRequest = .init()) async -> Bool {
        guard let room = await run("join", { try await $0.joinCommonGroundRoom(token: $1, code: code, request: request) }) else { return false }
        setRoom(room, code: code)
        Task { await loadRooms() }
        return true
    }

    /// Moves a room to the top of Rooms, after a join or a new code.
    func raiseRoom(_ code: String) {
        guard let index = roomList?.firstIndex(where: { $0.code == code }), index > 0 else { return }
        withAnimation(.snappy) {
            if let room = roomList?.remove(at: index) { roomList?.insert(room, at: 0) }
        }
    }

    /// A room as just joined or switched: its results are matched again.
    func setRoom(_ room: CommonGroundRoom, code: String) {
        rooms[code] = room
        results[code] = nil
    }

    /// Reloads a room; false when it is gone.
    @discardableResult
    func refreshRoom(_ code: String) async -> Bool {
        do {
            let room = try await call { try await $0.commonGroundRoom(token: $1, code: code) }
            guard !Task.isCancelled else { return false }
            if rooms[code] != room { withAnimation(.snappy) { rooms[code] = room } }
            return true
        } catch let error as CloudAPIError where error.code == "common_ground_room_not_found" {
            report(error)
            return false
        } catch {
            return true
        }
    }

    func leaveRoom(_ code: String) async {
        _ = try? await call { try await $0.leaveCommonGroundRoom(token: $1, code: code) }
        withAnimation(.snappy) { roomList?.removeAll { $0.code == code } }
        rooms[code] = nil
        results[code] = nil
    }

    @discardableResult
    func loadResults(_ code: String, quiet: Bool = false) async -> Bool {
        do {
            if !quiet { busy = "find" }
            defer { if busy == "find" { busy = nil } }
            let next = try await call { try await $0.commonGroundResults(token: $1, code: code) }
            guard !Task.isCancelled else { return false }
            results[code] = next
            return true
        } catch {
            if !quiet { report(error) }
            return false
        }
    }

    /// Polls results while the server is still matching; a closed room's
    /// results are stored, so they are never polled.
    func waitForResults(_ code: String, every interval: Duration = matchPollInterval) async {
        while results[code]?.isMatching == true, !isClosed(code), !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await loadResults(code, quiet: true)
        }
    }

    /// A completed match can change when someone joins or changes their
    /// shared card. Refresh membership and cached results while visible: on
    /// each room or match hint, and on `resultsPollInterval` (or `interval`)
    /// in case one is missed. The server reuses completed matches whose
    /// inputs have not changed. A closed room is refreshed once.
    func followRoomResults(_ code: String, every interval: Duration? = nil) async {
        await follow(.results(code), every: { interval ?? resultsPollInterval(code) }) {
            guard await refreshRoom(code), !Task.isCancelled else { return false }
            await loadResults(code, quiet: true)
            return !Task.isCancelled && !isClosed(code)
        }
    }

    func createGroup(code: String, name: String, memberIds: [String], topic: String? = nil) async -> CommonGroundCreatedGroup? {
        guard let created = await run("group", {
            try await $0.createCommonGroundGroup(token: $1, code: code, name: name, memberIds: memberIds, topic: topic)
        }) else { return nil }
        var group = created.group
        group.joined = true
        if group.topic == nil { group.topic = topic }
        results[code]?.groups.removeAll { $0.groupSpaceId == group.groupSpaceId }
        results[code]?.groups.append(group)
        return created
    }

    func joinInvitation(code: String, invitationRef: String) async -> CommonGroundJoinedGroup? {
        guard let joined = await run("invite:\(invitationRef)", {
            try await $0.joinCommonGroundInvitation(token: $1, code: code, invitationRef: invitationRef)
        }) else { return nil }
        let group = CommonGroundGroup(
            groupSpaceId: joined.groupSpaceId, conversationId: joined.conversationId,
            name: joined.name ?? "", memberCount: 0, joined: true
        )
        results[code]?.invitations.removeAll { $0.invitationRef == invitationRef }
        results[code]?.groups.removeAll { $0.groupSpaceId == group.groupSpaceId }
        results[code]?.groups.append(group)
        rooms[code]?.invitations.removeAll { $0.invitationRef == invitationRef }
        return joined
    }
}
