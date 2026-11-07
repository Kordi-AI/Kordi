import Foundation

struct ChatProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    var sessions: [String]
}

struct ChatProjectDevice: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let online: Bool
    var projects: [ChatProject]
}

struct ChatProjectCatalog: Codable { let devices: [ChatProjectDevice] }
struct ChatProjectRepository: Codable, Identifiable {
    let fullName: String
    let description: String?
    var id: String { fullName }
}
struct ChatProjectResult: Codable {
    var projectId: String?
    var sessionId: String?
    var cancelled: Bool?
    var message: String?
    var repositories: [ChatProjectRepository]?
    var hasMore: Bool?
}
struct ChatProjectCommand: Codable {
    let id: String
    let status: String
    let result: ChatProjectResult?
}
struct ChatProjectRequest: Encodable {
    let commandId: String
    let deviceId: String
    let action: String
    var projectId: String?
    var sessionId: String?
    var repository: String?
    var page: Int?
}
struct ChatProjectFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

extension CloudAPIClient {
    func projectCatalog(token: String) async throws -> ChatProjectCatalog {
        try await send(path: "/v1/cloud/projects", method: "GET", token: token, fallback: "Could not load projects. Refresh to try again.")
    }

    /// Removes an offline Mac's catalog entry for one project. The files stay on that Mac.
    func removeProject(token: String, deviceID: String, projectID: String) async throws {
        let device = deviceID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? deviceID
        let project = projectID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectID
        do {
            try await sendWithoutResponse(path: "/v1/cloud/projects/devices/\(device)/projects/\(project)", method: "DELETE", token: token, fallback: "Could not remove the project. Try again.")
        } catch let error as CloudAPIError where error.statusCode == 404 {
            // Already gone from the catalog.
        }
    }

    func performProjectAction(token: String, input: ChatProjectRequest) async throws -> ChatProjectResult {
        let _: ChatProjectCommand = try await send(path: "/v1/cloud/projects/commands", method: "POST", token: token, body: input, fallback: "Open Kordi on your Mac and try again.")
        // The command ID is retained through polling; an interrupted clone is never silently replayed.
        for _ in 0..<720 {
            try Task.checkCancellation()
            let command: ChatProjectCommand = try await send(path: "/v1/cloud/projects/commands/\(input.commandId)", method: "GET", token: token, fallback: "Could not check the project action. Check Kordi on your Mac before retrying.")
            if command.status == "completed" { return command.result ?? ChatProjectResult() }
            if command.status == "failed" { throw ChatProjectFailure(message: command.result?.message ?? "The project action could not finish. Check Kordi on your Mac.") }
            try await Task.sleep(for: .seconds(1))
        }
        throw ChatProjectFailure(message: "The project action timed out. Check Kordi on your Mac before retrying.")
    }
}

struct ChatProjectSessionSection: Identifiable {
    let id: String
    let project: ChatProject?
    /// Macs that publish this project folder, online ones first. Empty for Pinned and Recents.
    let devices: [ChatProjectDevice]
    let sessions: [AgentSessionListItem]

    var online: Bool { devices.contains(where: \.online) }
    /// Only a project that no online Mac publishes can be removed from the list.
    var removable: Bool { project != nil && !devices.isEmpty && !online }
}

/// One project folder across the Macs that publish it.
struct ChatProjectGroup: Identifiable {
    var project: ChatProject
    /// Online Macs first, so actions go to a Mac that can run them.
    var devices: [ChatProjectDevice]
    var id: String { project.id }

    /// Groups projects by folder identity (`sha256(root)`), never by name. Every
    /// Mac app profile on one Mac publishes the same folder under the same ID.
    static func merge(_ devices: [ChatProjectDevice]) -> [ChatProjectGroup] {
        var groups: [ChatProjectGroup] = []
        var index: [String: Int] = [:]
        for device in devices {
            for project in device.projects {
                guard let position = index[project.id] else {
                    index[project.id] = groups.count
                    groups.append(.init(project: project, devices: [device]))
                    continue
                }
                var group = groups[position]
                let known = Set(group.project.sessions)
                group.project.sessions += project.sessions.filter { !known.contains($0) }
                if device.online, !group.devices.contains(where: \.online) {
                    group.project = ChatProject(id: project.id, name: project.name, sessions: group.project.sessions)
                }
                group.devices.append(device)
                groups[position] = group
            }
        }
        return groups.map { group in
            var group = group
            group.devices = group.devices.filter(\.online) + group.devices.filter { !$0.online }
            return group
        }
    }

    /// Macs for the project picker: each project once, under an online Mac that
    /// publishes it when there is one. Offline Macs left without projects are hidden.
    static func pickerDevices(_ devices: [ChatProjectDevice]) -> [ChatProjectDevice] {
        let groups = Dictionary(uniqueKeysWithValues: merge(devices).map { ($0.id, $0) })
        return devices.compactMap { device in
            var device = device
            device.projects = device.projects.compactMap { project in
                guard let group = groups[project.id], group.devices.first?.id == device.id else { return nil }
                return group.project
            }
            return device.online || !device.projects.isEmpty ? device : nil
        }
    }
}

enum ChatProjectSections {
    static func build(conversations: [ConversationSummary], devices: [ChatProjectDevice], search: String, collapsedForks: Set<String>, pinned: Set<String>) -> [ChatProjectSessionSection] {
        // Personal sessions have their own section above these (#2091).
        let conversations = conversations.filter { $0.personalAgentId == nil }
        let assigned = Set(devices.flatMap { $0.projects.flatMap(\.sessions) })
        var sections: [ChatProjectSessionSection] = []
        for group in ChatProjectGroup.merge(devices) {
            let project = group.project
            let ids = Set(project.sessions)
            let matchesProject = project.name.localizedCaseInsensitiveContains(search)
            let sessions = AgentSessionTimelineCatalog.build(conversations: conversations.filter { ids.contains($0.sessionId) }, searchText: matchesProject ? "" : search, collapsedForkParentIds: collapsedForks, pinnedSessionIds: pinned, retainedSessionIds: ids)
            if search.isEmpty || matchesProject || !sessions.isEmpty {
                sections.append(.init(id: "project:\(project.id)", project: project, devices: group.devices, sessions: sessions))
            }
        }
        // Pinned sessions remain reachable even when their project or parent is collapsed.
        let pinnedSessions = AgentSessionTimelineCatalog.build(
            conversations: conversations.filter { pinned.contains($0.sessionId) },
            searchText: search,
            retainedSessionIds: assigned
        ).map { AgentSessionListItem(conversation: $0.conversation, depth: 0, childCount: 0) }
        if !pinnedSessions.isEmpty {
            sections.insert(.init(id: "pinned", project: nil, devices: [], sessions: pinnedSessions), at: 0)
        }
        let recents = AgentSessionTimelineCatalog.build(conversations: conversations.filter { !assigned.contains($0.sessionId) && !pinned.contains($0.sessionId) }, searchText: search, collapsedForkParentIds: collapsedForks, pinnedSessionIds: pinned)
        if !recents.isEmpty { sections.append(.init(id: "recents", project: nil, devices: [], sessions: recents)) }
        return sections
    }
}
