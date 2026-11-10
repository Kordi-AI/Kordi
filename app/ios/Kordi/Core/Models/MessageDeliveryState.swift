import Foundation

/// What the viewer sees for a message: one tick once the server has it, two
/// ticks once it is read (in a group, by at least one other member). There
/// is no delivered state (#2455).
enum MessageDeliveryState: Codable, Hashable, RawRepresentable {
    case sending
    case sent
    case read
    case failed
    case cancelled

    /// Stored records and caches written before #2455 may say "delivered";
    /// it reads as sent, which drew the same single tick.
    init?(rawValue: String) {
        switch rawValue {
        case "sending": self = .sending
        case "sent", "delivered": self = .sent
        case "read": self = .read
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: return nil
        }
    }

    var rawValue: String {
        switch self {
        case .sending: "sending"
        case .sent: "sent"
        case .read: "read"
        case .failed: "failed"
        case .cancelled: "cancelled"
        }
    }

    var label: String {
        switch self {
        case .sending: "Sending"
        case .sent: "Sent"
        case .read: "Seen"
        case .failed: "Failed to send"
        case .cancelled: "Canceled"
        }
    }
}
