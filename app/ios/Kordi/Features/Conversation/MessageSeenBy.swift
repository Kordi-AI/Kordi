import Foundation
import Observation

/// One reader of the viewer's group message, named from the group members.
struct MessageReaderRow: Identifiable, Equatable {
    let accountId: String
    let displayName: String
    let avatarUrl: String?
    /// Nil when the server no longer has the time.
    let readAt: Date?

    var id: String { accountId }
}

/// The group message a "Seen by" request is for (#2455).
struct MessageSeenByTarget: Identifiable, Hashable {
    let sessionId: String
    /// The canonical message id other message routes use (reactions, edits).
    let messageId: String
    let participants: [CloudGroupParticipant]
    /// Offline preview data only: the readers its bubble claims.
    var previewReaderIds: [String] = []

    var id: String { "\(sessionId)\u{1F}\(messageId)" }
}

typealias MessageReadersLoader = @MainActor (MessageSeenByTarget, Int) async throws -> CloudMessageReadersResponse

/// The "Seen by" row at the bottom of the message menu.
enum MessageSeenByState: Equatable {
    /// No row: an incoming message, outside groups, a group of more than 100
    /// active members, or a failed fetch.
    case hidden
    case loading
    /// "Not seen yet"; it cannot be chosen.
    case none
    case one(MessageReaderRow)
    case several(total: Int, faces: [MessageReaderRow])

    var isVisible: Bool { self != .hidden }

    var opensList: Bool {
        switch self {
        case .one, .several: true
        case .hidden, .loading, .none: false
        }
    }

    var label: String? {
        switch self {
        case .hidden, .loading: nil
        case .none: "Not seen yet"
        case let .one(reader): reader.displayName
        case let .several(total, _): "\(total) Seen"
        }
    }

    var faces: [MessageReaderRow] {
        switch self {
        case let .one(reader): [reader]
        case let .several(_, faces): faces
        case .hidden, .loading, .none: []
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .hidden: ""
        case .loading: "Loading who has seen this"
        case .none: "Not seen yet"
        case let .one(reader): "Seen by \(reader.displayName)"
        case let .several(total, _): "\(total) Seen"
        }
    }
}

enum MessageSeenByPresentation {
    /// Groups larger than this offer no row; the server answers 409 for them.
    static let largeGroupLimit = 100
    static let faceLimit = 4

    /// The request for the viewer's own sent group message, or nil when the
    /// menu has no row.
    static func target(
        for message: ChatMessage,
        in conversation: ConversationSummary,
        isPreviewMode: Bool = false
    ) -> MessageSeenByTarget? {
        guard conversation.kind == .group,
              message.author == .me,
              !message.isSystemNotice,
              message.deliveryState == .sent || message.deliveryState == .read,
              conversation.groupParticipants.count <= largeGroupLimit,
              let messageId = message.reactionTargetMessageId?.nonEmpty
                ?? (isPreviewMode ? message.id.nonEmpty : nil) else { return nil }
        return MessageSeenByTarget(
            sessionId: conversation.sessionId,
            messageId: messageId,
            participants: conversation.groupParticipants,
            previewReaderIds: isPreviewMode ? message.readByAccountIds : []
        )
    }

    static func state(
        for response: CloudMessageReadersResponse,
        participants: [CloudGroupParticipant]
    ) -> MessageSeenByState {
        let readers = readers(in: response, participants: participants)
        let total = max(response.total, readers.count)
        guard total > 0 else { return .none }
        if total == 1, let reader = readers.first { return .one(reader) }
        return .several(total: total, faces: Array(readers.prefix(faceLimit)))
    }

    /// Readers in the order the server returned them, each named from the
    /// group members; an unknown member reads as "Kordi user".
    static func readers(
        in response: CloudMessageReadersResponse,
        participants: [CloudGroupParticipant]
    ) -> [MessageReaderRow] {
        let participantsByID = Dictionary(
            participants.map { ($0.accountId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var seen = Set<String>()
        return response.readers.compactMap { reader in
            guard let accountId = reader.accountId.nonEmpty, seen.insert(accountId).inserted else { return nil }
            let participant = participantsByID[accountId]
            return MessageReaderRow(
                accountId: accountId,
                displayName: participant?.displayName.nonEmpty ?? "Kordi user",
                avatarUrl: participant?.avatarUrl?.nonEmpty,
                readAt: reader.readAt?.nonEmpty.map(parseCloudDate).flatMap { $0 == .distantPast ? nil : $0 }
            )
        }
    }

    /// "10:41 AM" today, "Yesterday, 10:41 AM", then "Nov 3, 10:41 AM".
    static func readTimeLabel(
        _ date: Date?,
        now: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) -> String? {
        guard let date else { return nil }
        let base = Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let time = date.formatted(base.hour().minute())
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday, \(time)"
        }
        let day = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            ? date.formatted(base.month(.abbreviated).day())
            : date.formatted(base.month(.abbreviated).day().year())
        return "\(day), \(time)"
    }

    /// Offline preview data: the bubble's readers, a minute apart.
    static func previewResponse(for target: MessageSeenByTarget, limit: Int, now: Date = Date()) -> CloudMessageReadersResponse {
        let readers = target.previewReaderIds.enumerated().map { index, accountId in
            CloudMessageReader(
                accountId: accountId,
                readAt: now.addingTimeInterval(Double(index - target.previewReaderIds.count) * 60).ISO8601Format()
            )
        }
        return CloudMessageReadersResponse(total: readers.count, readers: Array(readers.prefix(limit)))
    }
}

/// Loads the row when the menu opens and drops a response that arrives after
/// the menu closed or moved to another message.
@Observable
@MainActor
final class MessageSeenByModel {
    private(set) var state: MessageSeenByState = .hidden
    private(set) var target: MessageSeenByTarget?
    @ObservationIgnored private var generation = 0

    /// What the menu shows for `target`: loading until this model has started
    /// on it, so the row is laid out on the first frame and an earlier
    /// message's readers never appear on another message.
    func state(for target: MessageSeenByTarget?) -> MessageSeenByState {
        guard let target else { return .hidden }
        return self.target == target ? state : .loading
    }

    /// Runs inside `.task(id:)`, so closing the menu or choosing another
    /// message cancels it.
    func load(_ target: MessageSeenByTarget?, using loader: MessageReadersLoader) async {
        let token = begin(target)
        guard let target else { return }
        let result: Result<CloudMessageReadersResponse, Error>
        do {
            result = .success(try await loader(target, CloudAPIClient.messageReadersPreviewLimit))
        } catch {
            result = .failure(error)
        }
        guard !Task.isCancelled else { return }
        finish(result, participants: target.participants, token: token)
    }

    /// Shows the loading row, or no row without a target; returns the token
    /// a response must carry.
    @discardableResult
    func begin(_ target: MessageSeenByTarget?) -> Int {
        generation += 1
        self.target = target
        state = target == nil ? .hidden : .loading
        return generation
    }

    func finish(
        _ result: Result<CloudMessageReadersResponse, Error>,
        participants: [CloudGroupParticipant],
        token: Int
    ) {
        guard token == generation, state == .loading else { return }
        switch result {
        case let .success(response):
            state = MessageSeenByPresentation.state(for: response, participants: participants)
        case .failure:
            state = .hidden
        }
    }

    func close() {
        generation += 1
        target = nil
        state = .hidden
    }
}

/// The full list sheet: every reader in the order returned, with a time.
enum MessageReadersListState: Equatable {
    case loading
    case loaded([MessageReaderRow])
    case failed
}
