import SwiftUI

struct GroupMemberInviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: AppModel
    let space: GroupSpaceSummary

    @State private var selectedContactIDs = Set<String>()
    /// People from Grounding picked to invite.
    @State private var selectedGroundingIDs = Set<String>()
    /// People from Grounding the group can invite; empty hides the section.
    @State private var groundingCandidates: [CommonGroundGroupCandidate] = []
    @State private var isSaving = false
    @State private var searchText = ""
    @State private var completion: GroupInviteCompletion?
    @State private var groundingFailure: String?

    private var memberIDs: Set<String> {
        space.fullyJoinedParticipantAccountIds
    }

    private var eligibleContactItems: [GroupInviteContactItem] {
        model.contacts
            .filter {
                !memberIDs.contains($0.accountId) && isEligibleGroupContact($0)
            }
            .map(GroupInviteContactItem.init)
            .sorted {
                $0.sortKey.localizedCaseInsensitiveCompare($1.sortKey) == .orderedAscending
            }
    }

    private var filteredContactItems: [GroupInviteContactItem] {
        guard !searchText.isEmpty else { return eligibleContactItems }
        return eligibleContactItems.filter {
            $0.contact.preferredName.localizedCaseInsensitiveContains(searchText)
                || $0.contact.kordiId?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    private var contactSections: [GroupInviteContactSection] {
        Dictionary(grouping: filteredContactItems, by: \.sectionTitle)
            .map { GroupInviteContactSection(title: $0.key, contacts: $0.value) }
            .sorted { lhs, rhs in
                if lhs.title == "#" { return false }
                if rhs.title == "#" { return true }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
    }

    /// Grounding people who are not members and not already listed as contacts.
    private var eligibleGroundingCandidates: [CommonGroundGroupCandidate] {
        let contactIDs = Set(eligibleContactItems.map(\.contact.accountId))
        return groundingCandidates.filter {
            !memberIDs.contains($0.id) && !contactIDs.contains($0.id)
        }
    }

    private var filteredGroundingCandidates: [CommonGroundGroupCandidate] {
        guard !searchText.isEmpty else { return eligibleGroundingCandidates }
        return eligibleGroundingCandidates.filter {
            $0.person.displayName.localizedCaseInsensitiveContains(searchText)
                || $0.source?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    private var listRows: [GroupInviteListRow] {
        let contactRows: [GroupInviteListRow] = contactSections.flatMap { section in
            [.section(section.title)] + section.contacts.map(GroupInviteListRow.contact)
        }
        let grounding = filteredGroundingCandidates
        guard !grounding.isEmpty else { return contactRows }
        return contactRows + [.section(GroupInviteListRow.groundingTitle)] + grounding.map(GroupInviteListRow.grounding)
    }

    private var selectedCount: Int {
        selectedContactIDs.count + selectedGroundingIDs.count
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    if listRows.isEmpty {
                        ContentUnavailableView(
                            searchText.isEmpty ? "No contacts to add" : "No contacts found",
                            systemImage: searchText.isEmpty ? "person.badge.plus" : "magnifyingglass",
                            description: Text(
                                searchText.isEmpty
                                    ? "All eligible contacts are already in this group."
                                    : "Try another name or Kordi ID."
                            )
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } else {
                        ForEach(listRows) { row in
                            GroupInviteListRowContent(
                                row: row,
                                selectedContactIDs: selectedContactIDs,
                                selectedGroundingIDs: selectedGroundingIDs,
                                onToggle: toggleContact,
                                onToggleGrounding: toggleGroundingPerson
                            )
                            .listRowInsets(row.insets)
                            .listRowSeparator(row.showsSeparator ? .visible : .hidden, edges: .bottom)
                            .id(row.id)
                        }
                    }
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, 1)
                .scrollContentBackground(.hidden)
                .background(Color(uiColor: .systemBackground))
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .topTrailing) {
                    if searchText.isEmpty, contactSections.count > 1 {
                        GroupInviteAlphabetIndex(sections: contactSections) { sectionID in
                            withAnimation(.snappy(duration: 0.2)) {
                                proxy.scrollTo(sectionID, anchor: .top)
                            }
                        }
                        .padding(.top, 12)
                    }
                }
            }
            .searchable(
                text: $searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search people"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .disabled(isSaving)
                    .accessibilityLabel("Cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        inviteSelectedContacts()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Image(systemName: "checkmark")
                        }
                    }
                    .disabled(selectedCount == 0 || isSaving)
                    .accessibilityLabel(
                        selectedCount == 0
                            ? "Add members"
                            : "Add \(selectedCount) members"
                    )
                }
            }
        }
        .task {
            // Only while the sheet is open; a failed or missing list hides the section.
            groundingCandidates = await model.groundingGroupCandidates(for: space) ?? []
        }
        .alert(
            "Could not invite",
            isPresented: Binding(get: { groundingFailure != nil }, set: { if !$0 { groundingFailure = nil } }),
            presenting: groundingFailure
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
        .disabled(completion != nil)
        .overlay {
            if let completion {
                GroupInviteCompletionView(
                    completion: completion,
                    reduceMotion: reduceMotion
                )
                .transition(
                    reduceMotion
                        ? .opacity
                        : .scale(scale: 0.9).combined(with: .opacity)
                )
            }
        }
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.34, dampingFraction: 0.84),
            value: completion
        )
        .sensoryFeedback(.selection, trigger: selectedContactIDs)
        .sensoryFeedback(.selection, trigger: selectedGroundingIDs)
        .sensoryFeedback(.success, trigger: completion)
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled(isSaving || completion != nil)
    }

    private func toggleContact(_ accountID: String) {
        let animation: Animation = reduceMotion
            ? .easeOut(duration: 0.1)
            : .snappy(duration: 0.2)
        withAnimation(animation) {
            if selectedContactIDs.contains(accountID) {
                selectedContactIDs.remove(accountID)
            } else {
                selectedContactIDs.insert(accountID)
            }
        }
    }

    private func toggleGroundingPerson(_ accountID: String) {
        let animation: Animation = reduceMotion
            ? .easeOut(duration: 0.1)
            : .snappy(duration: 0.2)
        withAnimation(animation) {
            if selectedGroundingIDs.contains(accountID) {
                selectedGroundingIDs.remove(accountID)
            } else {
                selectedGroundingIDs.insert(accountID)
            }
        }
    }

    /// Adds the picked contacts, then invites the picked Grounding people.
    private func inviteSelectedContacts() {
        let contacts = eligibleContactItems
            .map(\.contact)
            .filter { selectedContactIDs.contains($0.accountId) }
        let groundingIDs = eligibleGroundingCandidates
            .map(\.id)
            .filter { selectedGroundingIDs.contains($0) }
        guard !contacts.isEmpty || !groundingIDs.isEmpty else { return }
        isSaving = true
        Task {
            if !contacts.isEmpty {
                let didInvite = await model.inviteContacts(contacts, to: space)
                guard didInvite else {
                    isSaving = false
                    return
                }
                selectedContactIDs.subtract(contacts.map(\.accountId))
            }
            if !groundingIDs.isEmpty, let failure = await model.inviteGroundingPeople(groundingIDs, to: space) {
                isSaving = false
                groundingFailure = failure
                selectedGroundingIDs = []
                groundingCandidates = await model.groundingGroupCandidates(for: space) ?? []
                return
            }

            withAnimation(
                reduceMotion
                    ? .easeOut(duration: 0.12)
                    : .spring(response: 0.34, dampingFraction: 0.84)
            ) {
                isSaving = false
                completion = GroupInviteCompletion(added: contacts.count, invited: groundingIDs.count)
            }
            try? await Task.sleep(for: reduceMotion ? .milliseconds(250) : .milliseconds(700))
            dismiss()
        }
    }

}

private struct GroupInviteContactItem: Identifiable {
    let contact: CloudContact
    let sortKey: String
    let sectionTitle: String

    var id: CloudContact.ID { contact.id }

    init(_ contact: CloudContact) {
        self.contact = contact
        let transliteratedName = contact.preferredName
            .applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false)
        let sortKey = transliteratedName?.nonEmpty ?? contact.preferredName
        self.sortKey = sortKey

        if let scalar = sortKey.uppercased().unicodeScalars.first,
           (65 ... 90).contains(scalar.value) {
            sectionTitle = String(scalar)
        } else {
            sectionTitle = "#"
        }
    }
}

private struct GroupInviteContactSection: Identifiable {
    let title: String
    let contacts: [GroupInviteContactItem]

    var id: String { title }

    var scrollID: String { "section:\(title)" }
}

private enum GroupInviteListRow: Identifiable {
    static let groundingTitle = "From Grounding"

    case section(String)
    case contact(GroupInviteContactItem)
    case grounding(CommonGroundGroupCandidate)

    var id: String {
        switch self {
        case let .section(title):
            "section:\(title)"
        case let .contact(item):
            "contact:\(item.id)"
        case let .grounding(candidate):
            "grounding:\(candidate.id)"
        }
    }

    var insets: EdgeInsets {
        switch self {
        case let .section(title) where title == Self.groundingTitle:
            EdgeInsets(top: 18, leading: 16, bottom: 2, trailing: 28)
        case .section:
            EdgeInsets(top: 7, leading: 16, bottom: 2, trailing: 28)
        case .contact, .grounding:
            EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 28)
        }
    }

    var showsSeparator: Bool {
        if case .section = self { return false }
        return true
    }
}

/// What the sheet did: contacts added directly and people invited.
private struct GroupInviteCompletion: Equatable {
    let added: Int
    let invited: Int

    var title: String {
        switch (added, invited) {
        case (_, 0): added == 1 ? "Member added" : "\(added) members added"
        case (0, _): invited == 1 ? "Invitation sent" : "\(invited) invitations sent"
        default: "\(added) added, \(invited) invited"
        }
    }
}

private struct GroupInviteListRowContent: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let row: GroupInviteListRow
    let selectedContactIDs: Set<String>
    let selectedGroundingIDs: Set<String>
    let onToggle: (String) -> Void
    let onToggleGrounding: (String) -> Void

    var body: some View {
        Group {
            switch row {
            case let .section(title):
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case let .contact(item):
                contactButton(item.contact)
            case let .grounding(candidate):
                groundingButton(candidate)
            }
        }
    }

    private func groundingButton(_ candidate: CommonGroundGroupCandidate) -> some View {
        let person = candidate.person
        let isSelected = !candidate.invited && selectedGroundingIDs.contains(person.accountId)
        return Button {
            onToggleGrounding(person.accountId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? chatTheme.accent : Color.secondary)
                    .contentTransition(.symbolEffect(.replace))
                    .opacity(candidate.invited ? 0 : 1)
                IdentityAvatar(
                    name: person.displayName,
                    imageSource: person.avatarUrl.nonEmpty,
                    kind: .person,
                    size: 38,
                    seed: person.accountId
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(person.displayName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(candidate.invited ? Color.secondary : Color.primary)
                        .lineLimit(1)
                    Text(candidate.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if candidate.invited {
                    Text("Invited")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(candidate.invited)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(person.displayName), \(candidate.detail)")
        .accessibilityValue(candidate.invited ? "Invited" : isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private func contactButton(_ contact: CloudContact) -> some View {
        let isSelected = selectedContactIDs.contains(contact.accountId)
        return Button {
            onToggle(contact.accountId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? chatTheme.accent : Color.secondary)
                    .contentTransition(.symbolEffect(.replace))
                IdentityAvatar(
                    name: contact.preferredName,
                    imageSource: contact.avatarUrl.nonEmpty,
                    kind: .person,
                    size: 38,
                    seed: contact.accountId
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(contact.preferredName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let kordiID = contact.kordiId.nonEmpty {
                        Text("@\(kordiID)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(contact.preferredName)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct GroupInviteCompletionView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let completion: GroupInviteCompletion
    let reduceMotion: Bool

    @State private var isSettled = false

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .opacity(0.96)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                Image(systemName: "checkmark")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(chatTheme.accentForeground)
                    .frame(width: 72, height: 72)
                    .background(chatTheme.accent, in: Circle())
                    .scaleEffect(reduceMotion || isSettled ? 1 : 0.78)
                    .opacity(reduceMotion || isSettled ? 1 : 0.25)

                Text(completion.title)
                    .font(.title3.weight(.semibold))

                if completion.invited == 0 {
                    Text("The group is ready for everyone.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.center)
            .padding(24)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(completion.title)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) {
                isSettled = true
            }
        }
    }
}

private struct GroupInviteAlphabetIndex: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let sections: [GroupInviteContactSection]
    let onSelect: (GroupInviteContactSection.ID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(sections) { section in
                Button {
                    onSelect(section.scrollID)
                } label: {
                    Text(section.title)
                        .font(.caption2.weight(.bold))
                        .frame(width: 24)
                        .frame(minHeight: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Jump to \(section.title)")
            }
        }
        .foregroundStyle(chatTheme.accent)
        .padding(.vertical, 6)
        .padding(.trailing, 2)
    }
}

func isEligibleGroupContact(_ contact: CloudContact) -> Bool {
    !KordiSupportIdentity.matches(name: contact.preferredName, seed: contact.accountId)
}
