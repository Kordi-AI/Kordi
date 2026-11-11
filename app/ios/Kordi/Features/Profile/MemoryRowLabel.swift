import SwiftUI

/// The category chip on a memory row: a small 8 pt rounded tag.
struct MemoryCategoryTag: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .fixedSize()
    }
}

/// A memory's text over its caption ("From a correction · Today") with one
/// chip per category after it, then any extra caption lines. The chips move
/// under the caption when they do not fit beside it.
struct MemoryRowLabel: View {
    let text: String
    let detail: String
    /// The memory's categories in order (`CloudMemory.allCategories`).
    let categories: [String]
    var captions: [String] = []

    private var chips: [String] { categories.compactMap(MemoryPresentation.categoryLabel(for:)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text)
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    detailText
                    tags
                }
                VStack(alignment: .leading, spacing: 4) {
                    detailText
                    tags
                }
            }
            ForEach(captions, id: \.self) { caption in
                Text(caption).font(SettingsFont.subtitle).foregroundStyle(.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var detailText: some View {
        if !detail.isEmpty {
            Text(detail).font(SettingsFont.subtitle).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var tags: some View {
        if !chips.isEmpty {
            HStack(spacing: 4) {
                ForEach(chips, id: \.self) { MemoryCategoryTag(label: $0) }
            }
        }
    }
}
