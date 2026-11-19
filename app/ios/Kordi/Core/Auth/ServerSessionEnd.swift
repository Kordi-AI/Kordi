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

    /// A realtime socket the server closed. The close code decides; the
    /// reason (`account_deleted`) is informational.
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
