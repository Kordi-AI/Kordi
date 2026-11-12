import Foundation
import XCTest
@testable import Kordi

/// Stands in for the ticket request; every attempt fails, and an attempt can be
/// held open to model one in flight.
@MainActor
private final class RealtimeTicketProbe {
    var attempts = 0
    var inFlight = 0
    var maxInFlight = 0
    var holds = false
    var isReady = true
    var error: Error = CloudAPIError(code: "network_error", message: "Offline", statusCode: 0)
    private var held: CheckedContinuation<Void, Never>?
    var isHolding: Bool { held != nil }

    func ticket() async throws -> CloudChatRealtimeConnection {
        attempts += 1
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        defer { inFlight -= 1 }
        if holds { await withCheckedContinuation { held = $0 } }
        throw error
    }

    func release() {
        held?.resume()
        held = nil
    }

    var session: CloudRealtimeLink.Session {
        CloudRealtimeLink.Session(
            isReady: { self.isReady },
            cursor: { "cursor-1" },
            readSequence: { 1 },
            ticket: { try await self.ticket() },
            connected: {},
            event: { _ in },
            resyncRequired: { _ in }
        )
    }
}

@MainActor
final class CloudRealtimeLinkTests: XCTestCase {
    func testFailedAttemptsBackOffAndAWakeRetriesAtOnce() async {
        let sleeper = ReconnectTestSleeper()
        let link = CloudRealtimeLink(policy: RealtimeReconnectPolicy(random: { 1 }), sleep: sleeper.sleep)
        let probe = RealtimeTicketProbe()
        let run = Task { @MainActor in await link.run(probe.session) }

        await reconnectEventually("the first attempt failed and waits") {
            probe.attempts == 1 && sleeper.pending == [.seconds(1)]
        }
        sleeper.fireAll()
        await reconnectEventually("the second attempt failed and waits longer") {
            probe.attempts == 2 && sleeper.pending == [.seconds(2)]
        }
        // The network came back or the app returned to the foreground.
        link.reconnectNow()
        await reconnectEventually("the wake retried at once") {
            probe.attempts == 3 && sleeper.pending == [.seconds(4)]
        }
        XCTAssertEqual(sleeper.requested, [.seconds(1), .seconds(2), .seconds(4)])
        XCTAssertEqual(probe.maxInFlight, 1)

        run.cancel()
        await run.value
    }

    func testWakesDuringAnAttemptNeverStartASecondOne() async {
        let sleeper = ReconnectTestSleeper()
        let link = CloudRealtimeLink(policy: RealtimeReconnectPolicy(random: { 1 }), sleep: sleeper.sleep)
        let probe = RealtimeTicketProbe()
        probe.holds = true
        let run = Task { @MainActor in await link.run(probe.session) }

        await reconnectEventually("the first attempt is in flight") { probe.isHolding }
        link.reconnectNow()
        link.reconnectNow()
        link.reconnectNow()
        XCTAssertEqual(probe.attempts, 1)

        probe.release()
        await reconnectEventually("one retry started at once after the attempt failed") {
            probe.attempts == 2 && probe.isHolding
        }
        XCTAssertEqual(probe.maxInFlight, 1)
        XCTAssertTrue(sleeper.requested.isEmpty)

        probe.holds = false
        probe.release()
        await reconnectEventually("the next failure waits again") { sleeper.pending == [.seconds(2)] }
        XCTAssertEqual(probe.attempts, 2)
        XCTAssertEqual(probe.maxInFlight, 1)

        run.cancel()
        await run.value
    }

    func testRetryAfterHoldsTheNextAttemptEvenWhenWoken() async {
        let sleeper = ReconnectTestSleeper()
        let link = CloudRealtimeLink(policy: RealtimeReconnectPolicy(random: { 0 }), sleep: sleeper.sleep)
        let probe = RealtimeTicketProbe()
        probe.error = CloudAPIError(code: "RATE_LIMITED", message: "Busy", statusCode: 429, retryAfterSeconds: 30)
        let run = Task { @MainActor in await link.run(probe.session) }

        await reconnectEventually("the rate-limited attempt holds for Retry-After") {
            probe.attempts == 1 && sleeper.pending == [.seconds(30)]
        }
        link.reconnectNow()
        for _ in 0..<1_000 { await Task.yield() }
        XCTAssertEqual(probe.attempts, 1)
        XCTAssertEqual(sleeper.pending, [.seconds(30)])
        XCTAssertEqual(sleeper.cancelledCount, 0)

        sleeper.fireAll()
        await reconnectEventually("the next attempt ran after the hold") { probe.attempts == 2 }

        run.cancel()
        await run.value
    }

    func testNoAttemptStartsBeforeTheSyncLoopHoldsACursor() async {
        let sleeper = ReconnectTestSleeper()
        let link = CloudRealtimeLink(policy: RealtimeReconnectPolicy(random: { 1 }), sleep: sleeper.sleep)
        let probe = RealtimeTicketProbe()
        probe.isReady = false
        let run = Task { @MainActor in await link.run(probe.session) }

        await reconnectEventually("the link polls for a cursor") { sleeper.pending == [.milliseconds(100)] }
        XCTAssertEqual(probe.attempts, 0)
        probe.isReady = true
        sleeper.fireAll()
        await reconnectEventually("the first attempt ran") { probe.attempts == 1 && sleeper.pending == [.seconds(1)] }

        run.cancel()
        await run.value
    }
}
