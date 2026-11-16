import SwiftUI

/// A gallery item pushed from the room: type tile and title, the sharer with
/// their contact control (or More for my own item), the artifact read-only,
/// then the comments, with "Add a comment" pinned at the bottom. Open hands
/// the file to Quick Look. A closed room shows no comment field. An item
/// that goes away (removed, or its sharer left) closes the screen.
struct CommonGroundGalleryItemScreen: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let code: String
    let itemId: String
    @State private var content = CommonGroundGalleryContentPhase.loading
    @State private var previewURL: URL?
    @State private var opening = false

    private static let commentsEnd = "gallery-comments-end"

    private var item: CommonGroundGalleryItem? { model.galleryItem(code: code, itemId: itemId) }
    private var comments: [CommonGroundGalleryComment]? {
        model.gallery.items[CommonGroundModel.galleryKey(code, itemId)]?.comments
    }
    private var closed: Bool { model.isClosed(code) }

    var body: some View {
        ScrollViewReader { proxy in
            CommonGroundPage {
                if let item {
                    detail(item)
                } else {
                    ProgressView("Loading")
                        .frame(maxWidth: .infinity, minHeight: 240)
                }
                Color.clear.frame(height: 1).id(Self.commentsEnd)
            }
            .safeAreaInset(edge: .bottom) {
                if item != nil, !closed {
                    CommonGroundGalleryCommentField(code: code, itemId: itemId)
                }
            }
            .onChange(of: comments?.last?.commentId) { _, id in
                // Scrolls to a comment I just sent, not to ones that arrive from others.
                guard id?.hasPrefix(CommonGroundGalleryComment.pendingPrefix) == true else { return }
                withAnimation(.snappy) { proxy.scrollTo(Self.commentsEnd, anchor: .bottom) }
            }
        }
        .overlay(alignment: .topTrailing) { openButton }
        .quickLookPreview($previewURL)
        .task(id: itemId) { await load() }
        .onDisappear { model.closeGalleryItem(code: code, itemId: itemId) }
        .onChange(of: item == nil) { wasMissing, missing in
            if missing, !wasMissing { dismiss() }
        }
    }

    @ViewBuilder private func detail(_ item: CommonGroundGalleryItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.title)
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            author(item)
        }
        .padding(.horizontal, 16)
        VStack(spacing: 16) {
            CommonGroundGalleryItemBody(item: item, phase: content, opening: opening, open: open)
            CommonGroundGalleryCommentList(code: code, item: item, comments: comments ?? [])
        }
        .padding(.horizontal, 16)
    }

    /// The sharer as a plain line under the title: a small avatar, the name, then the topic.
    private func author(_ item: CommonGroundGalleryItem) -> some View {
        HStack(spacing: 8) {
            CommonGroundAvatar(person: item.person, size: 22)
            Text(item.author(full: true))
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            if let topic = item.topic {
                Text("· \(topic)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if item.mine {
                CommonGroundGalleryMoreMenu(
                    title: "Remove from gallery",
                    disabled: model.busy == CommonGroundModel.galleryRemoveBusyKey(item.itemId)
                ) {
                    Task { _ = await model.removeFromGallery(code: code, itemId: item.itemId) }
                }
            } else {
                CommonGroundGalleryContactButton(item: item)
            }
        }
        .frame(minHeight: 34)
    }

    private var openButton: some View {
        Button(action: open) {
            Group {
                if opening {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.primary)
                }
            }
            .frame(width: 44, height: 44)
            .sessionGlass(in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(item == nil || opening)
        .padding(.trailing, 16)
        .safeAreaPadding(.top, 8)
        .accessibilityLabel("Open")
    }

    /// Opens the screen: loads the item and comments, then the file. An item
    /// that never showed and is gone closes here; one that showed closes
    /// through `onChange` once the model drops it.
    private func load() async {
        model.openGalleryItem(code: code, itemId: itemId)
        let wasShown = item != nil
        guard await model.loadGalleryItem(code: code, itemId: itemId) else {
            if !wasShown { dismiss() }
            return
        }
        guard !Task.isCancelled, let item, !content.isReady else { return }
        let kind = item.kind.forViewing(sizeBytes: item.sizeBytes)
        guard kind.isText || kind == .image else {
            content = .file
            return
        }
        content = .loading
        do {
            let loaded = try await model.galleryContent(code: code, itemId: itemId)
            content = .make(kind: kind, content: loaded)
        } catch {
            if !CloudTransportErrorPolicy.isCancellation(error) { content = .failed }
        }
    }

    /// Hands the downloaded file to Quick Look, which also offers sharing.
    private func open() {
        guard let item, !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            do {
                let loaded = try await model.galleryContent(code: code, itemId: itemId)
                previewURL = try CommonGroundGalleryFiles.write(loaded, item: item)
            } catch {
                if !CloudTransportErrorPolicy.isCancellation(error) { model.notice = "Can't open this file." }
            }
        }
    }
}
