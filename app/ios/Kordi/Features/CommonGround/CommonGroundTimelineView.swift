import SwiftUI

/// Quarters, newest first, on a dotted rail; past topics close the list muted.
struct CommonGroundTimeline: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let profile: CommonGroundProfile
    let onOpen: (String) -> Void

    private struct Entry: Identifiable {
        let period: String
        let topics: [String]
        var id: String { period }
    }

    private static let periodWidth: CGFloat = 72
    private static let rowPadding: CGFloat = 10
    /// Vertical centre of the dot within a row.
    private static let dotCenter: CGFloat = rowPadding + 10

    /// Each topic sits in the period it first appeared; earlier topics that
    /// appear in no period close the list.
    private var entries: [Entry] {
        var out = profile.timeline.map { Entry(period: $0.period, topics: $0.topics) }
        let placed = Set(profile.timeline.flatMap(\.topics))
        let rest = profile.earlier.filter { !placed.contains($0) }
        if !rest.isEmpty {
            out.append(Entry(period: "Earlier", topics: rest))
        }
        return out
    }

    var body: some View {
        let entries = entries
        CommonGroundSection(title: "Timeline") {
            VStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    row(entry, isFirst: index == 0, isLast: index == entries.count - 1)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func row(_ entry: Entry, isFirst: Bool, isLast: Bool) -> some View {
        let earlier = Set(profile.earlier)
        let muted = !entry.topics.isEmpty && entry.topics.allSatisfy(earlier.contains)
        return HStack(alignment: .top, spacing: 12) {
            Text(entry.period)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(muted ? .secondary : .primary)
                .frame(width: Self.periodWidth, alignment: .leading)
            Circle()
                .fill(muted ? Color(uiColor: .tertiaryLabel) : chatTheme.accent)
                .frame(width: 8, height: 8)
                .padding(.top, Self.dotCenter - Self.rowPadding - 4)
            FlowLayout(spacing: 6) {
                ForEach(entry.topics, id: \.self) { topic in
                    Button { onOpen(topic) } label: {
                        CommonGroundTopicPill(topic: topic, muted: earlier.contains(topic))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, Self.rowPadding)
        .background(alignment: .topLeading) {
            if !(isFirst && isLast) {
                Rectangle()
                    .fill(Color(uiColor: .separator))
                    .frame(width: 1.5, height: isLast ? Self.dotCenter : nil)
                    .padding(.top, isFirst ? Self.dotCenter : 0)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.leading, 14 + Self.periodWidth + 12 + 4 - 0.75)
            }
        }
    }
}

/// The evidence behind one topic, newest first, as chips; tapping one opens
/// its detail below, and a reference with a web page gets Open.
/// Topics on the card can be hidden from others here.
struct CommonGroundReferences: View {
    @EnvironmentObject private var model: CommonGroundModel
    let topic: String
    let profile: CommonGroundProfile?
    @State private var openId: String?

    private var onCard: Bool { model.card?.topics.all.contains(topic) ?? false }

    var body: some View {
        let info = profile?.topics[topic]
        let items = profile?.evidence(for: topic) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(topic)
                            .font(.title3.weight(.bold))
                        if let seen = seenLine(info) {
                            Text(seen)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    if onCard {
                        Button(model.isHidden(topic) ? "Show" : "Hide") {
                            Task { await model.toggleHidden(topic) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(model.busy == "hidden")
                    }
                }
                .padding(.horizontal, 4)
                CommonGroundSection {
                    if items.isEmpty {
                        CommonGroundRow(title: "No references")
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            FlowLayout(spacing: 8) {
                                ForEach(items, id: \.id) { entry in
                                    chip(entry.item, selected: entry.id == openId) {
                                        openId = entry.id == openId ? nil : entry.id
                                    }
                                }
                            }
                            if let open = items.first(where: { $0.id == openId }) {
                                detail(open.item)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// A note's title is generic, so its chip shows its own words.
    private func label(_ item: CommonGroundProfile.Evidence) -> String {
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let isNote = item.source.lowercased().contains("note")
        if !title.isEmpty, !isNote { return title }
        let words = item.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? (title.isEmpty ? item.source : title) : words
    }

    private func chip(_ item: CommonGroundProfile.Evidence, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: CommonGroundCardDetail.symbol(forSource: item.source))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(label(item))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .font(.subheadline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 11)
            .frame(height: 32)
            .background(Capsule().fill(Color(uiColor: .systemGroupedBackground)))
            .overlay(
                Capsule().strokeBorder(selected ? Color.primary : Color(uiColor: .separator), lineWidth: selected ? 1 : 0.5)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func detail(_ item: CommonGroundProfile.Evidence) -> some View {
        let isNote = item.source.lowercased().contains("note")
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = item.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        let meta = [item.source, commonGroundDisplayDate(item.date)].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 3) {
            if !title.isEmpty, !isNote {
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            if !meta.isEmpty {
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !words.isEmpty, words != title {
                Text(words)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
            if let raw = item.url, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                Link(destination: url) {
                    Label("Open", systemImage: "arrow.up.right")
                        .labelStyle(.titleAndIcon)
                        .font(.subheadline)
                }
                .padding(.top, 4)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(uiColor: .tertiarySystemFill)))
    }

    private func seenLine(_ info: CommonGroundProfile.TopicInfo?) -> String? {
        let parts = [
            commonGroundDisplayDate(info?.firstSeen).map { "First seen \($0)" },
            commonGroundDisplayDate(info?.lastSeen).map { "Last seen \($0)" },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
