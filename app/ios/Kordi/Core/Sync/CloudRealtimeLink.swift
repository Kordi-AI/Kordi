import Foundation

struct CloudRealtimeConnectFrame: Encodable {
    let type = "connect"
    let protocolVersion = 2
    let deviceId: String
    let cursor: String

    enum CodingKeys: String, CodingKey {
        case type, cursor
        case protocolVersion = "protocol_version"
        case deviceId = "device_id"
    }
}

struct CloudRealtimeHeartbeatFrame: Encodable {
    let type = "heartbeat"
    let lastAppliedSequence: Int64

    enum CodingKeys: String, CodingKey {
        case type
        case lastAppliedSequence = "last_applied_seq"
    }
}

struct CloudRealtimeServerFrame: Decodable {
    let type: String
    let streamSequence: Int64?
    let event: CloudChatEvent?
    /// Why the server asked for a resync, such as `SYNC_CURSOR_EXPIRED`.
    let reason: String?

    var call: CloudCall? {
        guard let event,
              event.eventType == "call.created" || event.eventType == "call.updated" else {
            return nil
        }
        return event.payload.call
    }

    enum CodingKeys: String, CodingKey {
        case type, event, reason
        case streamSequence = "stream_seq"
    }
}

/// Keeps one realtime socket open at a time. Frames only wake the durable HTTP
/// cursor reader; the socket never decides what is stored.
///
/// A closed socket or failed attempt is retried with `RealtimeReconnectPolicy`.
/// A waiting retry runs at once when the network returns or the app comes to
/// the foreground; an attempt in flight is never doubled.
@MainActor
final class CloudRealtimeLink {
    struct Session {
        /// False until the sync loop holds a cursor the socket can resume from.
        var isReady: @MainActor () -> Bool
        var cursor: @MainActor () -> String
        /// The newest stream sequence the sync loop has read.
        var readSequence: @MainActor () -> Int64
        var ticket: @MainActor () async throws -> CloudChatRealtimeConnection
        /// The socket is open: catch up from the saved cursor.
        var connected: @MainActor () -> Void
        var event: @MainActor (CloudRealtimeServerFrame) -> Void
        /// The server will close this socket; catch up from the saved cursor.
        var resyncRequired: @MainActor (_ reason: String?) -> Void
    }

    static let heartbeatInterval: Duration = .seconds(25)
    /// Each heartbeat is acknowledged, so a socket silent this long is dead.
    static let silenceLimit: Duration = .seconds(60)

    private var policy: RealtimeReconnectPolicy
    private let sleep: CoalescingWakeSignal.Sleep
    private let wakes: CoalescingWakeSignal
    private var session: Session?
    private var lastReceivedSequence: Int64 = 0
    private var lastFrameAt = ContinuousClock.now

    init(
        policy: RealtimeReconnectPolicy = RealtimeReconnectPolicy(),
        sleep: @escaping CoalescingWakeSignal.Sleep = { try await Task.sleep(for: $0) }
    ) {
        self.policy = policy
        self.sleep = sleep
        wakes = CoalescingWakeSignal(sleep: sleep)
    }

    /// Ends a waiting retry at once. While an attempt is in flight or a socket
    /// is open this only marks that the next close should not wait.
    func reconnectNow() {
        wakes.wake()
    }

    /// Runs until the task is cancelled.
    func run(_ session: Session) async {
        self.session = session
        let recovery = ConnectivityRecoveryObserver { [weak self] in self?.reconnectNow() }
        defer {
            withExtendedLifetime(recovery) {}
            self.session = nil
        }
        while !Task.isCancelled {
            guard session.isReady() else {
                try? await sleep(.milliseconds(100))
                continue
            }
            var retryAfter: Duration?
            do {
                try await connect(try await session.ticket(), session)
            } catch {
                if Task.isCancelled { return }
                retryAfter = CloudRetryAfter.delay(for: error)
            }
            policy.connectionClosed()
            let delay = policy.nextDelay(retryAfter: retryAfter)
            if retryAfter == nil {
                await wakes.wait(upTo: delay)
            } else {
                // A wake does not shorten a delay the server asked for.
                try? await sleep(delay)
            }
        }
    }

    private func connect(_ connection: CloudChatRealtimeConnection, _ session: Session) async throws {
        let socket = URLSession.shared.webSocketTask(with: connection.url)
        lastReceivedSequence = session.readSequence()
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await Self.send(CloudRealtimeConnectFrame(deviceId: connection.deviceId, cursor: session.cursor()), over: socket)
        policy.connectionOpened()
        lastFrameAt = .now
        session.connected()
        let heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.heartbeatInterval)
                guard let self, !Task.isCancelled else { return }
                guard lastFrameAt.duration(to: .now) < Self.silenceLimit else {
                    socket.cancel(with: .goingAway, reason: nil)
                    return
                }
                // Never ahead of what this socket delivered, or the server closes it.
                let applied = min(self.session?.readSequence() ?? 0, lastReceivedSequence)
                try? await Self.send(CloudRealtimeHeartbeatFrame(lastAppliedSequence: applied), over: socket)
            }
        }
        defer { heartbeat.cancel() }
        while !Task.isCancelled {
            guard let frame = try await Self.receive(from: socket) else { continue }
            lastFrameAt = .now
            // A wake that arrived while frames still flow was not a lost connection.
            wakes.discardPending()
            switch frame.type {
            case "event":
                if let streamSequence = frame.streamSequence {
                    lastReceivedSequence = max(lastReceivedSequence, streamSequence)
                }
                session.event(frame)
            case "resync_required":
                session.resyncRequired(frame.reason)
                return
            default:
                continue
            }
        }
    }

    private static func receive(from socket: URLSessionWebSocketTask) async throws -> CloudRealtimeServerFrame? {
        let message = try await withTaskCancellationHandler {
            try await socket.receive()
        } onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
        }
        let data: Data
        switch message {
        case .string(let value): data = Data(value.utf8)
        case .data(let value): data = value
        @unknown default: return nil
        }
        return try JSONDecoder().decode(CloudRealtimeServerFrame.self, from: data)
    }

    private static func send<Frame: Encodable>(_ frame: Frame, over socket: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(frame)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
}
