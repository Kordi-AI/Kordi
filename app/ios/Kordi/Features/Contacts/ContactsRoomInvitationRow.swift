import SwiftUI

/// A pending invitation to a group started in a Grounding room, answered
/// from Contacts › Requests.
struct ContactsRoomInvitationRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject private var model: AppModel
    let invitation: RoomGroupInvitation
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil
    /// Opens the invitation's detail screen.
    var onOpen: (() -> Void)? = nil
    @State private var working: Action?
    @State private var failure: RoomGroupInvitationError?

    private enum Action { case join, decline }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .trailing, spacing: 10) {
                    label
                    actions
                }
            } else {
                HStack(spacing: 12) {
                    label
                    actions
                }
            }
        }
        .frame(minHeight: 44)
        .alert("Could not answer", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }), presenting: failure) { _ in
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
    }

    @ViewBuilder private var label: some View {
        if let onOpen {
            Button(action: onOpen) { labelContent }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(invitation.from.displayName), invited you to \(invitation.groupName)")
                .accessibilityAddTraits(.isButton)
        } else {
            labelContent
        }
    }

    private var labelContent: some View {
        ContactsRowLayout(title: invitation.from.displayName, subtitle: "Invited you to \(invitation.groupName)") {
            IdentityAvatar(
                name: invitation.from.displayName,
                imageSource: invitation.from.avatarUrl.nonEmpty,
                kind: .person,
                size: 44,
                seed: invitation.from.accountId,
                cornerRadius: 22
            )
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button(action: decline) {
                iconButton("xmark", isWorking: working == .decline, foreground: Color.primary,
                           background: Color(uiColor: .tertiarySystemFill))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Decline")
            .help("Decline")

            Button(action: join) {
                iconButton("checkmark", isWorking: working == .join, foreground: chatTheme.accentForeground,
                           background: chatTheme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Join")
            .help("Join")
        }
        .disabled(working != nil)
        .opacity(working != nil ? 0.6 : 1)
    }

    private func iconButton(_ systemName: String, isWorking: Bool, foreground: Color, background: Color) -> some View {
        ZStack {
            Image(systemName: systemName)
                .font(.footnote.weight(.bold))
                .opacity(isWorking ? 0 : 1)
            if isWorking {
                ProgressView().controlSize(.small).tint(foreground)
            }
        }
        .foregroundStyle(foreground)
        .frame(width: 30, height: 30)
        .background(background, in: Circle())
        .frame(width: 36, height: 44)
        .contentShape(Rectangle())
    }

    private func join() {
        working = .join
        Task {
            switch await model.joinRoomGroupInvitation(invitation) {
            case .success(let joined):
                if let onOpenConversation,
                   let conversation = await model.commonGroundGroupConversation(groupSpaceId: joined.groupSpaceId, conversationId: joined.conversationId) {
                    onOpenConversation(conversation)
                }
            case .failure(let error):
                failure = error
            }
            working = nil
        }
    }

    private func decline() {
        working = .decline
        Task {
            failure = await model.declineRoomGroupInvitation(invitation)
            working = nil
        }
    }
}
