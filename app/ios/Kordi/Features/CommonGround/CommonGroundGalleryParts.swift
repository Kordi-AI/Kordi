import SwiftUI

extension CommonGroundGalleryItem {
    /// Put in the chat composer when Message is used from an item.
    var messageDraft: String { "About \"\(title)\": " }
}

/// The coloured type tile (MD, HTML, TS, CSV, PDF, PNG) for a file: a small
/// chip over a thumbnail, a row tile, or the item screen's header tile.
struct CommonGroundGalleryTypeTile: View {
    enum Size { case chip, row, large }

    let kind: CommonGroundGalleryKind
    let label: String
    var size: Size = .row

    init(fileName: String, contentType: String?, size: Size = .row) {
        kind = .of(fileName: fileName, contentType: contentType)
        label = kind.typeLabel(fileName: fileName)
        self.size = size
    }

    private var side: CGFloat {
        switch size {
        case .chip: 16
        case .row: 34
        case .large: 40
        }
    }

    private var fontSize: CGFloat {
        switch size {
        case .chip: 8.5
        case .row: 9.5
        case .large: 11
        }
    }

    private var radius: CGFloat {
        switch size {
        case .chip: 5
        case .row: 8
        case .large: 10
        }
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        Text(label)
            .font(.system(size: fontSize, weight: .bold))
            .foregroundStyle(kind.tint)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, size == .chip ? 5 : 3)
            .frame(width: size == .chip ? nil : side, height: side)
            .background {
                ZStack {
                    if size == .chip { shape.fill(Color(uiColor: .secondarySystemGroupedBackground)) }
                    shape.fill(kind.tint.opacity(0.14))
                }
            }
            .accessibilityHidden(true)
    }
}

/// The ellipsis on my own cards, the item header and comment rows: one
/// destructive action.
struct CommonGroundGalleryMoreMenu: View {
    let title: String
    var floating = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Menu {
            Button(title, role: .destructive, action: action)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: floating ? 13 : 16, weight: .semibold))
                .foregroundStyle(floating ? Color.primary : Color.secondary)
                .frame(width: floating ? 26 : 32, height: floating ? 26 : 32)
                .background {
                    if floating {
                        Circle().fill(.regularMaterial).shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(disabled)
        .accessibilityLabel("More")
    }
}

/// The sharer's contact control on an item, from the same relationship rules
/// and model calls as a person's page: Message for a contact (the chat opens
/// with "About …" in the composer), Add, then Requested, or Accept.
struct CommonGroundGalleryContactButton: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.commonGroundOpenConversation) private var openConversation
    let item: CommonGroundGalleryItem
    @State private var working = false

    private var relationship: CommonGroundRelationship? { model.galleryRelationship(for: item.person) }

    var body: some View {
        let state = CommonGroundPersonActionAvailability(relationship: relationship, busy: model.busy != nil || working)
        Group {
            switch state.contactAction {
            case .hidden:
                EmptyView()
            case .requested:
                Button(state.contactAction.title) {}
                    .buttonStyle(.bordered)
                    .tint(Color.primary)
                    .disabled(true)
            case .message:
                Button(state.contactAction.title) { Task { await perform(.message) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!state.communicationEnabled)
            case .add, .accept:
                Button(state.contactAction.title) { Task { await perform(state.contactAction) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!state.contactActionEnabled)
            }
        }
        .controlSize(.small)
        .buttonBorderShape(.capsule)
    }

    private func perform(_ action: CommonGroundContactAction) async {
        let id = item.person.accountId
        working = true
        defer { working = false }
        switch action {
        case .add:
            await model.addContact(id)
        case .accept:
            if let requestId = relationship?.requestId, await appModel.acceptCommonGroundRequest(requestId: requestId) {
                model.markContact(id)
            } else {
                await model.addContact(id)
            }
        case .message:
            guard relationship?.contact == true, let response = await model.openChat(id) else { return }
            guard let conversation = await appModel.commonGroundConversation(
                peerAccountId: id, conversationId: response.conversationId, sessionId: response.sessionId
            ) else {
                model.notice = "Could not open the chat."
                return
            }
            ConversationDraftPrefill.set(item.messageDraft, for: conversation.id)
            openConversation(conversation)
        case .requested, .hidden:
            break
        }
    }
}
