import SwiftUI

/// A pending invitation to a group started in a Grounding room, answered
/// from Contacts › Requests.
struct ContactsRoomInvitationRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject private var model: AppModel
    let invitation: RoomGroupInvitation
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil
    /// Opens the room's results in Grounding.
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
                .accessibilityLabel("Open \(invitation.groupTitle)")
                .accessibilityValue("\(invitation.from.displayName) invited you")
        } else {
            labelContent
        }
    }

    private var labelContent: some View {
        HStack(spacing: 12) {
            IdentityAvatar(
                name: invitation.from.displayName,
                imageSource: invitation.from.avatarUrl.nonEmpty,
                kind: .person,
                size: 44,
                seed: invitation.from.accountId,
                cornerRadius: 22
            )
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(invitation.from.displayName) invited you")
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(invitation.groupTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        }
        .contentShape(Rectangle())
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button(action: decline) {
                capsule("Decline", isWorking: working == .decline, foreground: .secondary,
                        background: AnyShapeStyle(Color(uiColor: .tertiarySystemFill)), tint: .secondary)
            }
            .buttonStyle(.plain)

            Button(action: join) {
                capsule("Join", isWorking: working == .join, foreground: AnyShapeStyle(chatTheme.accentForeground),
                        background: AnyShapeStyle(chatTheme.accent), tint: chatTheme.accentForeground)
            }
            .buttonStyle(.plain)
        }
        .disabled(working != nil)
        .opacity(working != nil ? 0.6 : 1)
    }

    private func capsule(_ title: String, isWorking: Bool, foreground: some ShapeStyle, background: AnyShapeStyle, tint: Color) -> some View {
        ZStack {
            Text(title).opacity(isWorking ? 0 : 1)
            if isWorking {
                ProgressView().controlSize(.small).tint(tint)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(foreground)
        .padding(.horizontal, 14)
        .frame(minHeight: 30)
        .background(background, in: Capsule())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(title)
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
