import Foundation

/// Exponential backoff with full jitter for realtime reconnects and for sends
/// whose outcome is unknown.
///
/// Attempt `n` waits a uniformly random delay in
/// `[0, min(maximumDelay, initialDelay * 2^n)]`, so clients that lose their
/// sockets at the same moment spread their retries instead of retrying in step.
/// The attempt count resets only after a connection stayed open for
/// `stableConnection`: a server that closes right after the handshake keeps
/// pushing the delay towards the maximum.
struct RealtimeReconnectPolicy {
    static let initialDelay: Duration = .seconds(1)
    static let maximumDelay: Duration = .seconds(60)
    static let stableConnection: Duration = .seconds(30)

    /// Returns a value in `0..<1`.
    typealias RandomUnit = () -> Double
    typealias Now = () -> ContinuousClock.Instant

    private let random: RandomUnit
    private let now: Now
    private(set) var failedAttempts = 0
    private var openedAt: ContinuousClock.Instant?

    init(
        random: @escaping RandomUnit = { Double.random(in: 0..<1) },
        now: @escaping Now = { ContinuousClock.now }
    ) {
        self.random = random
        self.now = now
    }

    /// The longest delay the next attempt can wait.
    var ceiling: Duration {
        // The cap is reached long before the shift could overflow.
        let doubled = Self.initialDelay * (1 << min(failedAttempts, 16))
        return min(doubled, Self.maximumDelay)
    }

    /// The delay before the next attempt; calling it counts the attempt. A
    /// server's `Retry-After` is a lower bound, and the jittered delay is added
    /// on top so clients told the same value do not come back in step.
    mutating func nextDelay(retryAfter: Duration? = nil) -> Duration {
        let unit = min(max(random(), 0), 1)
        let jittered = Self.scaled(ceiling, by: unit)
        failedAttempts += 1
        guard let retryAfter, retryAfter > .zero else { return jittered }
        return retryAfter + jittered
    }

    /// Records that a connection opened; the attempt count is kept until it
    /// has stayed open for `stableConnection`.
    mutating func connectionOpened() {
        openedAt = now()
    }

    /// Records that a connection closed or an attempt failed. Only a connection
    /// that stayed open for `stableConnection` resets the attempt count.
    mutating func connectionClosed() {
        defer { openedAt = nil }
        guard let openedAt, openedAt.duration(to: now()) >= Self.stableConnection else { return }
        failedAttempts = 0
    }

    private static func scaled(_ duration: Duration, by unit: Double) -> Duration {
        let components = duration.components
        let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
        return .seconds(seconds * unit)
    }
}

/// The server's `Retry-After` on 429 and 503, which every retry loop honors.
enum CloudRetryAfter {
    static func delay(for error: Error) -> Duration? {
        guard let error = error as? CloudAPIError,
              error.statusCode == 429 || error.statusCode == 503,
              let seconds = error.retryAfterSeconds, seconds > 0 else { return nil }
        return .seconds(seconds)
    }
}
