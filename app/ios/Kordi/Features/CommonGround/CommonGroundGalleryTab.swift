import SwiftUI

/// The room's Gallery tab: topic chips (All and the room topics that have
/// items) with Share at the trailing edge, then a two-column grid of cards.
/// A closed room keeps everything readable and leaves out Share.
struct CommonGroundGalleryTab: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let roomTitle: String
    let roomTopics: [String]
    let closed: Bool
    @Binding var path: [CommonGroundRoute]
    @State private var filter: String?
    @State private var sharing = false

    private var list: CommonGroundGalleryList? { model.gallery.lists[code] }
    private var canShare: Bool { !closed && list?.canShare == true }

    /// Room topics that have at least one item, in the room's order.
    static func chips(roomTopics: [String], items: [CommonGroundGalleryItem]) -> [String] {
        let used = Set(items.compactMap(\.topic))
        return roomTopics.filter { used.contains($0) }
    }

    var body: some View {
        Group {
            if let list {
                if list.items.isEmpty {
                    VStack(spacing: 12) {
                        Text("Nothing shared yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if canShare { shareButton }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 30)
                } else {
                    grid(list.items)
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .sheet(isPresented: $sharing) {
            CommonGroundGalleryShareSheet(code: code, roomTitle: roomTitle, topics: roomTopics) { filter = nil }
                .environmentObject(model)
        }
    }

    private func grid(_ items: [CommonGroundGalleryItem]) -> some View {
        let chips = Self.chips(roomTopics: roomTopics, items: items)
        let active = filter.flatMap { chips.contains($0) ? $0 : nil }
        let shown = active.map { topic in items.filter { $0.topic == topic } } ?? items
        let columns = Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 2)
        return VStack(spacing: 12) {
            if !chips.isEmpty || canShare {
                HStack(spacing: 8) {
                    if chips.isEmpty {
                        Spacer(minLength: 0)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                chip("All", selected: active == nil) { filter = nil }
                                ForEach(chips, id: \.self) { topic in
                                    chip(topic, dot: commonGroundStyle(for: topic).color, selected: active == topic) { filter = topic }
                                }
                            }
                            .padding(.vertical, 1)
                        }
                    }
                    if canShare { shareButton }
                }
            }
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(shown) { item in
                    CommonGroundGalleryCard(code: code, item: item) {
                        path.append(.galleryItem(code, item.itemId))
                    }
                }
            }
        }
    }

    private var shareButton: some View {
        Button("Share") {
            sharing = true
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
    }

    private func chip(_ title: String, dot: Color? = nil, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
                Text(title).lineLimit(1)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? Color(uiColor: .systemBackground) : Color.secondary)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(selected ? Color.primary : Color.primary.opacity(0.07), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// One card: the 4:3 thumbnail with its type chip, the title, who shared it
/// and the comment count. My own cards add Remove from gallery, from the
/// ellipsis and from a long press.
struct CommonGroundGalleryCard: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let item: CommonGroundGalleryItem
    let open: () -> Void

    private var accessibilityText: String {
        let comments = item.commentCount == 0 ? "" : item.commentCount == 1 ? ", 1 comment" : ", \(item.commentCount) comments"
        return "\(item.title), \(item.author(full: true))\(comments)"
    }

    var body: some View {
        if item.mine {
            card
                .overlay(alignment: .topTrailing) {
                    CommonGroundGalleryMoreMenu(title: "Remove from gallery", floating: true, disabled: removing, action: remove)
                        .padding(-3)
                }
                .contextMenu {
                    Button("Remove from gallery", role: .destructive, action: remove)
                }
        } else {
            card
        }
    }

    private var removing: Bool { model.busy == CommonGroundModel.galleryRemoveBusyKey(item.itemId) }

    private var card: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                CommonGroundGalleryThumbnail(code: code, item: item)
                Text(item.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .padding(.top, 6)
                HStack(spacing: 5) {
                    CommonGroundAvatar(person: item.person, size: 14)
                    Text(item.author())
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if item.commentCount > 0 {
                        HStack(spacing: 3) {
                            Image(systemName: "bubble.right")
                                .imageScale(.small)
                            Text("\(item.commentCount)")
                                .monospacedDigit()
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private func remove() {
        Task { _ = await model.removeFromGallery(code: code, itemId: item.itemId) }
    }
}
