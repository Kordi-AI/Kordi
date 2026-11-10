import Foundation

/// The owner's profile: edits from the profile screen and what this iPhone
/// reports for the automatic Location and Time zone (#2439).
extension CloudAPIClient {
    func updateProfile(
        token: String,
        displayName: String,
        avatarMutation: CanonicalAvatarMutation?,
        kordiId: String? = nil,
        details: CloudProfileDetailsUpdate = CloudProfileDetailsUpdate()
    ) async throws -> CloudAccount {
        let avatarMutation = try await referenceBackedAvatarMutation(
            token: token,
            entityType: "human",
            entityId: try requireActiveAccountId(),
            mutation: avatarMutation
        )
        return try await send(
            path: "/v1/cloud/auth/me",
            method: "PATCH",
            token: token,
            body: UpdateProfileRequest(
                displayName: displayName,
                avatarMutation: avatarMutation,
                kordiId: kordiId,
                about: details.about,
                location: details.location,
                timeZone: details.timeZone,
                website: details.website,
                birthday: details.birthday,
                locationMode: details.locationMode,
                timeZoneMode: details.timeZoneMode
            ),
            fallback: "Could not update your profile."
        )
    }

    /// Reports what this iPhone observed. The server writes a field only while
    /// it is automatic, so a value the owner set by hand stays. City names
    /// only; coordinates never leave the device.
    func updateDeviceProfile(token: String, timeZone: String?, location: String?) async throws -> CloudAccount {
        try await send(
            path: "/v1/cloud/auth/me/device-profile",
            method: "POST",
            token: token,
            body: DeviceProfileRequest(timeZone: timeZone, location: location),
            fallback: "Could not update your profile."
        )
    }
}

private struct UpdateProfileRequest: Encodable {
    let displayName: String
    let avatarMutation: CanonicalAvatarMutation?
    let kordiId: String?
    let about: String?
    let location: String?
    let timeZone: String?
    let website: String?
    let birthday: String?
    let locationMode: String?
    let timeZoneMode: String?
}

private struct DeviceProfileRequest: Encodable {
    let timeZone: String?
    let location: String?
}
