import SwiftUI

/// The "Seen by" row at the bottom of the message menu (#2455): loading,
/// "Not seen yet", one reader by name, or "N Seen" with up to four faces.
struct MessageSeenByRow: View {
    @ScaledMetric(relativeTo: .footnote) private var avatarSize = 18.0
    let state: MessageSeenByState
    let onShowReaders: () -> Void

    @ViewBuilder
    var body: some View {
        if state.isVisible {
            Divider().padding(.horizontal, 14)
            if state.opensList {
                Button(action: onShowReaders) { content }
                    .buttonStyle(MessageSeenByRowButtonStyle())
                    .accessibilityHint("Shows who has seen this message")
            } else {
                content
            }
        }
    }

    private var content: some View {
        HStack(spacing: 10) {
            MessageDeliveryGlyph(state: .read)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            if let label = state.label {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                faces
            } else {
                skeleton
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.accessibilityLabel)
    }

    @ViewBuilder
    private var faces: some View {
        if !state.faces.isEmpty {
            HStack(spacing: -4) {
                ForEach(Array(state.faces.enumerated()), id: \.element.id) { index, reader in
                    IdentityAvatar(
                        name: reader.displayName,
                        imageSource: reader.avatarUrl,
                        kind: .person,
                        size: avatarSize,
                        seed: reader.accountId
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: avatarSize * 0.17, style: .continuous)
                            .stroke(Color(uiColor: .systemBackground), lineWidth: 1)
                    }
                    .zIndex(Double(index))
                }
            }
        }
    }

    private var skeleton: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color(uiColor: .secondarySystemFill))
                .frame(width: 72, height: 10)
            Spacer(minLength: 8)
            HStack(spacing: -4) {
                ForEach(0..<2, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: avatarSize * 0.17, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemFill))
                        .frame(width: avatarSize, height: avatarSize)
                }
            }
        }
    }
}

private struct MessageSeenByRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(uiColor: .tertiarySystemFill) : .clear)
    }
}

/// Everyone who read the viewer's group message, in the flat Settings-sheet
/// style: inline title, Done, 48 pt rows with avatar, name and time.
struct MessageReadersSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var state: MessageReadersListState = .loading
    let target: MessageSeenByTarget
    let load: MessageReadersLoader

    var body: some View {
        NavigationStack {
            SettingsPage {
                switch state {
                case .loading:
                    SettingsLoadingRow("Loading")
                case .failed:
                    SettingsErrorLabel("Could not load who has seen this.")
                case let .loaded(readers) where readers.isEmpty:
                    Text("Not seen yet")
                        .font(SettingsFont.rowTitle)
                        .foregroundStyle(.secondary)
                        .frame(minHeight: SettingsMetrics.rowMinHeight)
                case let .loaded(readers):
                    ForEach(readers) { reader in
                        MessageReaderListRow(reader: reader)
                    }
                }
            }
            .navigationTitle("Seen by")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task(id: target) {
            state = .loading
            do {
                let response = try await load(target, CloudAPIClient.messageReadersMaximum)
                guard !Task.isCancelled else { return }
                state = .loaded(MessageSeenByPresentation.readers(in: response, participants: target.participants))
            } catch {
                guard !Task.isCancelled else { return }
                state = .failed
            }
        }
    }
}

private struct MessageReaderListRow: View {
    let reader: MessageReaderRow

    var body: some View {
        HStack(spacing: 12) {
            IdentityAvatar(
                name: reader.displayName,
                imageSource: reader.avatarUrl,
                kind: .person,
                size: 32,
                seed: reader.accountId
            )
            Text(reader.displayName)
                .font(SettingsFont.rowTitle)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if let time = MessageSeenByPresentation.readTimeLabel(reader.readAt) {
                Text(time)
                    .font(SettingsFont.subtitle)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .frame(maxWidth: .infinity, minHeight: SettingsMetrics.rowMinHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
