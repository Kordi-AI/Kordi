import Foundation

// Inviting people you share Grounding with into your groups: the groups a
// person can be invited to, the people a group can invite, and the result
// of sending invitations. Decoding is lenient so a bad entry is skipped.

private extension KeyedDecodingContainer {
    func inviteValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// A list where entries that do not decode are skipped.
    func inviteList<T: Decodable>(_ key: Key) -> [T] {
        guard var items = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var decoded: [T] = []
        while !items.isAtEnd {
            if let item = try? items.decode(T.self) {
                decoded.append(item)
            } else if (try? items.decode(CommonGroundInviteSkippedEntry.self)) == nil {
                break
            }
        }
        return decoded
    }
}

private struct CommonGroundInviteSkippedEntry: Decodable {}

/// A group the viewer manages, offered on a person's Grounding page.
struct CommonGroundInviteGroup: Decodable, Hashable, Identifiable {
    /// Where the person stands in this group.
    enum State: String, Decodable, Hashable {
        case member, invited
    }

    let groupSpaceId: String
    let conversationId: String?
    let name: String
    let memberCount: Int
    /// Up to four members, the owner first.
    let members: [CommonGroundPerson]
    let state: State?

    var id: String { groupSpaceId }

    var title: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Group"
    }

    /// The trailing label for a row that cannot be picked.
    var stateTitle: String? {
        switch state {
        case .member: "Member"
        case .invited: "Invited"
        case nil: nil
        }
    }

    /// The avatar grid keeps the server's order, owner first.
    var participants: [CloudGroupParticipant] {
        members.enumerated().map { index, person in
            CloudGroupParticipant(accountId: person.accountId, displayName: person.displayName,
                                  avatarUrl: person.avatarUrl, role: nil, joinedAt: String(format: "%04d", index))
        }
    }

    init(groupSpaceId: String, conversationId: String? = nil, name: String, memberCount: Int,
         members: [CommonGroundPerson] = [], state: State? = nil) {
        self.groupSpaceId = groupSpaceId
        self.conversationId = conversationId
        self.name = name
        self.memberCount = memberCount
        self.members = members
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case groupSpaceId, conversationId, name, memberCount, members, state }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groupSpaceId = try c.decode(String.self, forKey: .groupSpaceId)
        guard !groupSpaceId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .groupSpaceId, in: c, debugDescription: "Missing group")
        }
        conversationId = c.inviteValue(.conversationId, nil as String?)?.nonEmpty
        name = c.inviteValue(.name, "")
        members = c.inviteList(.members)
        memberCount = max(c.inviteValue(.memberCount, 0), members.count)
        // An unknown state reads as already handled, so the row cannot be sent twice.
        if let raw = c.inviteValue(.state, nil as String?) {
            state = State(rawValue: raw) ?? .invited
        } else {
            state = nil
        }
    }
}

/// `GET people/:id/groups`.
struct CommonGroundInviteGroups: Decodable, Hashable {
    /// The person is a contact, so picking a group adds them directly.
    let contact: Bool
    let groups: [CommonGroundInviteGroup]

    init(contact: Bool, groups: [CommonGroundInviteGroup]) {
        self.contact = contact
        self.groups = groups
    }

    private enum CodingKeys: String, CodingKey { case contact, groups }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        contact = c.inviteValue(.contact, false)
        groups = c.inviteList(.groups)
    }
}

/// Someone a group can invite: a person the viewer shares Grounding with.
struct CommonGroundGroupCandidate: Decodable, Hashable, Identifiable {
    let person: CommonGroundPerson
    /// The most recent room both are in; nil when they share a match.
    let source: String?
    /// A pending invitation to this group exists.
    let invited: Bool

    var id: String { person.accountId }

    /// The row's second line.
    var detail: String {
        source?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Match"
    }

    init(person: CommonGroundPerson, source: String? = nil, invited: Bool = false) {
        self.person = person
        self.source = source
        self.invited = invited
    }

    private enum CodingKeys: String, CodingKey { case person, source, invited }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        person = try c.decode(CommonGroundPerson.self, forKey: .person)
        guard !person.accountId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .person, in: c, debugDescription: "Missing person")
        }
        source = c.inviteValue(.source, nil as String?)
        invited = c.inviteValue(.invited, false)
    }
}

/// `GET group-people?groupSpaceId=`.
struct CommonGroundGroupCandidates: Decodable, Hashable {
    let people: [CommonGroundGroupCandidate]

    private enum CodingKeys: String, CodingKey { case people }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var seen = Set<String>()
        people = (c.inviteList(.people) as [CommonGroundGroupCandidate]).filter { seen.insert($0.id).inserted }
    }
}

/// `POST group-invitations`.
struct CommonGroundGroupInviteResult: Decodable, Hashable {
    struct Skipped: Decodable, Hashable {
        let accountId: String
        /// "member", "invited", "declined", "unavailable" or "limit".
        let reason: String

        /// Skipped because the person is already there or already invited.
        var isSettled: Bool { reason == "member" || reason == "invited" }
    }

    let invited: [CommonGroundPerson]
    let added: [CommonGroundPerson]
    let skipped: [Skipped]

    init(invited: [CommonGroundPerson] = [], added: [CommonGroundPerson] = [], skipped: [Skipped] = []) {
        self.invited = invited
        self.added = added
        self.skipped = skipped
    }

    private enum CodingKeys: String, CodingKey { case invited, added, skipped }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invited = c.inviteList(.invited)
        added = c.inviteList(.added)
        skipped = c.inviteList(.skipped)
    }

    static let limitMessage = "You have too many pending invitations."

    /// Some people were skipped because the inviter has too many pending invitations.
    var limitReached: Bool { skipped.contains { $0.reason == "limit" } }

    /// One line when some people could not be invited, else nil. Neutral:
    /// it never says that someone declined.
    var problem: String? {
        let unsettled = skipped.filter { !$0.isSettled }
        guard !unsettled.isEmpty else { return nil }
        if limitReached { return Self.limitMessage }
        return unsettled.count == 1 ? "Could not invite one person." : "Could not invite \(unsettled.count) people."
    }
}

extension AppModel {
    /// People from Grounding that a group can invite. Nil when the server
    /// has no such list, refuses, or fails, so the section stays hidden.
    func groundingGroupCandidates(for space: GroupSpaceSummary) async -> [CommonGroundGroupCandidate]? {
        guard isCommonGroundAvailable, !isPreviewMode, let context = try? digestContext() else { return nil }
        let (api, token, _) = context
        return try? await api.commonGroundGroupCandidates(token: token, groupSpaceId: space.preferenceId)
    }

    /// Invites people from Grounding to a group. Returns an error message on failure.
    func inviteGroundingPeople(_ accountIds: [String], to space: GroupSpaceSummary) async -> String? {
        guard !accountIds.isEmpty else { return nil }
        if isPreviewMode { return nil }
        guard let context = try? digestContext() else { return "Could not invite people to this group." }
        let (api, token, _) = context
        do {
            var problems: [String] = []
            // The server takes up to 20 people per request.
            for start in stride(from: 0, to: accountIds.count, by: 20) {
                let batch = Array(accountIds[start..<min(start + 20, accountIds.count)])
                let result = try await api.inviteToCommonGroundGroup(token: token, groupSpaceId: space.preferenceId, accountIds: batch)
                if let problem = result.problem { problems.append(problem) }
            }
            return problems.first
        } catch {
            return CommonGroundModel.message(for: error) ?? "Could not invite people to this group."
        }
    }
}
