import SwiftUI
import Observation
import OSLog

enum ChatPullRefreshVisualState: Equatable {
    case idle
    case pulling(progress: CGFloat)
    case rebounding
    case refreshing
}

/// Owns gesture bookkeeping without invalidating the page containing the list.
/// Only the sync mark reads the observable visual state.
@Observable
@MainActor
final class ChatPullRefreshState {
    private static let signposter = OSSignposter(subsystem: "ai.kordi.ui", category: "ChatRefresh")
    private(set) var visualState: ChatPullRefreshVisualState = .idle
    @ObservationIgnored private var pullDistance: CGFloat = 0
    @ObservationIgnored private var isRefreshing = false
    @ObservationIgnored private var isScrollIdle = true
    @ObservationIgnored private var hasPendingRefresh = false
    @ObservationIgnored private var reboundInterval: OSSignpostIntervalState?

    func updatePullDistance(_ distance: CGFloat) {
        pullDistance = distance
        guard !isRefreshing else { return }
        let next: ChatPullRefreshVisualState = distance > 0.5
            ? .pulling(progress: KordiSyncMarkGeometry.pullProgress(
                for: distance, triggerDistance: ChatPullToRefreshBehavior.triggerDistance
            ))
            : .idle
        if visualState != next { visualState = next }
    }

    func beginRefresh() -> Bool {
        guard ChatPullToRefreshBehavior.shouldStart(
            distance: pullDistance, isRefreshing: isRefreshing
        ) else { return false }
        isRefreshing = true
        hasPendingRefresh = true
        reboundInterval = Self.signposter.beginInterval("ChatPullRebound")
        visualState = .rebounding
        return true
    }

    func setScrollIdle(_ idle: Bool) {
        isScrollIdle = idle
    }

    /// Phase and geometry callbacks can arrive in either order. Wait for both
    /// before publishing refreshed app state into the rebounding native list.
    func takePendingRefresh() -> Bool {
        guard hasPendingRefresh, isScrollIdle, pullDistance <= 0.5 else { return false }
        endReboundInterval()
        hasPendingRefresh = false
        visualState = .refreshing
        Self.signposter.emitEvent("ChatRefreshStarted")
        return true
    }

    func cancelPendingRefresh() {
        guard hasPendingRefresh else { return }
        finishRefresh()
    }

    func finishRefresh() {
        endReboundInterval()
        isRefreshing = false
        hasPendingRefresh = false
        pullDistance = 0
        visualState = .idle
    }

    private func endReboundInterval() {
        guard let reboundInterval else { return }
        Self.signposter.endInterval("ChatPullRebound", reboundInterval)
        self.reboundInterval = nil
    }
}

enum KordiSyncMarkMotion: Equatable {
    case idle
    case pulling(progress: CGFloat)
    case refreshing
    case syncing
    case offline

    var isResting: Bool { self == .idle || self == .offline }

    var runsContinuously: Bool {
        self == .refreshing || self == .syncing
    }
}

enum MessageSyncStatusBehavior {
    static func motion(
        pullState: ChatPullRefreshVisualState,
        messageSyncState: MessageSyncState,
        isLoadingMessages: Bool
    ) -> KordiSyncMarkMotion {
        switch pullState {
        case .rebounding:
            return .pulling(progress: 1)
        case .refreshing:
            return .refreshing
        case let .pulling(progress):
            return .pulling(progress: progress)
        case .idle:
            if isLoadingMessages { return .syncing }
            switch messageSyncState {
            case .syncing: return .syncing
            case .upToDate: return .idle
            case .offline: return .offline
            }
        }
    }
}

enum KordiSyncMarkGeometry {
    static let birdSize: CGFloat = 40

    static func pullProgress(for distance: CGFloat, triggerDistance: CGFloat) -> CGFloat {
        guard triggerDistance > 0 else { return 0 }
        return min(max(distance / triggerDistance, 0), 1)
    }

    /// Bird pose for a sync state: flying while syncing, the wing lifting with the pull,
    /// and the still icon pose otherwise or when motion is reduced.
    static func pose(
        motion: KordiSyncMarkMotion,
        elapsed: TimeInterval,
        reduceMotion: Bool
    ) -> KordiBirdPose {
        switch motion {
        case .idle, .offline:
            return .still
        case let .pulling(progress):
            return .flight(.holding(wingAngle: KordiBirdFlightMotion.wingAngle(progress: Double(progress))))
        case .refreshing, .syncing:
            return reduceMotion ? .still : .flight(KordiBirdFlightMotion.sample(elapsed: elapsed))
        }
    }
}

struct MessageSyncStatusView: View {
    @EnvironmentObject private var model: AppModel
    let refreshState: ChatPullRefreshState

    private var pullState: ChatPullRefreshVisualState { refreshState.visualState }

    var body: some View {
        KordiAnimatedSyncMark(motion: motion)
            .frame(width: 52, height: 44)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
    }

    private var motion: KordiSyncMarkMotion {
        MessageSyncStatusBehavior.motion(
            pullState: pullState,
            messageSyncState: model.messageSyncState,
            isLoadingMessages: isLoadingMessages
        )
    }

    private var accessibilityLabel: String {
        switch pullState {
        case .rebounding, .refreshing: return "Refreshing messages"
        case let .pulling(progress):
            return progress >= 1 ? "Release to refresh messages" : "Pull to refresh messages"
        case .idle:
            if isLoadingMessages { return "Syncing" }
            switch model.messageSyncState {
            case .syncing: return "Syncing"
            case .upToDate:
                if let date = model.lastMessageSyncAt {
                    return "Messages up to date as of \(date.formatted(date: .omitted, time: .shortened))"
                }
                return "Messages up to date"
            case .offline: return "Message sync offline"
            }
        }
    }

    private var isLoadingMessages: Bool {
        !model.loadingConversationIDs.isEmpty
    }
}

/// Samples one continuous pose across pull, flight and landing. Bookkeeping
/// changes only at state boundaries; timeline frames never invalidate the list.
struct KordiSyncMarkAnimation {
    static let landingDuration: TimeInterval = 0.24
    private(set) var motion: KordiSyncMarkMotion = .idle
    private var flightEpoch: TimeInterval = 0
    private var transitionTime: TimeInterval = 0
    private var transitionPose = KordiBirdFlightSample.folded

    mutating func transition(to next: KordiSyncMarkMotion, at time: TimeInterval) {
        guard next != motion else { return }
        // Refresh completion may leave background syncing active. Keep the same
        // oscillator instead of restarting the flap at its first frame.
        if (motion.runsContinuously && next.runsContinuously) || (motion.isResting && next.isResting) {
            motion = next
            return
        }
        let current = sample(at: time)
        transitionPose = current
        transitionTime = time
        if next.runsContinuously {
            let progress = min(max(
                (current.wingAngle - KordiBirdFlightMotion.wingDownAngle)
                    / (KordiBirdFlightMotion.wingUpAngle - KordiBirdFlightMotion.wingDownAngle), 0
            ), 1)
            let phase = acos(1 - 2 * progress) / (2 * .pi)
            flightEpoch = time - phase * KordiBirdFlightMotion.flapDuration
        }
        motion = next
    }

    func sample(at time: TimeInterval) -> KordiBirdFlightSample {
        if case let .pulling(progress) = motion {
            return .holding(wingAngle: KordiBirdFlightMotion.wingAngle(progress: Double(progress)))
        }
        let elapsed = max(0, time - transitionTime)
        let progress = min(elapsed / Self.landingDuration, 1)
        let eased = progress * progress * (3 - 2 * progress)
        let target = motion.runsContinuously
            ? KordiBirdFlightMotion.sample(elapsed: max(0, time - flightEpoch))
            : .folded
        func blend(_ from: Double, _ to: Double) -> Double { from + (to - from) * eased }
        return KordiBirdFlightSample(
            wingAngle: motion.runsContinuously ? target.wingAngle : blend(transitionPose.wingAngle, target.wingAngle),
            bodyOffsetX: blend(transitionPose.bodyOffsetX, target.bodyOffsetX),
            bodyOffsetY: blend(transitionPose.bodyOffsetY, target.bodyOffsetY),
            bodyRotation: blend(transitionPose.bodyRotation, target.bodyRotation)
        )
    }
}

private struct KordiAnimatedSyncMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let motion: KordiSyncMarkMotion
    @State private var animation = KordiSyncMarkAnimation()
    @State private var isLanding = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion || (!motion.runsContinuously && !isLanding))) { timeline in
            KordiMark(
                size: KordiSyncMarkGeometry.birdSize,
                pose: reduceMotion ? .still : .flight(animation.sample(at: timeline.date.timeIntervalSinceReferenceDate))
            )
            .frame(width: 48, height: 40)
        }
        .onChange(of: motion, initial: true) { oldMotion, newMotion in
            let now = Date.timeIntervalSinceReferenceDate
            animation.transition(to: newMotion, at: now)
            if oldMotion.isResting && newMotion.isResting { return }
            isLanding = !newMotion.runsContinuously && !isPulling && animation.sample(at: now) != .folded
        }
        .task(id: isLanding) {
            guard isLanding else { return }
            do { try await Task.sleep(for: .seconds(KordiSyncMarkAnimation.landingDuration)) }
            catch { return }
            isLanding = false
        }
    }

    private var isPulling: Bool {
        if case .pulling = motion { return true }
        return false
    }
}
