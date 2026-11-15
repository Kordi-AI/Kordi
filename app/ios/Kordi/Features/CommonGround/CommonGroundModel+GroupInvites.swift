import Foundation

/// Inviting a person from their Grounding page into a group the viewer
/// manages. The sheet keeps the list; failures come back as one line for it
/// to show, since the model's toast sits under the sheet.
extension CommonGroundModel {
    static let groupInviteBusyKey = "group-invite"

    /// The groups a person can be invited to. A person who cannot be invited,
    /// or a server without the route, reads as no groups.
    func inviteGroups(for accountId: String) async -> Result<CommonGroundInviteGroups, CommonGroundGroupInviteError> {
        do {
            return .success(try await call { try await $0.commonGroundInviteGroups(token: $1, accountId: accountId) })
        } catch let error as CloudAPIError where error.statusCode == 404 {
            return .success(CommonGroundInviteGroups(contact: false, groups: []))
        } catch {
            return .failure(CommonGroundGroupInviteError(message: Self.message(for: error) ?? "Could not load your groups."))
        }
    }

    /// Invites the person to one group, or adds them when they are a contact.
    /// Returns nil on success, else a line to show.
    func invite(_ accountId: String, toGroup groupSpaceId: String) async -> CommonGroundGroupInviteError? {
        busy = Self.groupInviteBusyKey
        defer { if busy == Self.groupInviteBusyKey { busy = nil } }
        do {
            let result = try await call {
                try await $0.inviteToCommonGroundGroup(token: $1, groupSpaceId: groupSpaceId, accountIds: [accountId])
            }
            guard result.problem != nil else { return nil }
            return CommonGroundGroupInviteError(
                message: result.limitReached ? CommonGroundGroupInviteResult.limitMessage : "Could not invite them to this group."
            )
        } catch {
            return CommonGroundGroupInviteError(message: Self.message(for: error) ?? "Could not invite them.")
        }
    }
}

struct CommonGroundGroupInviteError: Error, Identifiable, Equatable {
    let id = UUID()
    let message: String
}
