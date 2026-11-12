import Foundation

struct FacilitatorCard: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case decision, memory, task

        var label: String {
            switch self {
            case .decision: "Decision poll"
            case .memory: "Shared Memory draft"
            case .task: "Proposed assignment"
            }
        }
    }

    let cardId: UUID
    let kind: Kind
    let revision: Int
    let title: String
    let detail: String?
    let result: String?
    let options: [String]
    let counts: [Int]
    let myVote: Int?
    let managerIds: [String]
    let assigneeId: String?
    let assigneeName: String?

    var id: UUID { cardId }

    private enum CodingKeys: String, CodingKey {
        case cardId, kind, revision, title, detail, result, options, counts, myVote
        case managerIds, assigneeId, assigneeName
    }

    init(from decoder: Decoder) throws {
        let data = try decoder.container(keyedBy: CodingKeys.self)
        cardId = try data.decode(UUID.self, forKey: .cardId)
        kind = try data.decode(Kind.self, forKey: .kind)
        revision = try data.decode(Int.self, forKey: .revision)
        title = try data.decode(String.self, forKey: .title)
        detail = try data.decodeIfPresent(String.self, forKey: .detail)
        result = try data.decodeIfPresent(String.self, forKey: .result)
        options = try data.decodeIfPresent([String].self, forKey: .options) ?? []
        counts = try data.decodeIfPresent([Int].self, forKey: .counts) ?? []
        myVote = try data.decodeIfPresent(Int.self, forKey: .myVote)
        managerIds = try data.decodeIfPresent([String].self, forKey: .managerIds) ?? []
        assigneeId = try data.decodeIfPresent(String.self, forKey: .assigneeId)
        assigneeName = try data.decodeIfPresent(String.self, forKey: .assigneeName)
    }

    var winningOption: Int? {
        guard let top = counts.max(), top > 0 else { return nil }
        let leaders = counts.indices.filter { counts[$0] == top }
        guard leaders.count == 1, let winner = leaders.first, options.indices.contains(winner) else { return nil }
        return winner
    }

    var status: String? {
        switch kind {
        case .task:
            switch result {
            case nil, "pending": "Awaiting approval"
            case "approved": "Approved"
            case "running": "In progress"
            case "done": "Completed"
            case "failed": "Run failed"
            case "declined": "Declined"
            case "expired": "Approval expired"
            default: nil
            }
        case .memory:
            result == nil ? nil : "Saved to Memory"
        case .decision:
            result.flatMap(Int.init).flatMap { options.indices.contains($0) ? "Confirmed · \(options[$0])" : nil }
        }
    }

    func canApprove(accountId: String?) -> Bool {
        kind == .task && accountId != nil && accountId == assigneeId && (result == nil || result == "pending")
    }
}

struct FacilitatorCardAction: Encodable, Sendable {
    let action: String
    var revision: Int? = nil
    var option: Int? = nil
}
