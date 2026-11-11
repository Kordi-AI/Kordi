import Foundation
import XCTest
@testable import Kordi

/// Counts sync passes and can hold one open until the test releases it.
@MainActor
private final class SyncPassProbe {
    var passes = 0
    var cancelledPasses = 0
    var outcomes: [CloudSyncPassOutcome] = []
    private var held: CheckedContinuation<Void, Never>?
    var isHolding: Bool { held != nil }

    func hold() async {
        await withCheckedContinuation { held = $0 }
    }

    func release() {
        held?.resume()
        held = nil
    }

    func pass(holdingPass holdIndex: Int? = nil) async -> CloudSyncPassOutcome {
        passes += 1
        if passes == holdIndex { await hold() }
        if Task.isCancelled { cancelledPasses += 1 }
        return outcomes.isEmpty ? .idle : outcomes.removeFirst()
    }
}

@MainActor
final class CloudSyncCoalescingTests: XCTestCase {
    func testWakesDuringARunningPassRunExactlyOneMorePassAndNeverCancelIt() async {
        let sleeper = ReconnectTestSleeper()
        let signal = CoalescingWakeSignal(sleep: sleeper.sleep)
        let probe = SyncPassProbe()
        let loop = Task { @MainActor in
            await signal.runPasses(every: .seconds(2)) { await probe.pass(holdingPass: 1) }
        }

        await reconnectEventually("the first pass is running") { probe.isHolding }
        for _ in 0..<5 { signal.wake() }
        XCTAssertEqual(probe.passes, 1)
        probe.release()

        await reconnectEventually("one more pass ran and the loop waits") {
            probe.passes == 2 && signal.isWaiting && sleeper.pending.count == 1
        }
        XCTAssertEqual(probe.cancelledPasses, 0)
        XCTAssertEqual(sleeper.requested, [.seconds(2)])

        // Nothing but a new wake or the repair interval starts the next pass.
        sleeper.fireAll()
        await reconnectEventually("the interval ran the third pass") {
            probe.passes == 3 && signal.isWaiting && sleeper.pending.count == 1
        }
        XCTAssertEqual(probe.cancelledPasses, 0)

        loop.cancel()
        await loop.value
    }

    func testAWakeEndsTheWaitAtOnceAndIsNotRemembered() async {
        let sleeper = ReconnectTestSleeper()
        let signal = CoalescingWakeSignal(sleep: sleeper.sleep)
        let probe = SyncPassProbe()
        let loop = Task { @MainActor in
            await signal.runPasses(every: .seconds(2)) { await probe.pass() }
        }

        await reconnectEventually("the loop waits after the first pass") {
            probe.passes == 1 && signal.isWaiting && sleeper.pending.count == 1
        }
        signal.wake()
        await reconnectEventually("the wake ran the second pass and cancelled the first timer") {
            probe.passes == 2 && signal.isWaiting && sleeper.cancelledCount == 1 && sleeper.pending.count == 1
        }
        XCTAssertEqual(sleeper.cancelledCount, 1)
        XCTAssertFalse(signal.isPending)
        XCTAssertEqual(sleeper.pending, [.seconds(2)])

        loop.cancel()
        await loop.value
        XCTAssertEqual(probe.passes, 2)
    }

    func testMorePagesRunBackToBackAndStopEndsTheLoop() async {
        let sleeper = ReconnectTestSleeper()
        let signal = CoalescingWakeSignal(sleep: sleeper.sleep)
        let probe = SyncPassProbe()
        probe.outcomes = [.more, .more, .idle, .stop]
        let loop = Task { @MainActor in
            await signal.runPasses(every: .seconds(2)) { await probe.pass() }
        }

        await reconnectEventually("three pages were read") {
            probe.passes == 3 && signal.isWaiting && sleeper.pending.count == 1
        }
        XCTAssertEqual(sleeper.requested, [.seconds(2)])
        signal.wake()
        await loop.value
        XCTAssertEqual(probe.passes, 4)
        XCTAssertFalse(signal.isWaiting)
    }

    func testCancellingTheLoopEndsItsWait() async {
        let sleeper = ReconnectTestSleeper()
        let signal = CoalescingWakeSignal(sleep: sleeper.sleep)
        let probe = SyncPassProbe()
        let loop = Task { @MainActor in
            await signal.runPasses(every: .seconds(2)) { await probe.pass() }
        }

        await reconnectEventually("the loop waits") { signal.isWaiting }
        loop.cancel()
        await loop.value
        XCTAssertFalse(signal.isWaiting)
        XCTAssertEqual(probe.passes, 1)
    }
}
