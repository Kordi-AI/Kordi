import SwiftUI

/// An item's comments, oldest first. My own comments, and every comment on
/// my item, have Delete on a long press.
struct CommonGroundGalleryCommentList: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let item: CommonGroundGalleryItem
    let comments: [CommonGroundGalleryComment]

    var body: some View {
        if !comments.isEmpty {
            CommonGroundSection(title: "Comments") {
                ForEach(Array(comments.enumerated()), id: \.element.id) { index, comment in
                    if index > 0 { SessionDetailSeparator(leading: 14 + 26 + 10) }
                    let deletable = (comment.mine || item.mine) && !comment.isPending
                    if deletable {
                        CommonGroundGalleryCommentRow(comment: comment)
                            .contextMenu {
                                Button("Delete", role: .destructive) {
                                    Task { _ = await model.deleteGalleryComment(code: code, itemId: item.itemId, commentId: comment.commentId) }
                                }
                            }
                    } else {
                        CommonGroundGalleryCommentRow(comment: comment)
                    }
                }
            }
        }
    }
}

/// One comment: avatar, name ("You" for mine), how long ago, and the text.
struct CommonGroundGalleryCommentRow: View {
    let comment: CommonGroundGalleryComment

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            CommonGroundAvatar(person: comment.person, size: 26)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(comment.author())
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        Text(ConnectorAuditTime.label(comment.createdAt, now: context.date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Text(comment.body)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .opacity(comment.isPending ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

/// "Add a comment" with a send button, pinned above the keyboard. The field
/// clears at once and refills when sending fails.
struct CommonGroundGalleryCommentField: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let itemId: String
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var busy: Bool { model.busy == CommonGroundModel.galleryCommentBusyKey(itemId) }
    private var canSend: Bool { draft.nonEmpty != nil && !busy }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Add a comment", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(focused ? 0.28 : 0.12), lineWidth: 0.5))
                .onChange(of: draft) { _, value in
                    if value.count > CommonGroundModel.galleryCommentMax {
                        draft = String(value.prefix(CommonGroundModel.galleryCommentMax))
                    }
                }
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(chatTheme.accentForeground)
                    .frame(width: 32, height: 32)
                    .background(chatTheme.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .opacity(canSend ? 1 : 0.35)
            .disabled(!canSend)
            .padding(.bottom, 2)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private func send() {
        guard let body = draft.nonEmpty, !busy else { return }
        draft = ""
        Task {
            let sent = await model.addGalleryComment(code: code, itemId: itemId, body: body)
            if !sent, draft.isEmpty { draft = body }
        }
    }
}
