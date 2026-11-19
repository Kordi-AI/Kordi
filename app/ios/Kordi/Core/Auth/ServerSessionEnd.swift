import Foundation

/// Kordi Cloud ended this iPhone's sign-in. Only a real server answer counts:
/// HTTP 401 with one of the codes below, a refused browser sign-in refresh,
/// or the realtime socket's account-deleted close. Errors the app makes up
/// itself, other status codes and network failures never end the session.
enum ServerSessionEnd: Equatable, Sendable {
    /// The account was deleted, on this device, on another one, or by an operator.
    case accountDeleted
    /// Signed out elsewhere, or the session expired.
    case signedOut

    static let accountDeletedCode = "account_deleted"
    static let signedOutCodes: Set<String> = ["invalid_session", "login_required"]
    /// The realtime socket's close code when the account is gone.
    static let accountDeletedCloseCode = 4410

    init?(_ error: Error) {
        guard let error = error as? CloudAPIError, error.fromServer, error.statusCode == 401 else { return nil }
        if error.code == Self.accountDeletedCode {
            self = .accountDeleted
        } else if Self.signedOutCodes.contains(error.code) {
            self = .signedOut
        } else {
            return nil
        }
    }

    /// A response the app hands on unread, such as the document editor's
    /// collaboration ticket: the error code is read as `CloudAPIClient` reads
    /// it (`error.code`, then `errorCode`, then `code`).
    init?(status: Int, body: Data) {
        guard status == 401,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        let nested = object["error"] as? [String: Any]
        guard let code = (nested?["code"] as? String) ?? (object["errorCode"] as? String) ?? (object["code"] as? String)
        else { return nil }
        self.init(CloudAPIError(code: code, message: "", statusCode: status, fromServer: true))
    }

    /// A socket the server closed (chat realtime or document editing). The
    /// close code decides; the reason (`account_deleted`) is informational.
    init?(realtimeCloseCode code: Int) {
        guard code == Self.accountDeletedCloseCode else { return nil }
        self = .accountDeleted
    }

    /// The error a refused launch reports, so the launch path treats it as
    /// the server's answer.
    var launchError: CloudAPIError {
        switch self {
        case .accountDeleted:
            CloudAPIError(code: Self.accountDeletedCode, message: "", statusCode: 401, fromServer: true)
        case .signedOut:
            CloudAPIError(code: "invalid_session", message: "Your session expired. Sign in again.", statusCode: 401, fromServer: true)
        }
    }
}
