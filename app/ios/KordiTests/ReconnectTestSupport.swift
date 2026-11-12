import Foundation
import XCTest
@testable import Kordi

/// A sleep that ends only when the test fires it or the sleeping task is
/// cancelled, so reconnect and retry tests never depend on wall-clock time.
@MainActor
final class ReconnectTestSleeper {
    private var sleepers: [(id: UUID, duration: Duration, continuation: CheckedContinuation<Void, Error>)] = []
    /// Every duration a caller asked to sleep, in order.
    private(set) var requested: [Duration] = []
    private(set) var cancelledCount = 0

    /// Durations of the sleeps that are still waiting.
    var pending: [Duration] { sleepers.map(\.duration) }

    var sleep: CoalescingWakeSignal.Sleep {
        { [self] duration in try await self.sleep(for: duration) }
    }

    func sleep(for duration: Duration) async throws {
        requested.append(duration)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                sleepers.append((id, duration, continuation))
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id) }
        }
    }

    /// Ends every waiting sleep as if its duration had elapsed.
    func fireAll() {
        let waiting = sleepers
        sleepers.removeAll()
        waiting.forEach { $0.continuation.resume() }
    }

    private func cancel(_ id: UUID) {
        guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return }
        cancelledCount += 1
        sleepers.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}

/// Yields until `condition` holds. Tests wait for states, never for time.
@MainActor
func reconnectEventually(
    _ description: String,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @MainActor () -> Bool
) async {
    for _ in 0..<1_000_000 {
        if condition() { return }
        await Task.yield()
    }
    XCTFail("Timed out waiting until \(description)", file: file, line: line)
}

/// A random source that returns the given values in turn, then repeats the last.
final class ReconnectTestRandom {
    private var values: [Double]

    init(_ values: [Double]) {
        self.values = values
    }

    func next() -> Double {
        values.count > 1 ? values.removeFirst() : values.first ?? 0
    }
}

/// A clock the test moves by hand.
final class ReconnectTestClock {
    private(set) var now = ContinuousClock.now

    func advance(by duration: Duration) {
        now = now.advanced(by: duration)
    }
}
