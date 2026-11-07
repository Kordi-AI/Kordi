import Foundation

extension AppModel {
    var projectConversations: [ConversationSummary] {
        guard let accountID = account?.accountId else { return conversations }
        let known = Set(conversations.map(\.sessionId)).union(archivedConversations.map(\.sessionId))
        let missing = projectDiscoverySessionIDs(Set(projectDevices.flatMap { $0.projects.flatMap(\.sessions) })).subtracting(known)
        return conversations + missing.sorted().map { id in
            ConversationSummary(id: "agent-session:\(id)", kind: .agent, peerAccountId: accountID,
                agentId: account?.defaultAgent?.agentId ?? "cloud-agent:\(accountID)", ownerDisplayName: nil,
                displayName: "New session", lastMessage: "No messages yet", lastActivityAt: .distantPast,
                unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: id, agentDisplayName: "Kordi", messageCount: 0)
        }
    }

    func project(for sessionID: String) -> ChatProject? {
        projectDevices.lazy.flatMap(\.projects).first { $0.sessions.contains(sessionID) }
    }

    func refreshProjects() async {
        if isPreviewMode {
            if ProcessInfo.processInfo.arguments.contains("--preview-projects"), projectDevices.isEmpty {
                let ids = conversations.filter { $0.kind == .agent && !$0.isAgentLaunchTemplate }.prefix(1).map(\.sessionId)
                projectDevices = [.init(id: "preview-mac", name: "My Mac", online: true, projects: [.init(id: "preview-kordi", name: "kordi", sessions: Array(ids)), .init(id: "preview-website", name: "website", sessions: [])])]
            }
            return
        }
        guard let (api, token, accountID) = try? projectContext() else { return }
        do {
            let catalog = try await api.projectCatalog(token: token)
            guard (try? projectContext().1) == token, account?.accountId == accountID else { return }
            projectDevices = catalog.devices
            projectError = nil
        } catch {
            guard (try? projectContext().1) == token else { return }
            projectError = error.localizedDescription
        }
    }

    func performProjectAction(_ input: ChatProjectRequest) async throws -> ChatProjectResult {
        guard !isPreviewMode else { throw ChatProjectFailure(message: "This design preview uses demo data. Connect your Mac in the signed-in app to import projects.") }
        let (api, token, accountID) = try projectContext()
        let result = try await api.performProjectAction(token: token, input: input)
        guard (try? projectContext().1) == token, account?.accountId == accountID else { throw CancellationError() }
        await refreshProjects()
        return result
    }

    /// Removes a project that only offline Macs publish. Its sessions fall back to Recents.
    func removeOfflineProject(_ section: ChatProjectSessionSection) async throws {
        guard section.removable, let project = section.project else { throw ChatProjectFailure(message: "Remove this project in Kordi on your Mac.") }
        if isPreviewMode {
            let removed = Set(section.devices.map(\.id))
            for index in projectDevices.indices where removed.contains(projectDevices[index].id) {
                projectDevices[index].projects.removeAll { $0.id == project.id }
            }
            return
        }
        let (api, token, accountID) = try projectContext()
        for device in section.devices {
            try await api.removeProject(token: token, deviceID: device.id, projectID: project.id)
        }
        guard (try? projectContext().1) == token, account?.accountId == accountID else { return }
        await refreshProjects()
    }

    func canChooseProject(_ conversation: ConversationSummary) -> Bool {
        conversation.kind == .agent && conversation.subsessionId == nil
            && conversation.peerAccountId == account?.accountId
            && (conversation.agentId == account?.defaultAgent?.agentId || conversation.agentId == "cloud-agent:\(account?.accountId ?? "")" || conversation.agentId == CanonicalAvatarSystem.defaultAgentId)
    }

    func assignProject(_ project: ChatProject?, device: ChatProjectDevice, conversation: ConversationSummary) async throws {
        guard canChooseProject(conversation) else { throw ChatProjectFailure(message: "Projects are available for your own Kordi sessions.") }
        guard conversation.agentActivity != .replying else { throw ChatProjectFailure(message: "Stop the running task before moving this session.") }
        if isPreviewMode {
            for deviceIndex in projectDevices.indices {
                for projectIndex in projectDevices[deviceIndex].projects.indices {
                    projectDevices[deviceIndex].projects[projectIndex].sessions.removeAll { $0 == conversation.sessionId }
                    if projectDevices[deviceIndex].id == device.id && projectDevices[deviceIndex].projects[projectIndex].id == project?.id {
                        projectDevices[deviceIndex].projects[projectIndex].sessions.append(conversation.sessionId)
                    }
                }
            }
            retainProjectConversation(conversation)
            return
        }
        let (api, token, _) = try projectContext()
        try await api.prepareProjectConversation(token: token, sessionID: conversation.sessionId)
        _ = try await performProjectAction(.init(commandId: UUID().uuidString, deviceId: device.id, action: "assign", projectId: project?.id, sessionId: conversation.sessionId))
        retainProjectConversation(conversation)
    }

}
