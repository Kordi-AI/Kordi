import Foundation

/// Keeps sends whose outcome is unknown. A network failure or timeout does not
/// mean the server rejected a message: it may have stored it. Such a send stays
/// queued under its client message id and is sent again with the reconnect
/// policy, at once when the network returns or the app comes to the
/// foreground. The server answers a repeat with the message it stored, so a
/// stored message is never shown twice; the response or the next sync
/// reconciles it.
@MainActor
final class MessageSendOutbox {
    typealias Resend = @MainActor (ConversationSummary, ChatMessage) async -> Void
    typealias Now = () -> ContinuousClock.Instant

    enum Verdict: Equatable {
        /// The server may or may not have stored it; send it again.
        case unknown(retryAfter: Duration?)
        /// The server already holds a message with this client message id.
        case stored
        /// The server refused it; the send fails as before.
        case rejected
    }

    private struct Entry {
        let conversation: ConversationSummary
        let message: ChatMessage
        let resend: Resend
        var policy: RealtimeReconnectPolicy
        var retryAfter: Duration?
        var holdUntil: ContinuousClock.Instant?
        var timer: Task<Void, Never>?
        var isSending = false
        var keptAgain = false
    }

    private static let transientURLErrors: Set<URLError.Code> = [
        .timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
        .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff, .callIsActive,
        .dataNotAllowed, .secureConnectionFailed, .resourceUnavailable
    ]

    private let makePolicy: () -> RealtimeReconnectPolicy
    private let sleep: CoalescingWakeSignal.Sleep
    private let now: Now
    private var entries: [String: Entry] = [:]
    private var recovery: ConnectivityRecoveryObserver?

    init(
        makePolicy: @escaping () -> RealtimeReconnectPolicy = { RealtimeReconnectPolicy() },
        sleep: @escaping CoalescingWakeSignal.Sleep = { try await Task.sleep(for: $0) },
        now: @escaping Now = { ContinuousClock.now }
    ) {
        self.makePolicy = makePolicy
        self.sleep = sleep
        self.now = now
    }

    /// Local ids of the sends waiting for another attempt or being sent again.
    var queuedMessageIDs: Set<String> { Set(entries.keys) }

    static func verdict(for error: Error) -> Verdict {
        if CloudTransportErrorPolicy.isCancellation(error) { return .unknown(retryAfter: nil) }
        if let error = error as? URLError {
            return transientURLErrors.contains(error.code) ? .unknown(retryAfter: nil) : .rejected
        }
        guard let error = error as? CloudAPIError else { return .rejected }
        if error.code == "IDEMPOTENCY_KEY_REUSED" { return .stored }
        switch error.statusCode {
        case 0:
            return ["network_error", "proxy_unreachable"].contains(error.code) ? .unknown(retryAfter: nil) : .rejected
        case 408, 500...599, 429:
            return .unknown(retryAfter: CloudRetryAfter.delay(for: error))
        default:
            return .rejected
        }
    }

    /// Decides what a failed send means. Returns false for a rejection, which
    /// the caller reports as a failure. Otherwise the message stays unconfirmed:
    /// an unknown outcome is queued for another attempt with the same client
    /// message id, and a message the server already stored waits for the sync.
    @discardableResult
    func keep(
        _ message: ChatMessage,
        in conversation: ConversationSummary,
        after error: Error,
        resend: @escaping Resend
    ) -> Bool {
        let retryAfter: Duration?
        switch Self.verdict(for: error) {
        case .rejected: return false
        case .stored: return true
        case .unknown(let delay): retryAfter = delay
        }
        if var entry = entries[message.id] {
            entry.retryAfter = retryAfter
            if entry.isSending {
                entry.keptAgain = true
                entries[message.id] = entry
            } else {
                entries[message.id] = entry
                schedule(message.id)
            }
            return true
        }
        entries[message.id] = Entry(
            conversation: conversation,
            message: message,
            resend: resend,
            policy: makePolicy(),
            retryAfter: retryAfter
        )
        if recovery == nil {
            recovery = ConnectivityRecoveryObserver { [weak self] in self?.retryNow() }
        }
        schedule(message.id)
        return true
    }

    /// Sends every waiting message now, except one being sent or one the server
    /// asked to hold with `Retry-After`.
    func retryNow() {
        let current = now()
        for (id, entry) in entries where !entry.isSending {
            if let holdUntil = entry.holdUntil, current < holdUntil { continue }
            entry.timer?.cancel()
            Task { await fire(id) }
        }
    }

    func reset() {
        entries.values.forEach { $0.timer?.cancel() }
        entries.removeAll()
        recovery = nil
    }

    private func schedule(_ id: String) {
        guard var entry = entries[id] else { return }
        let delay = entry.policy.nextDelay(retryAfter: entry.retryAfter)
        entry.holdUntil = entry.retryAfter.map { now().advanced(by: $0) }
        entry.retryAfter = nil
        entry.timer?.cancel()
        entry.timer = Task { @MainActor [weak self, sleep] in
            do { try await sleep(delay) } catch { return }
            // `retryNow` or `reset` cancelled this timer after its sleep ended.
            guard !Task.isCancelled else { return }
            await self?.fire(id)
        }
        entries[id] = entry
    }

    private func fire(_ id: String) async {
        guard var entry = entries[id], !entry.isSending else { return }
        // Never cancel the timer here. When it fired, it is the task running this
        // resend, and a cancelled task fails the request before it is sent.
        // `retryNow` cancels a waiting timer itself before it calls this.
        entry.timer = nil
        entry.isSending = true
        entry.keptAgain = false
        entries[id] = entry
        await entry.resend(entry.conversation, entry.message)
        // Gone when the account signed out while the message was being sent.
        guard var current = entries[id] else { return }
        guard current.keptAgain else {
            entries[id] = nil
            if entries.isEmpty { recovery = nil }
            return
        }
        current.isSending = false
        entries[id] = current
        schedule(id)
    }
}
