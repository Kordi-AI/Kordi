import SwiftUI

enum ChatChannel: Hashable {
    case contact
    case agent
}

private struct ProjectPickerPresentation: Identifiable {
    let id: String
    let conversation: ConversationSummary?

    static let newProject = ProjectPickerPresentation(id: "new-project", conversation: nil)

    static func move(_ conversation: ConversationSummary) -> ProjectPickerPresentation {
        ProjectPickerPresentation(id: "move:\(conversation.sessionId)", conversation: conversation)
    }
}

struct ChatHomeView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let channel: ChatChannel
    @State private var searchText = ""
    @State private var collapsedProjectIDs = Set<String>()
    @State private var projectPicker: ProjectPickerPresentation?
    @State private var newChatMode: NewChatMode?
    @State private var composedConversation: ConversationSummary?
    @State private var expandedGroupSpaceIds = Set<String>()
    @State private var collapsedAgentForkParentIds = Set<String>()
    @State private var renameTarget: ConversationSummary?
    @State private var renameDraft = ""
    @State private var deleteTarget: ConversationSummary?
    @State private var showingArchivedChats = false
    @State private var groupManagementPresentation: GroupManagementPresentation?
    @State private var channelDissolveTarget: ChannelDissolveTarget?
    @State private var closedDeleteTarget: ClosedChatDeleteTarget?
    /// Previews open the sheet at full height so every section shows.
    @State private var groupManagementDetent: PresentationDetent =
        ProcessInfo.processInfo.arguments.contains("--preview-group-management") ? .large : .medium
    @State private var channelCreationSpace: GroupSpaceSummary?
    @State private var pullRefreshState = ChatPullRefreshState()
    @State private var activeSwipeRowID: String?
    private let onOpenConversation: ((ConversationSummary) -> Void)?
    private let onOpenNewChat: ((NewChatMode) -> Void)?
    private let onOpenArchivedChats: (() -> Void)?

    init(
        channel: ChatChannel,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil,
        onOpenNewChat: ((NewChatMode) -> Void)? = nil,
        onOpenArchivedChats: (() -> Void)? = nil
    ) {
        self.channel = channel
        _newChatMode = State(initialValue: NewChatMode.previewMode(arguments: ProcessInfo.processInfo.arguments))
        self.onOpenConversation = onOpenConversation
        self.onOpenNewChat = onOpenNewChat
        self.onOpenArchivedChats = onOpenArchivedChats
    }

    private var searchQuery: String {
        ChatHomeSearch.normalized(searchText)
    }

    private var agentSessions: [AgentSessionListItem] {
        AgentSessionTimelineCatalog.build(
            conversations: model.conversations.filter { $0.personalAgentId == nil },
            searchText: searchQuery,
            collapsedForkParentIds: collapsedAgentForkParentIds,
            pinnedSessionIds: model.pinnedSessionIds
        )
    }

    private var groupSpaces: [GroupSpaceSummary] {
        let spaces = GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? "",
            pinnedSessionIds: model.pinnedSessionIds
        )
        guard !searchQuery.isEmpty else { return spaces }
        return spaces.filter { space in
            ChatHomeSearch.matches(space, query: searchQuery)
        }
    }

    private var contactItems: [ContactListItem] {
        let contactsByAccountID = Dictionary(
            uniqueKeysWithValues: model.contacts.map { ($0.accountId, $0) }
        )
        let people: [ContactListItem] = ProcessInfo.processInfo.arguments.contains("--preview-group-only")
            ? []
            : model.conversations
                .filter { conversation in
                    guard conversation.kind == .person else { return false }
                    guard !searchQuery.isEmpty else { return true }
                    let contact = contactsByAccountID[conversation.peerAccountId]
                    return ChatHomeSearch.matches(
                        conversation,
                        contact: contact,
                        query: searchQuery
                    )
                }
                .map(ContactListItem.conversation)
        return (people + groupSpaces.map(ContactListItem.group))
            .sorted {
                let leftPinned = $0.isPinned(
                    sessionIds: model.pinnedSessionIds,
                    groupSpaceIds: model.pinnedGroupSpaceIds
                )
                let rightPinned = $1.isPinned(
                    sessionIds: model.pinnedSessionIds,
                    groupSpaceIds: model.pinnedGroupSpaceIds
                )
                if leftPinned != rightPinned { return leftPinned }
                return ChatListOrdering.precedes(
                    id: $0.id,
                    displayName: $0.displayName,
                    lastActivityAt: $0.lastActivityAt,
                    before: $1.id,
                    displayName: $1.displayName,
                    lastActivityAt: $1.lastActivityAt
                )
            }
    }

    private var archivedForChannelCount: Int {
        if channel == .agent {
            return model.archivedConversations.count { $0.kind == .agent }
        }
        let people = model.archivedConversations.count { $0.kind == .person }
        let groups = GroupSpaceCatalog.build(
            conversations: model.archivedConversations,
            ownAccountId: model.account?.accountId ?? ""
        ).count
        return people + groups
    }

    private var contactRows: [ContactListRow] {
        contactItems.flatMap { item -> [ContactListRow] in
            switch item {
            case let .conversation(conversation):
                return [.conversation(conversation)]
            case let .group(space):
                return [.group(space)] + (groupIsExpanded(space)
                    ? space.sessions.map { .groupSession($0) }
                    : [])
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if channel == .contact {
                contactPage
            } else {
                agentPage
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: channel == .contact ? "Search chats" : "Search agent sessions"
        )
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-channel-create"),
               channelCreationSpace == nil {
                channelCreationSpace = groupSpaces.first
            }
            if let previewNewChatMode = newChatMode {
                newChatMode = nil
                if let onOpenNewChat {
                    onOpenNewChat(previewNewChatMode)
                } else {
                    Task { @MainActor in
                        await Task.yield()
                        newChatMode = previewNewChatMode
                    }
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-group-management"),
               groupManagementPresentation == nil,
               let space = groupSpaces.first {
                groupManagementPresentation = GroupManagementPresentation(
                    space: space,
                    startsInInviteMode: ProcessInfo.processInfo.arguments.contains("--preview-group-invite")
                )
            }
        }
        .sheet(item: $projectPicker) { presentation in ChatProjectPicker(conversation: presentation.conversation) }
        .task(id: model.account?.accountId) {
            guard channel == .agent else { return }
            while !Task.isCancelled {
                await model.refreshProjects()
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
            }
        }
        .stableNavigationDestination(item: $composedConversation) { selected in
            ConversationView(conversation: selected)
        }
        .navigationDestination(isPresented: $showingArchivedChats) {
            ArchivedChatsView(channel: channel)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                archivedChatsButton
            }
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .principal) {
                    MessageSyncStatusView(refreshState: pullRefreshState)
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .principal) {
                    MessageSyncStatusView(refreshState: pullRefreshState)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                newChatButton
            }
        }
        .stableNavigationDestination(item: $newChatMode) { mode in
            newChatDestination(for: mode)
        }
        .sheet(item: $groupManagementPresentation) { presentation in
            GroupManagementSheet(presentation: presentation)
                .presentationDetents([.medium, .large], selection: $groupManagementDetent)
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(item: $channelCreationSpace) { space in
            ChannelCreateSheet(space: space) { created in
                expandedGroupSpaceIds.insert(space.id)
                openConversation(created)
            }
            .presentationBackground(.clear)
        }
        .alert(renameTarget?.kind == .group ? "Rename channel" : "Rename session", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField(renameTarget?.kind == .group ? "Channel name" : "Session name", text: $renameDraft)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") {
                guard let target = renameTarget else { return }
                renameTarget = nil
                Task { _ = await model.renameConversation(target, to: renameDraft) }
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text(renameTarget?.kind == .group
                ? "This shared channel name is synchronized for every group member."
                : "This name is synchronized with Kordi on macOS.")
        }
        .alert(
            "Delete this chat from your list?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete chat", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await model.deleteConversation(target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("This does not delete it for other participants. It will return only when a new visible message arrives.")
        }
        .alert(
            channelDissolveTarget.map { "Close \($0.conversation.displayName)?" } ?? "",
            isPresented: Binding(
                get: { channelDissolveTarget != nil },
                set: { if !$0 { channelDissolveTarget = nil } }
            ),
            presenting: channelDissolveTarget
        ) { target in
            Button("Close channel", role: .destructive) {
                channelDissolveTarget = nil
                Task { _ = await model.dissolveGroupChannel(target.conversation, in: target.space) }
            }
            Button("Cancel", role: .cancel) { channelDissolveTarget = nil }
        } message: { _ in
            Text("Everyone keeps the history. No one can send messages.")
        }
        .closedChatDeleteConfirmation($closedDeleteTarget)
        .task {
            // `--preview-channel-dissolve`: the confirmation for the sample group's second channel.
            guard ProcessInfo.processInfo.arguments.contains("--preview-channel-dissolve") else { return }
            try? await Task.sleep(for: .milliseconds(900))
            if let channel = model.conversations.first(where: { $0.sessionId == "session:group:mobile-release" }),
               let space = dissolvableSpace(for: channel) {
                channelDissolveTarget = ChannelDissolveTarget(conversation: channel, space: space)
            }
        }
        .overlay(alignment: .bottom) {
            VStack {
                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                        .padding()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.default, value: model.errorMessage)
        }
        .task(id: model.errorMessage) {
            guard let shown = model.errorMessage else { return }
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, model.errorMessage == shown else { return }
            model.errorMessage = nil
        }
    }

    private var newChatButton: some View {
        Menu {
            ForEach(NewChatMode.allCases) { mode in
                Button {
                    if let onOpenNewChat {
                        onOpenNewChat(mode)
                    } else {
                        newChatMode = mode
                    }
                } label: {
                    Label(mode.menuTitle, systemImage: mode.systemImage)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .contentShape(Rectangle())
        .accessibilityLabel("Start a chat")
    }

    private func newChatDestination(for mode: NewChatMode) -> some View {
        NewChatView(mode: mode) { selected in
            openConversation(selected)
        }
    }

    private var archivedChatsButton: some View {
        Button {
            if let onOpenArchivedChats {
                onOpenArchivedChats()
            } else {
                showingArchivedChats = true
            }
        } label: {
            Image(systemName: "archivebox")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Archived Chats")
        .accessibilityValue(Text(archivedForChannelCount, format: .number))
        .accessibilityHint("Shows archived chats")
        .accessibilityIdentifier("chat-archive")
    }

    private var contactPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "contact-chat-refresh",
            refreshState: pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
            if contactItems.isEmpty {
                ContentUnavailableView(
                    searchQuery.isEmpty ? "No contact conversations yet" : "No chats found",
                    systemImage: searchQuery.isEmpty ? "person.2" : "magnifyingglass",
                    description: Text(searchQuery.isEmpty ? "Start a chat with a contact to see it here." : "Try another name, Kordi ID, or message.")
                )
                .frame(maxWidth: .infinity, minHeight: 360)
            } else {
                ForEach(contactRows) { row in
                    contactRow(row)
                        .transition(.identity)
                }
            }
        }
        .accessibilityLabel("Contact chats")
    }

    @ViewBuilder
    private func contactRow(_ row: ContactListRow) -> some View {
        switch row {
        case let .conversation(conversation):
            destination(for: conversation)
        case let .group(space):
            let isExpanded = groupIsExpanded(space)
            Button {
                guard !dismissActiveSwipeActions() else { return }
                toggleGroupSpace(space)
            } label: {
                GroupSpaceRow(
                    space: space,
                    isExpanded: isExpanded,
                    mutedSessionIds: model.mutedSessionIds,
                    isPinned: groupIsPinned(space),
                    isMuted: groupIsMuted(space),
                    isClosed: model.isGroupSpaceClosed(space)
                )
            }
            .buttonStyle(.plain)
            .contextMenu {
                if model.isGroupSpaceClosed(space) {
                    closedGroupContextMenu(for: space)
                } else {
                    openGroupContextMenu(for: space)
                }
            }
            .circularChatSwipeActions(
                rowID: "group:\(space.id)",
                activeRowID: $activeSwipeRowID,
                leading: groupLeadingCircularActions(for: space),
                trailing: groupTrailingCircularActions(for: space)
            )
            .accessibilityAction(named: groupIsPinned(space) ? "Unpin group" : "Pin group") {
                toggleGroupPinned(space)
            }
            .accessibilityAction(named: "Mark group as read") {
                Task { await model.markGroupSpaceRead(space) }
            }
            .accessibilityAction(named: groupIsMuted(space) ? "Unmute group" : "Mute group") {
                toggleGroupMuted(space)
            }
            .accessibilityAction(named: "Archive group") {
                Task { _ = await model.archiveGroupSpace(space) }
            }
            .accessibilityHint("Double-tap to show channels. Touch and hold to create a channel or manage the group.")
            .chatHomeRow(separatorLeading: 71)
        case let .groupSession(session):
            sessionActionRow(for: session) {
                GroupSessionRow(
                    session: session,
                    isPinned: model.pinnedSessionIds.contains(session.sessionId),
                    isMuted: model.mutedSessionIds.contains(session.sessionId),
                    isClosed: model.isConversationClosed(session)
                )
            }
        }
    }

    @ViewBuilder
    private func closedGroupContextMenu(for space: GroupSpaceSummary) -> some View {
        Button {
            toggleGroupPinned(space)
        } label: {
            Label(
                groupIsPinned(space) ? "Unpin group" : "Pin group",
                systemImage: groupIsPinned(space) ? "pin.slash" : "pin"
            )
        }
        Divider()
        Button(role: .destructive) {
            closedDeleteTarget = .group(space)
        } label: {
            Label("Delete chat", systemImage: "trash")
        }
    }

    @ViewBuilder
    private func openGroupContextMenu(for space: GroupSpaceSummary) -> some View {
        Button {
            channelCreationSpace = space
        } label: {
            Label("Create channel", systemImage: "plus")
        }
        Button {
            groupManagementPresentation = GroupManagementPresentation(
                space: space,
                startsInInviteMode: false
            )
        } label: {
            Label("Manage group", systemImage: "person.2")
        }
        Button {
            groupManagementPresentation = GroupManagementPresentation(
                space: space,
                startsInInviteMode: true
            )
        } label: {
            Label("Invite people", systemImage: "person.badge.plus")
        }
        Button {
            Task { await model.markGroupSpaceRead(space) }
        } label: {
            Label("Mark as read", systemImage: "checkmark.circle")
        }
        Divider()
        Button {
            toggleGroupPinned(space)
        } label: {
            Label(
                groupIsPinned(space) ? "Unpin group" : "Pin group",
                systemImage: groupIsPinned(space) ? "pin.slash" : "pin"
            )
        }
        Button {
            toggleGroupMuted(space)
        } label: {
            Label(
                groupIsMuted(space) ? "Unmute group" : "Mute group",
                systemImage: groupIsMuted(space) ? "bell" : "bell.slash"
            )
        }
        Button {
            Task { _ = await model.archiveGroupSpace(space) }
        } label: {
            Label("Archive group", systemImage: "archivebox")
        }
    }

    private var agentPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "agent-chat-refresh",
            refreshState: pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
            if model.isPreviewMode && ProcessInfo.processInfo.arguments.contains("--preview-projects") {
                Text("Design preview · Demo data").font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 16)
            }
            if let error = model.projectError {
                Text(error).font(.footnote).foregroundStyle(KordiTheme.destructiveText).padding(.horizontal, 16)
            }
            PersonalAgentSection(searchQuery: searchQuery, isCollapsed: sectionCollapsedBinding("personal-agent")) { if !dismissActiveSwipeActions() { openConversation($0) } }
            projectSessionList
            if agentSessions.isEmpty && model.projectDevices.flatMap(\.projects).isEmpty && model.personalAgentRows(searchText: searchQuery).isEmpty {
                ContentUnavailableView(
                    searchQuery.isEmpty ? "No agent sessions yet" : "No chats found",
                    systemImage: searchQuery.isEmpty ? "sparkles" : "magnifyingglass",
                    description: Text(searchQuery.isEmpty ? "Use + to start a session with an available agent." : "Try another agent, session, owner, or message.")
                )
                .frame(maxWidth: .infinity, minHeight: 360)
            }
        }
        .accessibilityLabel("Agent chats")
    }

    private var projectSessionList: some View {
        let sections = ChatProjectSections.build(conversations: model.projectConversations, devices: model.projectDevices, search: searchQuery, collapsedForks: collapsedAgentForkParentIds, pinned: model.pinnedSessionIds)
        return Group {
            if let pinned = sections.first(where: { $0.id == "pinned" }) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Pinned")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 44 : 32, alignment: .leading)
                        .padding(.horizontal, 16)
                    ForEach(pinned.sessions) { agentSessionActionRow($0) }
                }
            }
            HStack(spacing: 0) {
                agentSectionToggle("Projects", id: "projects")
                Button {
                    projectPicker = .newProject
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 44, height: dynamicTypeSize.isAccessibilitySize ? 44 : 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("New project")
                .padding(.trailing, 6)
            }
            if !collapsedProjectIDs.contains("projects") || !searchQuery.isEmpty {
                ForEach(sections.filter { $0.project != nil }) { section in
                    projectSessionSection(section)
                }
            }
            if let recents = sections.first(where: { $0.id == "recents" }) {
                projectSessionSection(recents)
            }
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func sectionCollapsedBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { collapsedProjectIDs.contains(id) },
            set: { if $0 { collapsedProjectIDs.insert(id) } else { collapsedProjectIDs.remove(id) } }
        )
    }

    private func agentSectionToggle(_ title: String, id: String) -> some View {
        Button {
            if !collapsedProjectIDs.insert(id).inserted { collapsedProjectIDs.remove(id) }
        } label: {
            HStack(spacing: 7) {
                Text(title)
                Image(systemName: collapsedProjectIDs.contains(id) ? "chevron.right" : "chevron.down")
                    .font(.caption2)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 44 : 32, alignment: .leading)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(collapsedProjectIDs.contains(id) ? "Collapsed" : "Expanded")
    }

    private func projectSessionSection(_ section: ChatProjectSessionSection) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let project = section.project {
                ChatProjectSectionHeader(section: section, project: project, isCollapsed: sectionCollapsedBinding(section.id), activeSwipeRowID: $activeSwipeRowID)
            } else {
                agentSectionToggle("Recents", id: section.id)
            }
            if !collapsedProjectIDs.contains(section.id) || !searchQuery.isEmpty {
                ForEach(section.sessions) { item in
                    agentSessionActionRow(item, nested: section.project != nil)
                        .padding(.leading, section.project == nil ? 0 : 28)
                }
            }
        }
    }

    private func destination(for conversation: ConversationSummary) -> some View {
        sessionActionRow(for: conversation) {
            ConversationRow(
                conversation: conversation,
                isPinned: model.pinnedSessionIds.contains(conversation.sessionId),
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        }
    }

    private func sessionActionRow<Content: View>(
        for conversation: ConversationSummary,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Button {
            guard !dismissActiveSwipeActions() else { return }
            openConversation(conversation)
        } label: {
            content()
        }
        .buttonStyle(.plain)
        .contextMenu {
            sessionContextMenu(for: conversation)
        }
        .circularChatSwipeActions(
            rowID: conversation.sessionId,
            activeRowID: $activeSwipeRowID,
            leading: sessionLeadingCircularActions(for: conversation),
            trailing: sessionTrailingCircularActions(for: conversation)
        )
        .accessibilityAction(named: model.pinnedSessionIds.contains(conversation.sessionId) ? "Unpin" : "Pin") {
            togglePinned(conversation)
        }
        .accessibilityAction(named: model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications") {
            toggleMuted(conversation)
        }
        .accessibilityAction(named: conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread") {
            toggleUnread(conversation)
        }
        .accessibilityAction(named: "Archive") {
            Task { _ = await model.archiveConversation(conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            if model.isConversationClosed(conversation) {
                closedDeleteTarget = model.closedChatDeleteTarget(for: conversation)
            } else {
                requestDelete(conversation)
            }
        }
        .accessibilityHint("Double-tap to open. Swipe right to pin. Swipe left to mute, delete, or archive.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func agentSessionActionRow(_ item: AgentSessionListItem, nested: Bool = false) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) {
                    agentSessionButton(item, nested: nested)
                    if item.childCount > 0 {
                        agentForkButton(item)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    agentSessionButton(item, nested: nested, showsMetadata: false)
                    if item.childCount > 0 {
                        agentForkButton(item)
                    }
                    Button {
                        guard !dismissActiveSwipeActions() else { return }
                        openConversation(item.conversation)
                    } label: {
                        AgentSessionMetadata(
                            conversation: item.conversation,
                            compact: true,
                            nested: nested,
                            isMuted: model.mutedSessionIds.contains(item.conversation.sessionId)
                        )
                        .padding(.top, 4)
                        .frame(minHeight: nested ? 56 : 44, alignment: .topTrailing)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // The main session button already announces the complete summary.
                    .accessibilityHidden(true)
                }
            }
        }
        .contextMenu {
            sessionContextMenu(for: item.conversation)
        }
        .circularChatSwipeActions(
            rowID: item.conversation.sessionId,
            activeRowID: $activeSwipeRowID,
            leading: sessionLeadingCircularActions(for: item.conversation),
            trailing: sessionTrailingCircularActions(for: item.conversation)
        )
        .accessibilityAction(named: model.pinnedSessionIds.contains(item.conversation.sessionId) ? "Unpin" : "Pin") {
            togglePinned(item.conversation)
        }
        .accessibilityAction(named: model.mutedSessionIds.contains(item.conversation.sessionId) ? "Unmute" : "Mute notifications") {
            toggleMuted(item.conversation)
        }
        .accessibilityAction(named: item.conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread") {
            toggleUnread(item.conversation)
        }
        .accessibilityAction(named: "Archive") {
            Task { _ = await model.archiveConversation(item.conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            requestDelete(item.conversation)
        }
        .accessibilityHint("Double-tap to open. Swipe right to pin. Swipe left to mute, delete, or archive.")
        .chatHomeRow(separatorLeading: 16, verticalPadding: 0)
    }

    private func agentSessionButton(_ item: AgentSessionListItem, nested: Bool = false, showsMetadata: Bool = true) -> some View {
        Button {
            guard !dismissActiveSwipeActions() else { return }
            openConversation(item.conversation)
        } label: {
            AgentSessionRow(
                conversation: item.conversation,
                compact: true,
                nested: nested,
                isFork: item.isFork,
                isPinned: model.pinnedSessionIds.contains(item.conversation.sessionId),
                isMuted: model.mutedSessionIds.contains(item.conversation.sessionId),
                showsMetadata: showsMetadata
            )
                .padding(.leading, CGFloat(item.depth) * 16)
        }
        .buttonStyle(.plain)
    }

    private func agentForkButton(_ item: AgentSessionListItem) -> some View {
        Button {
            guard !dismissActiveSwipeActions() else { return }
            toggleAgentForks(for: item.conversation)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                Text(dynamicTypeSize.isAccessibilitySize
                    ? (item.childCount == 1 ? "1 fork" : "\(item.childCount) forks")
                    : String(item.childCount))
                Image(systemName: "chevron.down")
                    .rotationEffect(.degrees(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? -90 : 0))
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 56)
            .frame(minHeight: 44)
            .padding(.horizontal, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? "Show forks" : "Hide forks")
    }

    private func sessionLeadingCircularActions(
        for conversation: ConversationSummary
    ) -> [ChatCircularSwipeAction] {
        let isPinned = model.pinnedSessionIds.contains(conversation.sessionId)
        let isUnread = conversation.hasUnreadAttention
        let pin = ChatCircularSwipeAction(id: "pin", label: isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin", color: .green) {
            togglePinned(conversation)
        }
        if model.isConversationClosed(conversation) { return [pin] }
        return [
            pin,
            ChatCircularSwipeAction(id: "unread", label: isUnread ? "Mark as read" : "Mark as unread", systemImage: isUnread ? "checkmark.message" : "envelope.badge", color: chatTheme.accent) {
                toggleUnread(conversation)
            }
        ]
    }

    private func sessionTrailingCircularActions(
        for conversation: ConversationSummary
    ) -> [ChatCircularSwipeAction] {
        let isMuted = model.mutedSessionIds.contains(conversation.sessionId)
        if model.isConversationClosed(conversation) {
            return [ChatCircularSwipeAction(id: "delete", label: "Delete chat", systemImage: "trash", color: .red, role: .destructive) {
                closedDeleteTarget = model.closedChatDeleteTarget(for: conversation)
            }]
        }
        return [
            ChatCircularSwipeAction(id: "archive", label: "Archive", systemImage: "archivebox", color: .gray) {
                Task { _ = await model.archiveConversation(conversation) }
            },
            ChatCircularSwipeAction(id: "delete", label: "Delete", systemImage: "trash", color: .red, role: .destructive) {
                requestDelete(conversation)
            },
            ChatCircularSwipeAction(id: "mute", label: isMuted ? "Unmute" : "Mute", systemImage: isMuted ? "bell" : "bell.slash", color: .orange) {
                toggleMuted(conversation)
            }
        ]
    }

    private func groupLeadingCircularActions(
        for space: GroupSpaceSummary
    ) -> [ChatCircularSwipeAction] {
        let pin = ChatCircularSwipeAction(id: "pin", label: groupIsPinned(space) ? "Unpin group" : "Pin group", systemImage: groupIsPinned(space) ? "pin.slash" : "pin", color: .green) {
            toggleGroupPinned(space)
        }
        if model.isGroupSpaceClosed(space) { return [pin] }
        return [
            pin,
            ChatCircularSwipeAction(id: "read", label: "Mark group as read", systemImage: "checkmark.message", color: chatTheme.accent) {
                Task { await model.markGroupSpaceRead(space) }
            }
        ]
    }

    private func groupTrailingCircularActions(
        for space: GroupSpaceSummary
    ) -> [ChatCircularSwipeAction] {
        if model.isGroupSpaceClosed(space) {
            return [ChatCircularSwipeAction(id: "delete", label: "Delete chat", systemImage: "trash", color: .red, role: .destructive) {
                closedDeleteTarget = .group(space)
            }]
        }
        return [
            ChatCircularSwipeAction(id: "archive", label: "Archive group", systemImage: "archivebox", color: .gray) {
                Task { _ = await model.archiveGroupSpace(space) }
            },
            ChatCircularSwipeAction(id: "mute", label: groupIsMuted(space) ? "Unmute group" : "Mute group", systemImage: groupIsMuted(space) ? "bell" : "bell.slash", color: .orange) {
                toggleGroupMuted(space)
            }
        ]
    }

    private func dismissActiveSwipeActions() -> Bool {
        guard activeSwipeRowID != nil else { return false }
        withAnimation(.interactiveSpring(response: 0.24, dampingFraction: 0.9)) {
            activeSwipeRowID = nil
        }
        return true
    }

    @ViewBuilder
    private func sessionContextMenu(for conversation: ConversationSummary) -> some View {
        if model.isConversationClosed(conversation) {
            Button {
                togglePinned(conversation)
            } label: {
                Label(model.pinnedSessionIds.contains(conversation.sessionId) ? "Unpin" : "Pin", systemImage: "pin")
            }
            Divider()
            Button(role: .destructive) {
                closedDeleteTarget = model.closedChatDeleteTarget(for: conversation)
            } label: {
                Label("Delete chat", systemImage: "trash")
            }
        } else {
            openSessionContextMenu(for: conversation)
        }
    }

    @ViewBuilder
    private func openSessionContextMenu(for conversation: ConversationSummary) -> some View {
        if model.canChooseProject(conversation) {
            Button("Move to project", systemImage: "folder") { projectPicker = .move(conversation) }
                .disabled(conversation.agentActivity == .replying)
        }
        if conversation.kind != .group
            || conversation.canManageGroup(accountId: model.account?.accountId) {
            Button {
                renameDraft = conversation.displayName
                renameTarget = conversation
            } label: {
                Label(conversation.kind == .group ? "Rename channel" : "Rename", systemImage: "pencil")
            }
        }
        Button {
            toggleUnread(conversation)
        } label: {
            Label(
                conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread",
                systemImage: conversation.hasUnreadAttention ? "checkmark.circle" : "envelope.badge"
            )
        }
        Divider()
        Button {
            togglePinned(conversation)
        } label: {
            Label(
                model.pinnedSessionIds.contains(conversation.sessionId) ? "Unpin" : "Pin",
                systemImage: "pin"
            )
        }
        Button {
            toggleMuted(conversation)
        } label: {
            Label(
                model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications",
                systemImage: model.mutedSessionIds.contains(conversation.sessionId) ? "bell" : "bell.slash"
            )
        }
        Button {
            Task { _ = await model.archiveConversation(conversation) }
        } label: {
            Label("Archive", systemImage: "archivebox")
        }
        .accessibilityIdentifier("archive-session")
        Divider()
        Button(role: .destructive) {
            requestDelete(conversation)
        } label: {
            Label("Delete", systemImage: "trash")
        }
        if let space = dissolvableSpace(for: conversation) {
            Button(role: .destructive) {
                channelDissolveTarget = ChannelDissolveTarget(conversation: conversation, space: space)
            } label: {
                Label("Close channel", systemImage: "circle.slash")
            }
        }
    }

    /// The group whose admin may close this channel; never its first channel.
    private func dissolvableSpace(for conversation: ConversationSummary) -> GroupSpaceSummary? {
        guard conversation.kind == .group, !model.isConversationClosed(conversation) else { return nil }
        return GroupSpaceCatalog.build(conversations: model.conversations, ownAccountId: model.account?.accountId ?? "")
            .first { space in
                space.sessions.contains { $0.sessionId == conversation.sessionId }
                    && model.canDissolveChannel(conversation, in: space)
            }
    }

    private func togglePinned(_ conversation: ConversationSummary) {
        let pinned = !model.pinnedSessionIds.contains(conversation.sessionId)
        Task { _ = await model.setConversationPinned(conversation, pinned: pinned) }
    }

    private func toggleMuted(_ conversation: ConversationSummary) {
        let muted = !model.mutedSessionIds.contains(conversation.sessionId)
        Task { _ = await model.setConversationMuted(conversation, muted: muted) }
    }

    private func toggleUnread(_ conversation: ConversationSummary) {
        Task {
            if conversation.hasUnreadAttention {
                await model.markConversationRead(conversation)
            } else {
                _ = await model.setConversationUnread(conversation, unread: true)
            }
        }
    }

    private func requestDelete(_ conversation: ConversationSummary) {
        guard deleteTarget == nil else { return }
        deleteTarget = conversation
    }

    private func toggleGroupPinned(_ space: GroupSpaceSummary) {
        Task { _ = await model.setGroupSpacePinned(space, pinned: !groupIsPinned(space)) }
    }

    private func toggleGroupMuted(_ space: GroupSpaceSummary) {
        Task { _ = await model.setGroupSpaceMuted(space, muted: !groupIsMuted(space)) }
    }

    private func groupIsPinned(_ space: GroupSpaceSummary) -> Bool {
        model.pinnedGroupSpaceIds.contains(space.preferenceId)
    }

    private func groupIsMuted(_ space: GroupSpaceSummary) -> Bool {
        !space.sessions.isEmpty
            && space.sessions.allSatisfy { model.mutedSessionIds.contains($0.sessionId) }
    }

    private func groupIsExpanded(_ space: GroupSpaceSummary) -> Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-expanded-groups")
            || !searchQuery.isEmpty
            || expandedGroupSpaceIds.contains(space.id)
    }

    private func toggleGroupSpace(_ space: GroupSpaceSummary) {
        let willExpand = !expandedGroupSpaceIds.contains(space.id)
        withAnimation(reduceMotion ? nil : GroupChannelDisclosureMotion.animation) {
            if willExpand {
                expandedGroupSpaceIds.insert(space.id)
            } else {
                expandedGroupSpaceIds.remove(space.id)
            }
        }
    }

    private func toggleAgentForks(for conversation: ConversationSummary) {
        withAnimation(.snappy(duration: 0.22)) {
            if collapsedAgentForkParentIds.contains(conversation.sessionId) {
                collapsedAgentForkParentIds.remove(conversation.sessionId)
            } else {
                collapsedAgentForkParentIds.insert(conversation.sessionId)
            }
        }
    }

    private func openConversation(_ conversation: ConversationSummary) {
        if let onOpenConversation {
            onOpenConversation(conversation)
        } else {
            composedConversation = conversation
        }
    }

}

struct ArchivedChatsView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: AppModel
    let channel: ChatChannel
    private let onOpenConversation: ((ConversationSummary) -> Void)?
    @State private var deleteTarget: ConversationSummary?
    @State private var selectedConversation: ConversationSummary?
    @State private var expandedGroupSpaceIds = Set<String>()
    @State private var activeSwipeRowID: String?

    init(
        channel: ChatChannel,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil
    ) {
        self.channel = channel
        self.onOpenConversation = onOpenConversation
    }

    private var conversations: [ConversationSummary] {
        model.archivedConversations.filter {
            channel == .agent ? $0.kind == .agent : $0.kind != .agent
        }
    }

    private var groupSpaces: [GroupSpaceSummary] {
        GroupSpaceCatalog.build(
            conversations: conversations,
            ownAccountId: model.account?.accountId ?? ""
        )
    }

    private var items: [ContactListItem] {
        let individualConversations = conversations
            .filter { channel == .agent ? $0.kind == .agent : $0.kind == .person }
            .map(ContactListItem.conversation)
        let groups = channel == .agent ? [] : groupSpaces.map(ContactListItem.group)
        return (individualConversations + groups).sorted {
            ChatListOrdering.precedes(
                id: $0.id,
                displayName: $0.displayName,
                lastActivityAt: $0.lastActivityAt,
                before: $1.id,
                displayName: $1.displayName,
                lastActivityAt: $1.lastActivityAt
            )
        }
    }

    private var rows: [ContactListRow] {
        items.flatMap { item -> [ContactListRow] in
            switch item {
            case let .conversation(conversation):
                return [.conversation(conversation)]
            case let .group(space):
                return [.group(space)] + (groupIsExpanded(space)
                    ? space.sessions.map { .groupSession($0) }
                    : [])
            }
        }
    }

    var body: some View {
        List {
            ForEach(rows) { row in
                archivedRow(row)
                    .transition(.identity)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archived Chats")
        .navigationBarTitleDisplayMode(.inline)
        .stableNavigationDestination(item: $selectedConversation) { conversation in
            ConversationView(conversation: conversation)
        }
        .overlay {
            if conversations.isEmpty {
                ContentUnavailableView(
                    "No Archived Chats",
                    systemImage: "archivebox",
                    description: Text("Chats you archive appear here.")
                )
            }
        }
        .alert(
            "Delete this chat from your list?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete chat", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await model.deleteConversation(target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("This does not delete it for other participants. It will return only when a new visible message arrives.")
        }
    }

    @ViewBuilder
    private func archivedRow(_ row: ContactListRow) -> some View {
        switch row {
        case let .conversation(conversation), let .groupSession(conversation):
            archivedSessionActionRow(conversation)
        case let .group(space):
            archivedGroupActionRow(space)
        }
    }

    private func archivedSessionActionRow(_ conversation: ConversationSummary) -> some View {
        Button {
            guard !dismissActiveSwipeActions() else { return }
            if let onOpenConversation {
                onOpenConversation(conversation)
            } else {
                selectedConversation = conversation
            }
        } label: {
            archivedConversationRow(conversation)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                Task { _ = await model.restoreConversation(conversation) }
            } label: {
                Label("Restore", systemImage: "archivebox.fill")
            }
            Button {
                let muted = !model.mutedSessionIds.contains(conversation.sessionId)
                Task { _ = await model.setConversationMuted(conversation, muted: muted) }
            } label: {
                Label(
                    model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications",
                    systemImage: model.mutedSessionIds.contains(conversation.sessionId) ? "bell" : "bell.slash"
                )
            }
            Button(role: .destructive) {
                requestDelete(conversation)
            } label: {
                Label("Delete chat", systemImage: "trash")
            }
        }
        .circularChatSwipeActions(
            rowID: conversation.sessionId,
            activeRowID: $activeSwipeRowID,
            trailing: [
                ChatCircularSwipeAction(id: "restore", label: "Restore", systemImage: "archivebox.fill", color: .blue) {
                    Task { _ = await model.restoreConversation(conversation) }
                },
                ChatCircularSwipeAction(id: "delete", label: "Delete", systemImage: "trash", color: .red, role: .destructive) {
                    requestDelete(conversation)
                }
            ]
        )
        .accessibilityAction(named: "Restore") {
            Task { _ = await model.restoreConversation(conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            requestDelete(conversation)
        }
        .accessibilityHint("Double-tap to open this archived chat.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func archivedGroupActionRow(_ space: GroupSpaceSummary) -> some View {
        Button {
            guard !dismissActiveSwipeActions() else { return }
            toggleGroupSpace(space)
        } label: {
            GroupSpaceRow(
                space: space,
                isExpanded: groupIsExpanded(space),
                mutedSessionIds: model.mutedSessionIds,
                isPinned: false,
                isMuted: groupIsMuted(space),
                isClosed: model.isGroupSpaceClosed(space)
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                Task { _ = await model.restoreGroupSpace(space) }
            } label: {
                Label("Restore group", systemImage: "archivebox.fill")
            }
            Button {
                Task { _ = await model.setGroupSpaceMuted(space, muted: !groupIsMuted(space)) }
            } label: {
                Label(
                    groupIsMuted(space) ? "Unmute group" : "Mute group",
                    systemImage: groupIsMuted(space) ? "bell" : "bell.slash"
                )
            }
        }
        .circularChatSwipeActions(
            rowID: "group:\(space.id)",
            activeRowID: $activeSwipeRowID,
            trailing: [
                ChatCircularSwipeAction(id: "restore", label: "Restore group", systemImage: "archivebox.fill", color: .blue) {
                    Task { _ = await model.restoreGroupSpace(space) }
                }
            ]
        )
        .accessibilityAction(named: "Restore group") {
            Task { _ = await model.restoreGroupSpace(space) }
        }
        .accessibilityHint("Double-tap to show archived sessions.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func requestDelete(_ conversation: ConversationSummary) {
        guard deleteTarget == nil else { return }
        deleteTarget = conversation
    }

    private func dismissActiveSwipeActions() -> Bool {
        guard activeSwipeRowID != nil else { return false }
        withAnimation(.interactiveSpring(response: 0.24, dampingFraction: 0.9)) {
            activeSwipeRowID = nil
        }
        return true
    }

    private func groupIsMuted(_ space: GroupSpaceSummary) -> Bool {
        !space.sessions.isEmpty
            && space.sessions.allSatisfy { model.mutedSessionIds.contains($0.sessionId) }
    }

    private func groupIsExpanded(_ space: GroupSpaceSummary) -> Bool {
        expandedGroupSpaceIds.contains(space.id)
    }

    private func toggleGroupSpace(_ space: GroupSpaceSummary) {
        withAnimation(reduceMotion ? nil : GroupChannelDisclosureMotion.animation) {
            if groupIsExpanded(space) {
                expandedGroupSpaceIds.remove(space.id)
            } else {
                expandedGroupSpaceIds.insert(space.id)
            }
        }
    }

    @ViewBuilder
    private func archivedConversationRow(_ conversation: ConversationSummary) -> some View {
        switch conversation.kind {
        case .person:
            ConversationRow(
                conversation: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        case .group:
            GroupSessionRow(
                session: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId),
                isClosed: model.isConversationClosed(conversation)
            )
        case .agent:
            AgentSessionRow(
                conversation: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        }
    }
}

enum ChatHomeSearch {
    static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func matches(
        _ conversation: ConversationSummary,
        contact: CloudContact? = nil,
        query: String
    ) -> Bool {
        let query = normalized(query)
        guard !query.isEmpty else { return true }
        return [
            conversation.displayName,
            conversation.lastMessage,
            conversation.ownerDisplayName,
            conversation.agentDisplayName,
            contact?.preferredName,
            contact?.kordiId
        ]
        .compactMap { $0?.nonEmpty }
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }

    static func matches(_ space: GroupSpaceSummary, query: String) -> Bool {
        let query = normalized(query)
        guard !query.isEmpty else { return true }
        if space.displayName.localizedCaseInsensitiveContains(query)
            || space.lastMessage.localizedCaseInsensitiveContains(query)
            || space.participants.contains(where: {
                $0.displayName.localizedCaseInsensitiveContains(query)
            }) {
            return true
        }
        return space.sessions.contains {
            matches($0, query: query)
        }
    }
}

enum ChatPullToRefreshBehavior {
    static let triggerDistance: CGFloat = 68

    static func pullDistance(contentOffsetY: CGFloat, contentInsetTop: CGFloat) -> CGFloat {
        max(0, -(contentOffsetY + contentInsetTop))
    }

    static func shouldStart(distance: CGFloat, isRefreshing: Bool) -> Bool {
        !isRefreshing && distance >= triggerDistance
    }
}

private struct ChatPullToRefreshScrollView<Content: View>: View {
    let coordinateSpaceName: String
    let onRefresh: () async -> Void
    let content: Content
    // The list does not observe pull progress; only the toolbar mark does.
    let refreshState: ChatPullRefreshState

    init(
        coordinateSpaceName: String,
        refreshState: ChatPullRefreshState,
        onRefresh: @escaping () async -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.coordinateSpaceName = coordinateSpaceName
        self.refreshState = refreshState
        self.onRefresh = onRefresh
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 18.0, *) {
            list(includeLegacyOffsetProbe: false)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    ChatPullToRefreshBehavior.pullDistance(
                        contentOffsetY: geometry.contentOffset.y,
                        contentInsetTop: geometry.contentInsets.top
                    )
                } action: { _, distance in
                    refreshState.updatePullDistance(distance)
                    startRefreshIfSettled()
                }
                .onScrollPhaseChange { oldPhase, newPhase in
                    refreshState.setScrollIdle(newPhase == .idle)
                    if oldPhase == .interacting, newPhase != .interacting {
                        finishPullGesture()
                    }
                    startRefreshIfSettled()
                }
        } else {
            list(includeLegacyOffsetProbe: true)
                .coordinateSpace(.named(coordinateSpaceName))
                .onPreferenceChange(ChatPullOffsetPreferenceKey.self) { offset in
                    refreshState.updatePullDistance(max(0, offset))
                    startRefreshIfSettled()
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8)
                        .onChanged { _ in refreshState.setScrollIdle(false) }
                        .onEnded { _ in
                            refreshState.setScrollIdle(true)
                            finishPullGesture()
                        }
                )
        }
    }

    private func list(includeLegacyOffsetProbe: Bool) -> some View {
        List {
            Section {
                if includeLegacyOffsetProbe {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: ChatPullOffsetPreferenceKey.self,
                            value: proxy.frame(in: .named(coordinateSpaceName)).minY
                        )
                    }
                    .frame(height: 0)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .accessibilityHidden(true)
                }

                content
                    .listRowSeparator(.hidden)
            }
            // Rows provide their own dividers; empty states need no trailing rule.
            .listSectionSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
        .environment(\.defaultMinListRowHeight, 0)
        .onDisappear { refreshState.cancelPendingRefresh() }
    }

    private func finishPullGesture() {
        guard refreshState.beginRefresh() else { return }
        startRefreshIfSettled()
    }

    private func startRefreshIfSettled() {
        guard refreshState.takePendingRefresh() else { return }
        Task {
            await onRefresh()
            // Do not give refreshed rows an animation transaction. The toolbar
            // owns its own motion, independently of list content and identity.
            refreshState.finishRefresh()
        }
    }
}

private struct ChatPullOffsetPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct ChatCircularSwipeAction: Identifiable {
    let id: String
    let label: String
    let systemImage: String
    let color: Color
    let role: ButtonRole?
    let action: () -> Void

    init(
        id: String,
        label: String,
        systemImage: String,
        color: Color,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) {
        self.id = id
        self.label = label
        self.systemImage = systemImage
        self.color = color
        self.role = role
        self.action = action
    }
}

private struct ChatCircularSwipeActionsModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rowID: String
    @Binding var activeRowID: String?
    let leading: [ChatCircularSwipeAction]
    let trailing: [ChatCircularSwipeAction]
    @State private var restingOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var swipeSession: ChatRowSwipeSession?

    private let actionDiameter: CGFloat = 44
    private let actionSpacing: CGFloat = 8
    private let edgePadding: CGFloat = 16
    private let minimumActionScale: CGFloat = 0.85

    private var leadingWidth: CGFloat { actionWidth(for: leading) }
    private var trailingWidth: CGFloat { actionWidth(for: trailing) }
    private var displayedOffset: CGFloat {
        let offset = restingOffset + dragOffset
        return swipeSession?.limitedOffset(offset, leadingWidth: leadingWidth, trailingWidth: trailingWidth)
            ?? min(leadingWidth, max(-trailingWidth, offset))
    }

    func body(content: Content) -> some View {
        ZStack {
            HStack(spacing: 0) {
                if !leading.isEmpty { actionButtons(leading, edge: .leading) }
                Spacer(minLength: 0)
                if !trailing.isEmpty { actionButtons(trailing, edge: .trailing) }
            }

            content
                .background(Color(uiColor: .systemBackground))
                .offset(x: displayedOffset)
                .chatRowSwipeGesture(onChanged: updateSwipe, onEnded: finishSwipe, onCancelled: cancelSwipe)
                .zIndex(1)
        }
        .clipped()
        .overlay {
            GeometryReader { proxy in
                if restingOffset != 0, activeRowID == rowID {
                    HStack(spacing: 0) {
                        if restingOffset > 0 {
                            Spacer(minLength: 0)
                        }
                        Color.clear
                            .contentShape(Rectangle())
                            .frame(width: max(0, proxy.size.width - abs(restingOffset)))
                            .onTapGesture { close() }
                            .chatRowSwipeGesture(onChanged: updateSwipe, onEnded: finishSwipe, onCancelled: cancelSwipe)
                        if restingOffset < 0 {
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
        }
        .onChange(of: activeRowID) {
            if activeRowID != rowID, restingOffset != 0 || dragOffset != 0 {
                withAnimation(ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)) {
                    restingOffset = 0
                    dragOffset = 0
                    swipeSession = nil
                }
            }
        }
    }

    private func updateSwipe(_ translation: CGFloat) {
        withTransaction(Transaction(animation: nil)) {
            if activeRowID != rowID {
                activeRowID = rowID
                restingOffset = 0
            }
            if swipeSession == nil {
                swipeSession = ChatRowSwipeSession(restingOffset: restingOffset, firstTranslation: translation)
            }
            dragOffset = translation
        }
    }

    private func finishSwipe(_ projectedTranslation: CGFloat) {
        guard activeRowID == rowID else { cancelSwipe(); return }
        let projectedOffset = swipeSession?.limitedOffset(
            restingOffset + projectedTranslation, leadingWidth: leadingWidth, trailingWidth: trailingWidth
        ) ?? 0
        let destination: CGFloat
        if projectedOffset > max(36, leadingWidth / 2), !leading.isEmpty {
            destination = leadingWidth
        } else if projectedOffset < -max(36, trailingWidth / 2), !trailing.isEmpty {
            destination = -trailingWidth
        } else {
            destination = 0
        }
        withAnimation(ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)) {
            dragOffset = 0
            swipeSession = nil
            restingOffset = destination
            activeRowID = destination == 0 ? nil : rowID
        }
    }

    private func cancelSwipe() {
        withAnimation(ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)) {
            dragOffset = 0
            swipeSession = nil
            if restingOffset == 0, activeRowID == rowID { activeRowID = nil }
        }
    }

    private func actionWidth(for actions: [ChatCircularSwipeAction]) -> CGFloat {
        guard !actions.isEmpty else { return 0 }
        return edgePadding * 2 + CGFloat(actions.count) * actionDiameter
            + CGFloat(actions.count - 1) * actionSpacing
    }

    private func close() {
        withAnimation(ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)) {
            restingOffset = 0
            dragOffset = 0
            swipeSession = nil
            activeRowID = nil
        }
    }

    private func perform(_ action: ChatCircularSwipeAction) {
        close()
        action.action()
    }

    private func actionButtons(
        _ actions: [ChatCircularSwipeAction],
        edge: HorizontalEdge
    ) -> some View {
        HStack(spacing: actionSpacing) {
            ForEach(actions) { action in
                let index = actions.firstIndex(where: { $0.id == action.id }) ?? 0
                let progress = actionRevealProgress(
                    index: index,
                    count: actions.count,
                    edge: edge
                )
                Button(role: action.role) {
                    perform(action)
                } label: {
                    Image(systemName: action.systemImage)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: actionDiameter, height: actionDiameter)
                        .background(action.color, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(action.label)
                .scaleEffect(reduceMotion ? 1 : minimumActionScale + (1 - minimumActionScale) * progress)
                .opacity(progress)
                .allowsHitTesting(activeRowID == rowID && progress > 0.9)
            }
        }
        .padding(edge == .leading ? .leading : .trailing, edgePadding)
        .accessibilityHidden(activeRowID != rowID || (edge == .leading ? displayedOffset <= 0 : displayedOffset >= 0))
    }

    private func actionRevealProgress(
        index: Int,
        count: Int,
        edge: HorizontalEdge
    ) -> CGFloat {
        let distanceFromEdge = edge == .leading ? index : count - 1 - index
        let fullRevealDistance = edgePadding + actionDiameter
            + CGFloat(distanceFromEdge) * (actionDiameter + actionSpacing)
        let offset = edge == .leading ? max(0, displayedOffset) : max(0, -displayedOffset)
        return ChatRowSwipeMotion.actionProgress(
            offset: offset, fullRevealDistance: fullRevealDistance,
            edgePadding: edgePadding, diameter: actionDiameter
        )
    }
}

extension View {
    func circularChatSwipeActions(
        rowID: String,
        activeRowID: Binding<String?>,
        leading: [ChatCircularSwipeAction] = [],
        trailing: [ChatCircularSwipeAction] = []
    ) -> some View {
        modifier(ChatCircularSwipeActionsModifier(
            rowID: rowID,
            activeRowID: activeRowID,
            leading: leading,
            trailing: trailing
        ))
    }

    func chatHomeRow(separatorLeading: CGFloat, verticalPadding: CGFloat = 4) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, verticalPadding)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .overlay(alignment: .bottom) {
                ChatListSeparator()
                    .padding(.leading, separatorLeading)
            }
    }
}

private struct ChatListSeparator: View {
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle()
            .fill(Color(uiColor: .separator).opacity(0.55))
            .frame(height: 1 / displayScale)
            .accessibilityHidden(true)
    }
}

private enum ContactListItem: Identifiable {
    case conversation(ConversationSummary)
    case group(GroupSpaceSummary)

    var id: String {
        switch self {
        case let .conversation(conversation): "conversation:\(conversation.id)"
        case let .group(space): "space:\(space.id)"
        }
    }

    var displayName: String {
        switch self {
        case let .conversation(conversation): conversation.displayName
        case let .group(space): space.displayName
        }
    }

    var lastActivityAt: Date {
        switch self {
        case let .conversation(conversation): conversation.lastActivityAt
        case let .group(space): space.lastActivityAt
        }
    }

    func isPinned(
        sessionIds: Set<String>,
        groupSpaceIds: Set<String>
    ) -> Bool {
        switch self {
        case let .conversation(conversation):
            sessionIds.contains(conversation.sessionId)
        case let .group(space):
            groupSpaceIds.contains(space.preferenceId)
        }
    }
}

private enum ContactListRow: Identifiable {
    case conversation(ConversationSummary)
    case group(GroupSpaceSummary)
    case groupSession(ConversationSummary)

    var id: String {
        switch self {
        case let .conversation(conversation): "conversation:\(conversation.id)"
        case let .group(space): "space:\(space.id)"
        case let .groupSession(session): "group-session:\(session.sessionId)"
        }
    }
}

private struct ErrorBanner: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
            .accessibilityLabel("Error: \(message)")
    }
}

#Preview("Chats · Contact page") {
    NavigationStack { ChatHomeView(channel: .contact) }
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiChatTheme.classic.accent)
}

/// A channel an admin asked to dissolve, with its group.
extension View {
    /// The "Delete <name>?" confirmation for Delete chat on a closed chat.
    func closedChatDeleteConfirmation(
        _ target: Binding<ClosedChatDeleteTarget?>,
        onDeleted: @escaping (ClosedChatDeleteTarget) -> Void = { _ in }
    ) -> some View {
        modifier(ClosedChatDeleteConfirmation(target: target, onDeleted: onDeleted))
    }
}

private struct ClosedChatDeleteConfirmation: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var target: ClosedChatDeleteTarget?
    let onDeleted: (ClosedChatDeleteTarget) -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            target.map { "Delete \($0.displayName)?" } ?? "",
            isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
            titleVisibility: .visible,
            presenting: target
        ) { presented in
            Button("Delete chat", role: .destructive) {
                target = nil
                Task { if await model.deleteClosedChat(presented) { onDeleted(presented) } }
            }
            Button("Cancel", role: .cancel) { target = nil }
        } message: { _ in
            Text("It leaves your chat list. Others keep it.")
        }
    }
}

struct ChannelDissolveTarget: Identifiable {
    let conversation: ConversationSummary
    let space: GroupSpaceSummary
    var id: String { conversation.sessionId }
}
