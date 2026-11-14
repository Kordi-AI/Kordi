import Foundation

/// A pending invitation to a group, listed outside Grounding so it can be
/// answered from Contacts: either sent to a room's members when its group
/// started, or sent to one person by a group admin they share Grounding with.
struct RoomGroupInvitation: Decodable, Hashable, Identifiable {
    enum Kind: String, Hashable {
        /// Sent to everyone in a room; answered through the room.
        case room
        /// Sent to one person; answered through `group-invitations`.
        case group
    }

    let kind: Kind
    let invitationRef: String
    /// The room's code; nil for a person invitation.
    let code: String?
    /// The room the invitation came from; empty when there is none.
    let roomName: String
    let groupSpaceId: String
    let conversationId: String?
    /// The group's name.
    let name: String
    let from: CommonGroundPerson
    let createdAt: String?
    /// Up to eight members, the group's creator first.
    let members: [CommonGroundPerson]
    /// Everyone in the group, which can be more than `members`.
    let memberCount: Int

    var id: String { invitationRef }

    /// The group's name, or a neutral fallback when the server sends none.
    var groupName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "a group"
    }

    /// The group's name as a title, with a neutral fallback.
    var groupTitle: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Group"
    }

    private enum CodingKeys: String, CodingKey {
        case kind, invitationRef, code, roomName, groupSpaceId, conversationId, name, from, createdAt, members, memberCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Servers before person invitations send no kind: those are room invitations.
        let rawKind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? Kind.room.rawValue
        guard let kind = Kind(rawValue: rawKind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown invitation kind")
        }
        self.kind = kind
        invitationRef = try c.decode(String.self, forKey: .invitationRef)
        code = ((try? c.decodeIfPresent(String.self, forKey: .code)) ?? nil)?.nonEmpty
        groupSpaceId = try c.decode(String.self, forKey: .groupSpaceId)
        from = try c.decode(CommonGroundPerson.self, forKey: .from)
        guard !invitationRef.isEmpty, !groupSpaceId.isEmpty, kind == .group || code != nil else {
            throw DecodingError.dataCorruptedError(forKey: .invitationRef, in: c, debugDescription: "Missing identifiers")
        }
        roomName = ((try? c.decodeIfPresent(String.self, forKey: .roomName)) ?? nil) ?? ""
        conversationId = ((try? c.decodeIfPresent(String.self, forKey: .conversationId)) ?? nil)?.nonEmpty
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil
        members = Self.decodeMembers(c)
        memberCount = max(((try? c.decodeIfPresent(Int.self, forKey: .memberCount)) ?? nil) ?? 0, 0)
    }

    /// Lenient: a missing or malformed list is empty, and bad entries are skipped.
    private static func decodeMembers(_ c: KeyedDecodingContainer<CodingKeys>) -> [CommonGroundPerson] {
        guard var items = try? c.nestedUnkeyedContainer(forKey: .members) else { return [] }
        var decoded: [CommonGroundPerson] = []
        while !items.isAtEnd {
            if let person = try? items.decode(CommonGroundPerson.self) {
                if !decoded.contains(where: { $0.accountId == person.accountId }) { decoded.append(person) }
            } else if (try? items.decode(RoomGroupInvitationList.Skipped.self)) == nil {
                break
            }
        }
        return decoded
    }
}

/// `{ "invitations": [...] }`; malformed entries are skipped.
private struct RoomGroupInvitationList: Decodable {
    let invitations: [RoomGroupInvitation]

    private enum CodingKeys: String, CodingKey { case invitations }
    struct Skipped: Decodable {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard var items = try? c.nestedUnkeyedContainer(forKey: .invitations) else {
            invitations = []
            return
        }
        var decoded: [RoomGroupInvitation] = []
        while !items.isAtEnd {
            if let invitation = try? items.decode(RoomGroupInvitation.self) {
                decoded.append(invitation)
            } else if (try? items.decode(Skipped.self)) == nil {
                break
            }
        }
        invitations = RoomGroupInvitation.deduplicated(decoded)
    }
}

extension RoomGroupInvitation {
    /// One row per group: a room invitation wins over a person invitation
    /// to the same group, and repeated refs are dropped.
    static func deduplicated(_ invitations: [RoomGroupInvitation]) -> [RoomGroupInvitation] {
        let roomGroups = Set(invitations.filter { $0.kind == .room }.map(\.groupSpaceId))
        var seenRefs = Set<String>()
        var seenPersonGroups = Set<String>()
        return invitations.filter { invitation in
            guard seenRefs.insert(invitation.invitationRef).inserted else { return false }
            guard invitation.kind == .group else { return true }
            return !roomGroups.contains(invitation.groupSpaceId) && seenPersonGroups.insert(invitation.groupSpaceId).inserted
        }
    }

    /// The detail's second line: who invited you, and from which room.
    var fromLine: String {
        let room = roomName.trimmingCharacters(in: .whitespacesAndNewlines)
        if let room = room.nonEmpty { return "\(from.displayName) · from \(room)" }
        return kind == .group ? "\(from.displayName) · from Grounding" : from.displayName
    }
}

extension CloudAPIClient {
    private static let roomInvitationSegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private func roomInvitationPath(code: String, invitationRef: String, action: String) -> String {
        let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: Self.roomInvitationSegment) ?? value }
        return "/v1/cloud/common-ground/rooms/\(encode(code))/invitations/\(encode(invitationRef))/\(action)"
    }

    /// `GET /v1/cloud/common-ground/invitations`. Servers without the route
    /// answer 404, which reads as no invitations.
    func listRoomGroupInvitations(token: String) async throws -> [RoomGroupInvitation] {
        do {
            let list: RoomGroupInvitationList = try await send(
                path: "/v1/cloud/common-ground/invitations", method: "GET", token: token,
                fallback: "Could not load group invitations."
            )
            return list.invitations
        } catch let error as CloudAPIError where error.statusCode == 404 {
            return []
        }
    }

    /// `POST .../rooms/:code/invitations/:ref/decline`. A 404 means the
    /// invitation is already gone, which counts as declined.
    func declineRoomGroupInvitation(token: String, code: String, invitationRef: String) async throws {
        do {
            try await sendWithoutResponse(
                path: roomInvitationPath(code: code, invitationRef: invitationRef, action: "decline"), method: "POST", token: token,
                fallback: "Could not decline the invitation."
            )
        } catch let error as CloudAPIError where error.statusCode == 404 {
            return
        }
    }

    /// Joins through the route that matches the invitation's kind.
    func joinRoomGroupInvitation(token: String, invitation: RoomGroupInvitation) async throws -> CommonGroundJoinedGroup {
        if invitation.kind == .room, let code = invitation.code {
            return try await joinCommonGroundInvitation(token: token, code: code, invitationRef: invitation.invitationRef)
        }
        return try await joinCommonGroundGroupInvitation(token: token, invitationRef: invitation.invitationRef)
    }

    /// Declines through the route that matches the invitation's kind. A 404
    /// means the invitation is already gone, which counts as declined.
    func declineRoomGroupInvitation(token: String, invitation: RoomGroupInvitation) async throws {
        if invitation.kind == .room, let code = invitation.code {
            try await declineRoomGroupInvitation(token: token, code: code, invitationRef: invitation.invitationRef)
            return
        }
        do {
            try await declineCommonGroundGroupInvitation(token: token, invitationRef: invitation.invitationRef)
        } catch let error as CloudAPIError where error.statusCode == 404 {
            return
        }
    }
}

extension AppModel {
    /// How long a burst of Grounding room hints waits before one refetch.
    private static let roomInvitationHintDelay: Duration = .milliseconds(800)

    /// Reloads pending room-group invitations. Quiet on failure; an
    /// unsupported server reads as none.
    func refreshRoomGroupInvitations() async {
        guard !isPreviewMode, isCommonGroundAvailable, let context = try? digestContext() else { return }
        let (api, token, accountId) = context
        guard let fetched = try? await api.listRoomGroupInvitations(token: token) else { return }
        applyRoomGroupInvitations(fetched, accountId: accountId)
    }

    /// Applies a fetched list unless the account changed meanwhile, without
    /// bringing back invitations answered on this device.
    func applyRoomGroupInvitations(_ fetched: [RoomGroupInvitation], accountId: String) {
        guard account?.accountId == accountId else { return }
        let next = fetched.filter { !answeredRoomInvitationRefs.contains($0.invitationRef) }
        if roomGroupInvitations != next { roomGroupInvitations = next }
    }

    /// A `common_ground.room.updated` or `common_ground.invitations.updated`
    /// hint: one refetch after a short pause, whether or not Grounding is on
    /// screen.
    func scheduleRoomGroupInvitationRefresh(for hint: CommonGroundSyncHint) {
        switch hint {
        case .room, .invitations: break
        case .matches: return
        }
        roomInvitationRefreshTask?.cancel()
        roomInvitationRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: Self.roomInvitationHintDelay)
            guard !Task.isCancelled else { return }
            await self?.refreshRoomGroupInvitations()
        }
    }

    /// Joins the group. Returns the joined group, or an error message.
    func joinRoomGroupInvitation(_ invitation: RoomGroupInvitation) async -> Result<CommonGroundJoinedGroup, RoomGroupInvitationError> {
        if isPreviewMode {
            forgetRoomGroupInvitation(invitation)
            return .success(CommonGroundJoinedGroup(status: "joined", groupSpaceId: invitation.groupSpaceId,
                                                    conversationId: invitation.conversationId, name: invitation.name))
        }
        guard let context = try? digestContext() else { return .failure(RoomGroupInvitationError(message: "Could not join the group.")) }
        let (api, token, _) = context
        do {
            let joined = try await api.joinRoomGroupInvitation(token: token, invitation: invitation)
            forgetRoomGroupInvitation(invitation)
            await refreshRoomGroupInvitations()
            return .success(joined)
        } catch {
            return .failure(RoomGroupInvitationError(message: userFacing(error, fallback: "Could not join the group.")))
        }
    }

    /// Declines the invitation. Returns an error message on failure.
    func declineRoomGroupInvitation(_ invitation: RoomGroupInvitation) async -> RoomGroupInvitationError? {
        if isPreviewMode {
            forgetRoomGroupInvitation(invitation)
            return nil
        }
        guard let context = try? digestContext() else { return RoomGroupInvitationError(message: "Could not decline the invitation.") }
        let (api, token, _) = context
        do {
            try await api.declineRoomGroupInvitation(token: token, invitation: invitation)
            forgetRoomGroupInvitation(invitation)
            await refreshRoomGroupInvitations()
            return nil
        } catch {
            return RoomGroupInvitationError(message: userFacing(error, fallback: "Could not decline the invitation."))
        }
    }

    /// Removes an answered invitation now and tells an open room screen to
    /// reload, so its Invitations section drops it too.
    private func forgetRoomGroupInvitation(_ invitation: RoomGroupInvitation) {
        answeredRoomInvitationRefs.insert(invitation.invitationRef)
        roomGroupInvitations.removeAll { $0.invitationRef == invitation.invitationRef }
        guard let code = invitation.code else { return }
        NotificationCenter.default.post(name: .kordiCommonGroundHint, object: CommonGroundSyncHint.room(code: code))
    }
}

struct RoomGroupInvitationError: Error, Identifiable {
    let id = UUID()
    let message: String
}
