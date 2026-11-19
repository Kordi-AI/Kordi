import Foundation

/// One collaboration socket the editor page uses, carried by the app.
protocol DocumentEditorSocket: AnyObject {
    func send(_ data: Data) async throws
    /// The next binary frame; throws when the socket closes.
    func receive() async throws -> Data
    func close()
    /// The close code once the socket is closed, 1006 when it dropped.
    var closeCode: Int { get }
}

/// How the editor reaches the server: requests with the session token, and
/// the collaboration socket. The page never sees the token.
@MainActor
protocol DocumentEditorTransport: AnyObject {
    func request(method: String, path: String, body: Data?) async throws -> (status: Int, body: Data)
    func socket(path: String, ticket: String) async throws -> any DocumentEditorSocket
}

/// The server ended the sign-in, for a request or socket that used `token`.
typealias DocumentSessionEndHandler = @MainActor (_ end: ServerSessionEnd, _ token: String) -> Void

/// The signed-in account's transport. The page reads every answer itself;
/// a refused collaboration ticket or a socket closed because the account is
/// gone also reaches the app's session handler.
@MainActor
final class CloudDocumentEditorTransport: DocumentEditorTransport {
    /// The server accepts frames up to 4 MiB.
    static let maximumMessageSize = 4 * 1024 * 1024
    private let api: CloudAPIClient
    private let tokenProvider: @MainActor () -> String?
    private let sessionEnded: DocumentSessionEndHandler?

    init(
        api: CloudAPIClient,
        tokenProvider: @escaping @MainActor () -> String?,
        sessionEnded: DocumentSessionEndHandler? = nil
    ) {
        self.api = api
        self.tokenProvider = tokenProvider
        self.sessionEnded = sessionEnded
    }

    private func token() throws -> String {
        guard let token = tokenProvider() else {
            throw CloudAPIError(code: "unauthorized", message: "Sign in to continue.", statusCode: 401)
        }
        return token
    }

    func request(method: String, path: String, body: Data?) async throws -> (status: Int, body: Data) {
        let token = try self.token()
        let request = try await api.makeRequest(path: path, method: method, token: token, query: [], body: body)
        let (data, response) = try await api.transportData(for: request, fallback: "Could not reach Kordi Cloud.")
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let end = ServerSessionEnd(status: status, body: data) { sessionEnded?(end, token) }
        return (status, data)
    }

    /// A native socket sends no `Origin`, which is what the server binds a
    /// ticket from a native client to.
    func socket(path: String, ticket: String) async throws -> any DocumentEditorSocket {
        let request = try await api.makeRequest(
            path: path, method: "GET", token: nil, query: [URLQueryItem(name: "ticket", value: ticket)], body: nil
        )
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CloudAPIError(code: "invalid_url", message: "Kordi Cloud URL is invalid.", statusCode: 0)
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        guard let socketURL = components.url else {
            throw CloudAPIError(code: "invalid_url", message: "Kordi Cloud URL is invalid.", statusCode: 0)
        }
        let task = URLSession.shared.webSocketTask(with: socketURL)
        task.maximumMessageSize = Self.maximumMessageSize
        task.resume()
        // The ticket was issued for the token in use now.
        let ticketToken = tokenProvider()
        let handler = self.sessionEnded
        return URLSessionDocumentEditorSocket(task: task) { end in
            guard let ticketToken else { return }
            handler?(end, ticketToken)
        }
    }
}

final class URLSessionDocumentEditorSocket: DocumentEditorSocket {
    private let task: URLSessionWebSocketTask
    private let sessionEnded: (@MainActor (ServerSessionEnd) -> Void)?

    init(task: URLSessionWebSocketTask, sessionEnded: (@MainActor (ServerSessionEnd) -> Void)? = nil) {
        self.task = task
        self.sessionEnded = sessionEnded
    }

    var closeCode: Int {
        task.closeCode == .invalid ? 1006 : task.closeCode.rawValue
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func receive() async throws -> Data {
        do {
            while true {
                switch try await task.receive() {
                case .data(let data): return data
                case .string: continue
                @unknown default: continue
                }
            }
        } catch {
            if let end = ServerSessionEnd(realtimeCloseCode: closeCode) { await sessionEnded?(end) }
            throw error
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// `--preview-shared-document`: the editor against the in-memory preview
/// document. There is no room, so edits are revisioned saves kept here.
@MainActor
final class PreviewDocumentEditorTransport: DocumentEditorTransport {
    private(set) var document: DocumentResponse
    private(set) var savedSources: [String] = []

    init(document: DocumentResponse) {
        self.document = document
    }

    private static let encoder = JSONEncoder()

    func request(method: String, path: String, body: Data?) async throws -> (status: Int, body: Data) {
        if path.hasSuffix("/content"), let body,
           let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let source = fields["source"] as? String {
            savedSources.append(source)
            document.revision = (document.revision ?? 0) + 1
        } else if path.hasSuffix("/collab/ticket") || path.hasSuffix("/collab/init") {
            return (403, Data(#"{"message":"No room in the preview."}"#.utf8))
        }
        return (200, try Self.encoder.encode(document))
    }

    func socket(path: String, ticket: String) async throws -> any DocumentEditorSocket {
        throw CloudAPIError(code: "unavailable", message: "No room in the preview.", statusCode: 0)
    }
}
