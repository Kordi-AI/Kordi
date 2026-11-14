import Foundation

/// A pending invitation to a group started in a Grounding room, listed
/// outside the room so it can be answered from Contacts.
struct RoomGroupInvitation: Decodable, Hashable, Identifiable {
    let invitationRef: String
    /// The room's code.
    let code: String
    let roomName: String
    let groupSpaceId: String
    let conversationId: String?
    /// The group's name.
    let name: String
    let from: CommonGroundPerson
    let createdAt: String?

    var id: String { invitationRef }

    /// The group's name, or a neutral fallback when the server sends none.
    var groupName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "a group"
    }

    private enum CodingKeys: String, CodingKey {
        case invitationRef, code, roomName, groupSpaceId, conversationId, name, from, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invitationRef = try c.decode(String.self, forKey: .invitationRef)
        code = try c.decode(String.self, forKey: .code)
        groupSpaceId = try c.decode(String.self, forKey: .groupSpaceId)
        from = try c.decode(CommonGroundPerson.self, forKey: .from)
        guard !invitationRef.isEmpty, !code.isEmpty, !groupSpaceId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .invitationRef, in: c, debugDescription: "Missing identifiers")
        }
        roomName = ((try? c.decodeIfPresent(String.self, forKey: .roomName)) ?? nil) ?? ""
        conversationId = ((try? c.decodeIfPresent(String.self, forKey: .conversationId)) ?? nil)?.nonEmpty
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil
    }
}

/// `{ "invitations": [...] }`; malformed entries are skipped.
private struct RoomGroupInvitationList: Decodable {
    let invitations: [RoomGroupInvitation]

    private enum CodingKeys: String, CodingKey { case invitations }
    private struct Skipped: Decodable {}

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
        invitations = decoded
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

    /// A `common_ground.room.updated` hint: one refetch after a short pause,
    /// whether or not Grounding is on screen.
    func scheduleRoomGroupInvitationRefresh(for hint: CommonGroundSyncHint) {
        guard case .room = hint else { return }
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
            let joined = try await api.joinCommonGroundInvitation(token: token, code: invitation.code, invitationRef: invitation.invitationRef)
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
            try await api.declineRoomGroupInvitation(token: token, code: invitation.code, invitationRef: invitation.invitationRef)
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
        NotificationCenter.default.post(name: .kordiCommonGroundHint, object: CommonGroundSyncHint.room(code: invitation.code))
    }
}

struct RoomGroupInvitationError: Error, Identifiable {
    let id = UUID()
    let message: String
}
