import Foundation

/// A wake-up that coalesces. Waking a waiter ends its wait early; waking while
/// nobody waits is remembered once, so the next `wait` returns at once. A wake
/// never cancels work in progress: loops wait on the signal only between their
/// passes or attempts.
@MainActor
final class CoalescingWakeSignal {
    typealias Sleep = @Sendable (Duration) async throws -> Void

    private let sleep: Sleep
    private(set) var isPending = false
    private var waiter: (id: UUID, continuation: CheckedContinuation<Void, Never>, timer: Task<Void, Never>)?

    init(sleep: @escaping Sleep = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
    }

    var isWaiting: Bool { waiter != nil }

    func wake() {
        if let waiter { finish(waiter.id) } else { isPending = true }
    }

    /// Forgets a wake that arrived while the work it asked for was already
    /// happening, such as a realtime socket that is receiving frames.
    func discardPending() {
        isPending = false
    }

    /// Returns after `timeout`, at the next wake, or when the task is
    /// cancelled, and at once when a wake is pending.
    func wait(upTo timeout: Duration) async {
        if isPending {
            isPending = false
            return
        }
        guard !Task.isCancelled else { return }
        if let existing = waiter { finish(existing.id) }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let timer = Task { @MainActor [weak self, sleep] in
                    try? await sleep(timeout)
                    self?.finish(id)
                }
                waiter = (id, continuation, timer)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(id) }
        }
    }

    private func finish(_ id: UUID) {
        guard let current = waiter, current.id == id else { return }
        waiter = nil
        current.timer.cancel()
        current.continuation.resume()
    }
}

/// What a sync pass asks the loop to do next.
enum CloudSyncPassOutcome: Equatable {
    /// Stop the loop, for example because the session ended.
    case stop
    /// The server has more pages; run the next pass at once.
    case more
    /// Caught up or failed; wait for a wake or the repair interval.
    case idle
}

extension CoalescingWakeSignal {
    /// Runs sync passes until one returns `.stop` or the task is cancelled.
    /// Wakes that arrive while a pass runs never cancel it; they make exactly
    /// one more pass run after it ends, however many arrived.
    func runPasses(
        every interval: Duration,
        _ pass: @MainActor () async -> CloudSyncPassOutcome
    ) async {
        while !Task.isCancelled {
            switch await pass() {
            case .stop: return
            case .more: continue
            case .idle: await wait(upTo: interval)
            }
        }
    }
}
