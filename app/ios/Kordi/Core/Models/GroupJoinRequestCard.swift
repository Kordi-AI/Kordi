import Foundation

/// A request to join a group started from a Grounding room, as the
/// `group_join_request` block in the group chat and as the join-request
/// endpoints return it. Decoded leniently so an unexpected field never hides
/// the message.
struct GroupJoinRequestCard: Codable, Hashable, Identifiable, Sendable {
    struct Person: Codable, Hashable, Sendable {
        let accountId: String
        let name: String?
        let handle: String?
        let avatarUrl: String?

        var displayName: String { name?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Kordi user" }

        var firstName: String {
            displayName.split(separator: " ").first.map(String.init) ?? displayName
        }

        private enum CodingKeys: String, CodingKey { case accountId, name, handle, avatarUrl }

        init(from decoder: Decoder) throws {
            let data = try decoder.container(keyedBy: CodingKeys.self)
            accountId = try data.decode(String.self, forKey: .accountId)
            name = (try? data.decodeIfPresent(String.self, forKey: .name)) ?? nil
            handle = (try? data.decodeIfPresent(String.self, forKey: .handle)) ?? nil
            avatarUrl = (try? data.decodeIfPresent(String.self, forKey: .avatarUrl)) ?? nil
        }
    }

    let requestId: String
    let groupSpaceId: String
    let conversationId: String?
    let groupName: String
    let roomName: String
    let requester: Person?
    /// "pending", "approved", "declined" or "cancelled".
    let status: String
    let approverIds: [String]
    let decidedBy: Person?
    let revision: Int

    var id: String { requestId }
    var isPending: Bool { status == "pending" }

    func canDecide(accountId: String?) -> Bool {
        guard isPending, let accountId else { return false }
        return approverIds.contains(accountId)
    }

    private enum CodingKeys: String, CodingKey {
        case requestId, groupSpaceId, conversationId, groupName, roomName
        case requester, status, approverIds, decidedBy, revision
    }

    init(from decoder: Decoder) throws {
        let data = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try data.decode(String.self, forKey: .requestId)
        groupSpaceId = (try? data.decodeIfPresent(String.self, forKey: .groupSpaceId)) ?? ""
        conversationId = (try? data.decodeIfPresent(String.self, forKey: .conversationId)) ?? nil
        groupName = (try? data.decodeIfPresent(String.self, forKey: .groupName)) ?? ""
        roomName = (try? data.decodeIfPresent(String.self, forKey: .roomName)) ?? ""
        requester = (try? data.decodeIfPresent(Person.self, forKey: .requester)) ?? nil
        status = (try? data.decodeIfPresent(String.self, forKey: .status)) ?? "pending"
        approverIds = (try? data.decodeIfPresent([String].self, forKey: .approverIds)) ?? []
        decidedBy = (try? data.decodeIfPresent(Person.self, forKey: .decidedBy)) ?? nil
        revision = (try? data.decodeIfPresent(Int.self, forKey: .revision)) ?? 0
    }
}

/// The join-request endpoints answer `{ "request": snapshot }`; a bare
/// snapshot is accepted too.
struct GroupJoinRequestResponse: Decodable, Sendable {
    let request: GroupJoinRequestCard

    private enum CodingKeys: String, CodingKey { case request }

    init(from decoder: Decoder) throws {
        let data = try decoder.container(keyedBy: CodingKeys.self)
        if let wrapped = try data.decodeIfPresent(GroupJoinRequestCard.self, forKey: .request) {
            request = wrapped
        } else {
            request = try GroupJoinRequestCard(from: decoder)
        }
    }
}
