import SwiftUI
import UIKit

/// Picks one group the viewer manages and invites the person to it, or adds
/// them straight away when they are a contact.
struct CommonGroundInviteToGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: CommonGroundModel
    let person: CommonGroundPerson

    @State private var phase: Phase = .loading
    @State private var selectedGroupID: String?
    @State private var isSending = false
    @State private var failure: CommonGroundGroupInviteError?

    private enum Phase: Equatable {
        case loading
        case loaded(CommonGroundInviteGroups)
        case failed(String)
    }

    private var isContact: Bool {
        if case .loaded(let list) = phase { return list.contact }
        return false
    }

    private var confirmLabel: String { isContact ? "Add" : "Invite" }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Invite to group")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .disabled(isSending)
                        .accessibilityLabel("Cancel")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(action: send) {
                            if isSending {
                                ProgressView()
                            } else {
                                Image(systemName: "checkmark")
                            }
                        }
                        .disabled(selectedGroupID == nil || isSending)
                        .accessibilityLabel(confirmLabel)
                    }
                }
        }
        .task { await load() }
        .sensoryFeedback(.selection, trigger: selectedGroupID)
        .alert("Could not invite", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }), presenting: failure) { _ in
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled(isSending)
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemBackground))
        case .failed(let message):
            ContentUnavailableView {
                Label(message, systemImage: "exclamationmark.triangle")
            } actions: {
                Button("Try again") { Task { await load() } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
        case .loaded(let list) where list.groups.isEmpty:
            ContentUnavailableView("No groups", systemImage: "person.2")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemBackground))
        case .loaded(let list):
            List(list.groups) { group in
                CommonGroundInviteGroupRow(group: group, isSelected: selectedGroupID == group.id) {
                    toggle(group)
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .disabled(isSending)
        }
    }

    /// Loads the groups; a list on screen stays while it reloads.
    private func load() async {
        if case .loaded = phase {} else { phase = .loading }
        switch await model.inviteGroups(for: person.accountId) {
        case .success(let list):
            phase = .loaded(list)
            if let selectedGroupID, !list.groups.contains(where: { $0.id == selectedGroupID && $0.state == nil }) {
                self.selectedGroupID = nil
            }
        case .failure(let error):
            if case .loaded = phase { return }
            phase = .failed(error.message)
        }
    }

    private func toggle(_ group: CommonGroundInviteGroup) {
        guard group.state == nil else { return }
        withAnimation(reduceMotion ? .easeOut(duration: 0.1) : .snappy(duration: 0.2)) {
            selectedGroupID = selectedGroupID == group.id ? nil : group.id
        }
    }

    private func send() {
        guard let groupSpaceId = selectedGroupID, !isSending else { return }
        isSending = true
        Task {
            if let error = await model.invite(person.accountId, toGroup: groupSpaceId) {
                isSending = false
                failure = error
                await load()
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            isSending = false
            dismiss()
        }
    }
}

/// One group: its avatar grid, name and size, and a selection circle, or
/// "Member" / "Invited" when it cannot be picked.
private struct CommonGroundInviteGroupRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let group: CommonGroundInviteGroup
    let isSelected: Bool
    let onToggle: () -> Void

    private var memberLine: String { group.memberCount == 1 ? "1 member" : "\(group.memberCount) members" }

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                GroupAvatarStack(participants: group.participants, size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(group.state == nil ? Color.primary : Color.secondary)
                        .lineLimit(1)
                    Text(memberLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let stateTitle = group.stateTitle {
                    Text(stateTitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? chatTheme.accent : Color.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(group.state != nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(group.title), \(memberLine)")
        .accessibilityValue(group.stateTitle ?? (isSelected ? "Selected" : "Not selected"))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
