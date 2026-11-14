import SwiftUI

/// A room group invitation opened from Contacts › Requests: the group, who
/// invited you and from which room, its members, and Decline or Join.
struct ContactsRoomInvitationDetailView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    let invitation: RoomGroupInvitation
    @State private var working: Action?
    @State private var answer: Action?
    @State private var failure: RoomGroupInvitationError?

    private enum Action { case join, decline }

    private var line: String {
        let room = invitation.roomName.trimmingCharacters(in: .whitespacesAndNewlines)
        return room.isEmpty ? invitation.from.displayName : "\(invitation.from.displayName) · from \(room)"
    }

    /// The collage keeps the server's order, creator first.
    private var participants: [CloudGroupParticipant] {
        invitation.members.enumerated().map { index, person in
            CloudGroupParticipant(accountId: person.accountId, displayName: person.displayName,
                                  avatarUrl: person.avatarUrl, role: nil, joinedAt: String(format: "%04d", index))
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                GroupAvatarStack(participants: participants, size: 84)
                Text(invitation.groupTitle)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.top, 12)
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
                answerArea
                    .padding(.top, 18)
                if !invitation.members.isEmpty {
                    membersSection
                        .padding(.top, 22)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Could not answer", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }), presenting: failure) { _ in
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
    }

    @ViewBuilder private var answerArea: some View {
        switch answer {
        case .join:
            Text("You joined \(invitation.groupTitle).")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        case .decline:
            Text("Declined")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case nil:
            HStack(spacing: 10) {
                Button(action: decline) {
                    tile("Decline", isWorking: working == .decline, foreground: Color.primary,
                         background: Color(uiColor: .secondarySystemGroupedBackground))
                }
                .buttonStyle(.plain)

                Button(action: join) {
                    tile("Join", isWorking: working == .join, foreground: chatTheme.accentForeground,
                         background: chatTheme.accent)
                }
                .buttonStyle(.plain)
            }
            .disabled(working != nil)
            .opacity(working != nil ? 0.6 : 1)
        }
    }

    private func tile(_ title: String, isWorking: Bool, foreground: Color, background: Color) -> some View {
        ZStack {
            Text(title).opacity(isWorking ? 0 : 1)
            if isWorking {
                ProgressView().controlSize(.small).tint(foreground)
            }
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(foreground)
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel(title)
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Members")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(invitation.members.enumerated()), id: \.element.id) { index, person in
                    if index > 0 {
                        Divider().padding(.leading, 56)
                    }
                    HStack(spacing: 12) {
                        IdentityAvatar(
                            name: person.displayName,
                            imageSource: person.avatarUrl.nonEmpty,
                            kind: .person,
                            size: 32,
                            seed: person.accountId,
                            cornerRadius: 16
                        )
                        Text(person.displayName)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func join() {
        working = .join
        Task {
            switch await model.joinRoomGroupInvitation(invitation) {
            case .success:
                answer = .join
            case .failure(let error):
                failure = error
            }
            working = nil
        }
    }

    private func decline() {
        working = .decline
        Task {
            if let error = await model.declineRoomGroupInvitation(invitation) {
                failure = error
            } else {
                answer = .decline
            }
            working = nil
        }
    }
}
