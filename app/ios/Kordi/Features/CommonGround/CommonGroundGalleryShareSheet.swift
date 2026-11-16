import SwiftUI
import UIKit

/// Shares my artifacts to the room's gallery: search, pick up to eight (ones
/// already shared show "Shared"), and an optional room topic.
struct CommonGroundGalleryShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let roomTitle: String
    let topics: [String]
    let onShared: () -> Void
    /// In the order picked, which is the order the server returns.
    @State private var picked: [String] = []
    @State private var query = ""
    /// "" is None.
    @State private var topic = ""
    @State private var attempted = false

    private var candidates: [CommonGroundGalleryCandidate]? { model.gallery.candidates[code] }
    private var busy: Bool { model.busy == CommonGroundModel.galleryShareBusyKey(code) }
    private var loading: Bool { model.busy == CommonGroundModel.galleryCandidatesBusyKey(code) }
    private var shareTitle: String { picked.count > 1 ? "Share \(picked.count)" : "Share" }

    private var matches: [CommonGroundGalleryCandidate] {
        let candidates = candidates ?? []
        guard let query = query.nonEmpty else { return candidates }
        return candidates.filter {
            $0.title.localizedCaseInsensitiveContains(query) || $0.fileName.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Share to \(roomTitle)")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(busy)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(shareTitle, action: share)
                            .fontWeight(.semibold)
                            .disabled(picked.isEmpty || busy)
                    }
                }
        }
        .overlay(alignment: .top) { CommonGroundToast(text: $model.notice) }
        .task {
            await model.loadGalleryCandidates(code)
            attempted = true
        }
        .sensoryFeedback(.selection, trigger: picked)
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private var content: some View {
        if let candidates {
            List {
                Section {
                    if candidates.isEmpty {
                        Text("No artifacts yet").foregroundStyle(.secondary)
                    } else if matches.isEmpty {
                        Text("No matches").foregroundStyle(.secondary)
                    }
                    ForEach(matches) { candidate in
                        row(candidate)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                }
                if !topics.isEmpty {
                    Section {
                        Picker("Topic", selection: $topic) {
                            Text("None").tag("")
                            ForEach(topics, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.menu)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .disabled(busy)
        } else if loading || !attempted {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemBackground))
        } else {
            ContentUnavailableView {
                Label("Could not load", systemImage: "exclamationmark.triangle")
            } actions: {
                Button("Try again") { Task { await model.loadGalleryCandidates(code) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
        }
    }

    private func row(_ candidate: CommonGroundGalleryCandidate) -> some View {
        let isOn = picked.contains(candidate.attachmentId)
        let full = picked.count >= CommonGroundModel.galleryShareMax
        let date = DocumentDates.short(candidate.updatedAt).nonEmpty
        return Button { toggle(candidate) } label: {
            HStack(spacing: 12) {
                CommonGroundGalleryTypeTile(fileName: candidate.fileName, contentType: candidate.contentType)
                VStack(alignment: .leading, spacing: 1) {
                    Text(candidate.title)
                        .font(.body)
                        .foregroundStyle(candidate.shared ? Color.secondary : Color.primary)
                        .lineLimit(1)
                    if let date {
                        Text(date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if candidate.shared {
                    Text("Shared")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isOn ? chatTheme.accent : Color.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(candidate.shared || (full && !isOn))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([candidate.title, date].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(candidate.shared ? "Shared" : isOn ? "Selected" : "Not selected")
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
    }

    private func toggle(_ candidate: CommonGroundGalleryCandidate) {
        guard !candidate.shared else { return }
        if let index = picked.firstIndex(of: candidate.attachmentId) {
            picked.remove(at: index)
        } else if picked.count < CommonGroundModel.galleryShareMax {
            picked.append(candidate.attachmentId)
        }
    }

    private func share() {
        guard !picked.isEmpty, !busy else { return }
        let ids = picked
        Task {
            guard await model.shareToGallery(code: code, attachmentIds: ids, topic: topic.nonEmpty) else { return }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onShared()
            dismiss()
        }
    }
}
