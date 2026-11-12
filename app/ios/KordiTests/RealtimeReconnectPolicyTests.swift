import Foundation
import XCTest
@testable import Kordi

final class RealtimeReconnectPolicyTests: XCTestCase {
    func testCeilingDoublesFromOneSecondAndStopsAtSixty() {
        var policy = RealtimeReconnectPolicy(random: { 1 })
        let delays = (0..<9).map { _ in policy.nextDelay() }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60].map { Duration.seconds($0) })
        XCTAssertEqual(policy.failedAttempts, 9)
    }

    func testFullJitterScalesTheCeilingByTheRandomSource() {
        let random = ReconnectTestRandom([0, 0.5, 0.25, 0.75])
        var policy = RealtimeReconnectPolicy(random: random.next)
        XCTAssertEqual(policy.nextDelay(), .zero)
        XCTAssertEqual(policy.nextDelay(), .seconds(1))
        XCTAssertEqual(policy.nextDelay(), .seconds(1))
        XCTAssertEqual(policy.nextDelay(), .seconds(6))
    }

    func testEveryDelayStaysBetweenZeroAndItsCeiling() {
        let random = ReconnectTestRandom((0..<40).map { Double($0 % 7) / 6 } + [-0.5, 1.5])
        var policy = RealtimeReconnectPolicy(random: random.next)
        for _ in 0..<42 {
            let ceiling = policy.ceiling
            let delay = policy.nextDelay()
            XCTAssertGreaterThanOrEqual(delay, .zero)
            XCTAssertLessThanOrEqual(delay, ceiling)
            XCTAssertLessThanOrEqual(delay, RealtimeReconnectPolicy.maximumDelay)
        }
    }

    func testAttemptsResetOnlyAfterTheSocketStayedOpenForThirtySeconds() {
        let clock = ReconnectTestClock()
        var policy = RealtimeReconnectPolicy(random: { 1 }, now: { clock.now })
        _ = policy.nextDelay()
        _ = policy.nextDelay()
        _ = policy.nextDelay()
        XCTAssertEqual(policy.ceiling, .seconds(8))

        // The server closes the socket right after the handshake.
        policy.connectionOpened()
        clock.advance(by: .seconds(29))
        policy.connectionClosed()
        XCTAssertEqual(policy.failedAttempts, 3)
        XCTAssertEqual(policy.nextDelay(), .seconds(8))

        // A failed attempt without an open socket never resets.
        clock.advance(by: .seconds(120))
        policy.connectionClosed()
        XCTAssertEqual(policy.failedAttempts, 4)

        policy.connectionOpened()
        clock.advance(by: .seconds(30))
        policy.connectionClosed()
        XCTAssertEqual(policy.failedAttempts, 0)
        XCTAssertEqual(policy.nextDelay(), .seconds(1))
    }

    func testRetryAfterIsALowerBoundWithJitterOnTop() {
        let random = ReconnectTestRandom([0, 0.5])
        var policy = RealtimeReconnectPolicy(random: random.next)
        XCTAssertEqual(policy.nextDelay(retryAfter: .seconds(30)), .seconds(30))
        XCTAssertEqual(policy.nextDelay(retryAfter: .seconds(30)), .seconds(31))
    }

    func testRetryAfterIsReadOnlyFromTooManyRequestsAndUnavailable() {
        func error(_ status: Int, retryAfter: Int?) -> CloudAPIError {
            CloudAPIError(code: "busy", message: "Busy", statusCode: status, retryAfterSeconds: retryAfter)
        }
        XCTAssertEqual(CloudRetryAfter.delay(for: error(429, retryAfter: 12)), .seconds(12))
        XCTAssertEqual(CloudRetryAfter.delay(for: error(503, retryAfter: 3)), .seconds(3))
        XCTAssertNil(CloudRetryAfter.delay(for: error(500, retryAfter: 3)))
        XCTAssertNil(CloudRetryAfter.delay(for: error(429, retryAfter: nil)))
        XCTAssertNil(CloudRetryAfter.delay(for: URLError(.timedOut)))
    }
}
