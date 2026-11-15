import Foundation

extension Notification.Name {
    /// Posted on the main actor for the account sync hints
    /// `common_ground.room.updated`, `common_ground.matches.updated` and
    /// `common_ground.invitations.updated`.
    /// The object is a `CommonGroundSyncHint`.
    static let kordiCommonGroundHint = Notification.Name("kordi.commonGround.hint")
}

/// A Grounding change the server announced through the account sync stream.
/// Hints carry no data to show; a screen on display reloads what it shows.
enum CommonGroundSyncHint: Equatable, Sendable {
    /// Someone joined or left the room, its matching started or its themes
    /// finished, or a member's card or sharing changed.
    case room(code: String)
    /// A match for this account finished or failed.
    case matches
    /// A group invitation to this account arrived or was answered elsewhere.
    case invitations

    static let eventTypes: Set<String> = [
        "common_ground.room.updated", "common_ground.matches.updated", "common_ground.invitations.updated",
    ]

    /// True once any Grounding hint reached the app since launch: the stream
    /// is known to work, so screens poll less often.
    @MainActor static var arrivedThisSession = false

    init?(event: CloudChatEvent) {
        switch event.eventType {
        case "common_ground.room.updated":
            guard let code = event.payload.code?.nonEmpty else { return nil }
            self = .room(code: code)
        case "common_ground.matches.updated":
            self = .matches
        case "common_ground.invitations.updated":
            self = .invitations
        default:
            return nil
        }
    }

    /// Turns a Grounding sync event into `kordiCommonGroundHint`. Other
    /// events are ignored.
    static func publish(_ event: CloudChatEvent) {
        guard let hint = CommonGroundSyncHint(event: event) else { return }
        Task { @MainActor in
            arrivedThisSession = true
            NotificationCenter.default.post(name: .kordiCommonGroundHint, object: hint)
        }
    }
}

/// A screen on display that reloads when a hint concerns it.
enum CommonGroundHintTarget: Hashable {
    /// Home's Rooms list: any room hint.
    case rooms
    /// A room's lobby: hints for that room.
    case lobby(String)
    /// A room's Results: hints for that room, and finished matches.
    case results(String)
    /// A match with one person while it is being found: finished matches.
    case match(String)

    func wakes(on hint: CommonGroundSyncHint) -> Bool {
        switch (self, hint) {
        case (.rooms, .room): true
        case (.lobby(let code), .room(let hinted)), (.results(let code), .room(let hinted)): code == hinted
        case (.results, .matches), (.match, .matches): true
        default: false
        }
    }
}

/// Wakes one screen's refresh loop when its timer ends or a hint arrives,
/// whichever comes first. A hint that arrives while the loop is refreshing
/// is kept, so it causes exactly one more refresh afterwards.
@MainActor
final class CommonGroundHintWake {
    let target: CommonGroundHintTarget
    private var pending = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var timer: Task<Void, Never>?

    init(_ target: CommonGroundHintTarget) { self.target = target }

    func signal() {
        if continuation == nil { pending = true } else { resume() }
    }

    /// Returns after `interval` (nil: only on a hint), on a hint, or when the
    /// task is cancelled. A hint kept from earlier returns at once.
    func wait(for interval: Duration?) async {
        if pending {
            pending = false
            return
        }
        guard !Task.isCancelled else { return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                guard let interval else { return }
                timer = Task { [weak self] in
                    try? await Task.sleep(for: interval)
                    guard !Task.isCancelled else { return }
                    self?.resume()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resume() }
        }
    }

    private func resume() {
        timer?.cancel()
        timer = nil
        let waiting = continuation
        continuation = nil
        waiting?.resume()
    }
}

extension CommonGroundModel {
    /// A Grounding hint from the sync stream: wakes the screens on display
    /// that it concerns. Screens that are not on display do nothing.
    func receive(_ hint: CommonGroundSyncHint) {
        hintsArrived = true
        for wake in hintWakes where wake.target.wakes(on: hint) { wake.signal() }
    }

    /// How long a person's match or a room's Results wait between looks
    /// while the server is matching.
    var matchingPollInterval: Duration { hintsArrived ? Self.hintedMatchPollInterval : Self.matchPollInterval }

    /// How long an open room's Results wait between looks: the matching
    /// interval while matching, else the fallback for a missed hint. Until a
    /// hint shows the stream works, every look is `matchPollInterval` apart.
    func resultsPollInterval(_ code: String) -> Duration {
        guard hintsArrived else { return Self.matchPollInterval }
        return results[code]?.isMatching == true ? Self.hintedMatchPollInterval : Self.fallbackPollInterval
    }

    /// Calls `refresh` now (or first after one wait), then each time
    /// `interval` passes (nil: only on a hint) or a hint for `target`
    /// arrives, until the task is cancelled or `refresh` returns false. Calls
    /// never overlap; hints during a call cause exactly one more.
    func follow(_ target: CommonGroundHintTarget, immediately: Bool = true, every interval: () -> Duration?,
                refresh: () async -> Bool) async {
        let wake = CommonGroundHintWake(target)
        hintWakes.append(wake)
        defer { hintWakes.removeAll { $0 === wake } }
        if !immediately { await wake.wait(for: interval()) }
        while !Task.isCancelled, await refresh(), !Task.isCancelled {
            await wake.wait(for: interval())
        }
    }

    /// Reloads Home's Rooms list on each room hint while Home is on display.
    func followRoomHints() async {
        await follow(.rooms, immediately: false, every: { nil }) {
            await loadRooms()
            return true
        }
    }
}
