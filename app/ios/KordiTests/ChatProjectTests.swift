import Testing
@testable import Kordi

struct ChatProjectTests {
    @Test @MainActor func staleProjectCatalogDoesNotRestoreDeletedOrArchivedChats() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try #require(model.conversations.first { $0.kind == .agent && !$0.isAgentLaunchTemplate })
        let emptySessionID = "empty-project-session"
        model.projectDevices = [.init(id: "mac", name: "My Mac", online: true, projects: [
            .init(id: "project", name: "App", sessions: [conversation.sessionId, emptySessionID]),
        ])]
        #expect(model.projectConversations.contains { $0.sessionId == emptySessionID })
        #expect(await model.archiveConversation(conversation))
        #expect(!model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(await model.restoreConversation(conversation))
        #expect(model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(await model.deleteConversation(conversation))
        #expect(!model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(model.projectConversations.contains { $0.sessionId == emptySessionID })
    }

    @Test func pinnedSessionsStayVisibleOutsideCollapsedProjectsAndRecents() {
        let pinned = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "pinned")
        let recent = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "recent")
        let device = ChatProjectDevice(id: "mac", name: "My Mac", online: true, projects: [
            .init(id: "project", name: "App", sessions: [pinned.sessionId]),
        ])
        let sections = ChatProjectSections.build(conversations: [pinned, recent], devices: [device], search: "", collapsedForks: [], pinned: [pinned.sessionId])
        #expect(sections.map(\.id) == ["pinned", "project:project", "recents"])
        #expect(sections[0].sessions.map(\.id) == [pinned.id])
        #expect(sections[1].sessions.map(\.id) == [pinned.id])
        #expect(sections[2].sessions.map(\.id) == [recent.id])
        let unassigned = ChatProjectSections.build(conversations: [pinned, recent], devices: [], search: "", collapsedForks: [], pinned: [pinned.sessionId])
        #expect(unassigned.last?.sessions.map(\.id) == [recent.id])
    }

    @Test func pinnedForkRemainsReachableAndSearchFiltersPinnedRows() {
        let parent = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "parent")
        let fork = ConversationSummary(
            id: "fork", kind: .agent, peerAccountId: "owner", agentId: parent.agentId,
            ownerDisplayName: nil, displayName: "Investigate sidebar", lastMessage: "Review navigation",
            lastActivityAt: parent.lastActivityAt, unreadCount: 0, avatarSource: nil,
            agentActivity: .ready, sessionId: "fork-session", forkedFromSessionId: parent.sessionId
        )
        let sections = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "sidebar", collapsedForks: [parent.sessionId], pinned: [fork.sessionId])
        #expect(sections.first?.id == "pinned")
        #expect(sections.first?.sessions.first?.id == fork.id)
        #expect(sections.first?.sessions.first?.depth == 0)
        #expect(sections.first?.sessions.first?.childCount == 0)
        let unmatched = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "unmatched", collapsedForks: [], pinned: [fork.sessionId])
        #expect(unmatched.isEmpty)
        let pinnedParent = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "", collapsedForks: [parent.sessionId], pinned: [parent.sessionId])
        #expect(pinnedParent.last?.id == "recents")
        #expect(pinnedParent.last?.sessions.first?.id == fork.id)
        #expect(pinnedParent.last?.sessions.first?.depth == 0)
    }

    @Test func validatesRepositoryInput() {
        #expect(ChatProjectRepositoryInput.normalize("https://github.com/example/app.git") == "example/app")
        #expect(ChatProjectRepositoryInput.normalize("git@github.com:example/app.git") == "example/app")
        for value in ["https://other.example/app/repo", "../repo", "owner/--help", "https://token@github.com/owner/repo", "owner/repo/extra"] {
            #expect(ChatProjectRepositoryInput.normalize(value) == nil)
        }
    }

    @Test func unassignedSessionsStayInRecentsAndMovedForksStayVisible() {
        let first = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "one")
        let second = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "two")
        let device = ChatProjectDevice(id: "mac", name: "My Mac", online: false, projects: [.init(id: "project", name: "App", sessions: [first.sessionId])])
        let sections = ChatProjectSections.build(conversations: [first, second], devices: [device], search: "", collapsedForks: [], pinned: [])
        #expect(sections.count == 2)
        #expect(sections[0].project?.name == "App")
        #expect(sections[0].sessions.map(\.id) == [first.id])
        #expect(sections[1].id == "recents")
        #expect(sections[1].project == nil)
        #expect(sections[1].sessions.map(\.id) == [second.id])
        let moved = ChatProjectDevice(id: "mac", name: "My Mac", online: true, projects: [.init(id: "project", name: "App", sessions: [])])
        let detached = ChatProjectSections.build(conversations: [first, second], devices: [moved], search: "", collapsedForks: [], pinned: [])
        #expect(detached[0].sessions.isEmpty)
        #expect(detached[1].sessions.count == 2)
    }

    @Test func macProfilesPublishingOneFolderShowAsOneProject() {
        let first = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "first")
        let second = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "second")
        let folder = "trust-folder"
        let devices = [
            ChatProjectDevice(id: "profile-a", name: "Studio Mac", online: false, projects: [.init(id: folder, name: "trust", sessions: [first.sessionId])]),
            ChatProjectDevice(id: "profile-b", name: "Studio Mac", online: false, projects: [.init(id: folder, name: "trust", sessions: [first.sessionId, second.sessionId])]),
            ChatProjectDevice(id: "profile-c", name: "Studio Mac", online: true, projects: [.init(id: folder, name: "kordi-trust", sessions: [])]),
            // Same name, other folder: never merged by name.
            ChatProjectDevice(id: "laptop", name: "Laptop", online: false, projects: [.init(id: "other-folder", name: "kordi-trust", sessions: [])]),
        ]
        let sections = ChatProjectSections.build(conversations: [first, second], devices: devices, search: "", collapsedForks: [], pinned: [])
        #expect(sections.map(\.id) == ["project:\(folder)", "project:other-folder"])
        let merged = sections[0]
        #expect(merged.project?.name == "kordi-trust")
        #expect(merged.project?.sessions == [first.sessionId, second.sessionId])
        #expect(Set(merged.sessions.map(\.id)) == [first.id, second.id])
        #expect(merged.devices.map(\.id) == ["profile-c", "profile-a", "profile-b"])
        #expect(merged.online)
        #expect(!merged.removable)
        #expect(!sections[1].online)
        #expect(sections[1].removable)
    }

    @Test func projectWithOnlyOfflineMacsIsRemovable() {
        let devices = [
            ChatProjectDevice(id: "profile-a", name: "Studio Mac", online: false, projects: [.init(id: "folder", name: "trust", sessions: [])]),
            ChatProjectDevice(id: "profile-b", name: "Studio Mac", online: false, projects: [.init(id: "folder", name: "trust", sessions: [])]),
        ]
        let sections = ChatProjectSections.build(conversations: [], devices: devices, search: "", collapsedForks: [], pinned: [])
        #expect(sections.count == 1)
        #expect(!sections[0].online)
        #expect(sections[0].removable)
        #expect(sections[0].devices.map(\.id) == ["profile-a", "profile-b"])
        let recents = ChatProjectSessionSection(id: "recents", project: nil, devices: [], sessions: [])
        #expect(!recents.removable)
    }

    @Test func pickerListsEachFolderOnceUnderAnOnlineMac() {
        let devices = [
            ChatProjectDevice(id: "old-profile", name: "Studio Mac", online: false, projects: [
                .init(id: "folder", name: "trust", sessions: ["one"]),
                .init(id: "only-here", name: "notes", sessions: []),
            ]),
            ChatProjectDevice(id: "gone-profile", name: "Studio Mac", online: false, projects: [.init(id: "folder", name: "trust", sessions: ["two"])]),
            ChatProjectDevice(id: "current", name: "Studio Mac", online: true, projects: [.init(id: "folder", name: "trust", sessions: [])]),
        ]
        let picker = ChatProjectGroup.pickerDevices(devices)
        #expect(picker.map(\.id) == ["old-profile", "current"])
        #expect(picker[0].projects.map(\.id) == ["only-here"])
        #expect(picker[1].projects.map(\.id) == ["folder"])
        #expect(picker[1].projects[0].sessions == ["one", "two"])
    }

    @Test @MainActor func removingAnOfflineProjectSendsItsSessionsToRecents() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try #require(model.conversations.first { $0.kind == .agent && !$0.isAgentLaunchTemplate })
        model.projectDevices = [
            .init(id: "profile-a", name: "Studio Mac", online: false, projects: [.init(id: "folder", name: "trust", sessions: [conversation.sessionId])]),
            .init(id: "profile-b", name: "Studio Mac", online: false, projects: [.init(id: "folder", name: "trust", sessions: [])]),
        ]
        let section = try #require(ChatProjectSections.build(conversations: [conversation], devices: model.projectDevices, search: "", collapsedForks: [], pinned: []).first)
        try await model.removeOfflineProject(section)
        #expect(model.projectDevices.allSatisfy { $0.projects.isEmpty })
        let after = ChatProjectSections.build(conversations: [conversation], devices: model.projectDevices, search: "", collapsedForks: [], pinned: [])
        #expect(after.map(\.id) == ["recents"])
    }
}
