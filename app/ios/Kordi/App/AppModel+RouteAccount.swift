import Foundation

/// The account a chat's agent route names, as the iPhone can judge it.
///
/// The iPhone lists only the accounts saved in the Kordi account. A route set
/// on the Mac can name a device-active sign-in or a local `profile:` account.
/// Only the Mac can verify those choices. A hosted-only choice is unavailable
/// only after a successful account-list refresh confirms it is absent.
enum RouteAccountChoice {
    /// Choices that mean "the account active on the device that runs the turn".
    static let deviceActive: Set<String> = ["local-active-oauth", "local-active-api-key", "ios-api-key"]
    /// Accounts stored only in the Kordi account, so a loaded list without one means it was removed.
    static let hostedOnlyPrefixes = ["cloud-login:", "cloud-api-key:", "ios-codex:", "ios-api-key:"]

    static func isDeviceManaged(_ choice: String) -> Bool {
        deviceActive.contains(choice)
            || (choice.hasPrefix("profile:") && choice.count > "profile:".count)
    }

    /// The label of a routed choice that no saved account matches.
    static func missingLabel(_ choice: String) -> String {
        isDeviceManaged(choice) ? "Mac sign-in" : "Account unavailable"
    }

    static func isHostedOnly(_ choice: String) -> Bool {
        hostedOnlyPrefixes.contains { choice.hasPrefix($0) && choice.count > $0.count }
    }

    /// ChatGPT sign-ins run `openai-codex` models; OpenAI keys run `openai` models.
    static func sameModelNamespace(_ left: String, _ right: String) -> Bool {
        modelNamespace(left) == modelNamespace(right)
    }

    /// Older picker routes used the OpenAI display family for both login
    /// methods. Preserve the credential kind encoded by those saved choices.
    static func runtimeProvider(for route: CloudModelRouting) -> String? {
        let modelProvider = route.defaultModel.flatMap { model in
            model.firstIndex(of: "/").map { String(model[..<$0]) }
        }
        guard let provider = route.defaultAuthProvider?.nonEmpty ?? modelProvider else { return nil }
        let family = ProviderAuthenticationDefinition.canonicalID(provider)
        if let modelProvider,
           ProviderAuthenticationDefinition.canonicalID(modelProvider) != family { return nil }
        let choice = route.defaultAuthChoice ?? ""
        if family == "openai" {
            if choice.hasPrefix("ios-codex:") || choice.hasPrefix("cloud-login:") {
                return "openai-codex"
            }
            if choice.hasPrefix("ios-api-key:") || choice.hasPrefix("cloud-api-key:") {
                return "openai"
            }
        }
        return modelProvider ?? provider
    }

    private static func modelNamespace(_ provider: String) -> String {
        let value = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["openai-codex", "codex", "openai-codex-device"].contains(value)
            ? "openai-codex"
            : ProviderAuthenticationDefinition.canonicalID(value)
    }
}

extension AppModel {
    /// True only when the hosted list can establish that the routed account was removed.
    func routeAccountIsUnavailable(_ route: CloudModelRouting) -> Bool {
        routeAccountIsUnavailable(provider: route.defaultAuthProvider, choice: route.defaultAuthChoice)
    }

    func routeAccountIsUnavailable(provider: String?, choice: String?) -> Bool {
        guard hasLoadedProviderAuthentication,
              let choice = choice?.nonEmpty,
              RouteAccountChoice.isHostedOnly(choice) else { return false }
        return !authenticationSnapshots(for: provider ?? "").contains { $0.authChoice == choice }
    }

    /// A route may keep the Mac's active sign-in or name a saved account of its provider.
    func routeAccountCanBeSaved(_ choice: String, provider: String) -> Bool {
        RouteAccountChoice.isDeviceManaged(choice)
            || authenticationSnapshots(for: provider).contains { $0.authChoice == choice }
    }

    /// Identifies a route that should move off a removed account, or nil.
    /// Only hosted-only accounts qualify: a missing Mac sign-in (`profile:`)
    /// may still be on the Mac, which decides for its own accounts.
    func routeAccountFallbackKey(for conversation: ConversationSummary) -> String? {
        guard canChangeRuntimeRouting(for: conversation),
              !isRefreshingProviderAuthentication else { return nil }
        let route = runtimeRouting(for: conversation)
        guard routeAccountIsUnavailable(route),
              let choice = route.defaultAuthChoice?.nonEmpty,
              RouteAccountChoice.isHostedOnly(choice),
              routeAccountReplacement(for: route) != nil else { return nil }
        return [account?.accountId ?? "", conversation.sessionId, route.defaultAuthProvider ?? "", choice]
            .joined(separator: "|")
    }

    /// Prefer the active account within the same runtime namespace. Other
    /// credential types, providers, and Custom API endpoints require an explicit pick.
    func routeAccountReplacement(for route: CloudModelRouting) -> CloudProviderAuthSnapshot? {
        // The settings UI groups ChatGPT and OpenAI keys together, but their
        // runtime model namespaces and credentials are not interchangeable.
        guard let provider = RouteAccountChoice.runtimeProvider(for: route),
              ProviderAuthenticationDefinition.canonicalID(provider) != ProviderAuthenticationDefinition.custom.id
        else { return nil }
        let compatible = authenticationSnapshots(for: provider).filter {
            $0.revokedAt == nil && RouteAccountChoice.sameModelNamespace($0.provider, provider)
        }
        if let active = activeAccount(for: provider), compatible.contains(active) { return active }
        return compatible.first
    }

    /// Moves a route off a removed account onto the replacement, once per
    /// session and account. The decision must hold for `settle`, so a chat
    /// switch finishes first; a failed save may try again later.
    @discardableResult
    func moveRouteOffRemovedAccount(
        in conversation: ConversationSummary,
        settle: Duration = .milliseconds(600)
    ) async -> Bool {
        guard let key = routeAccountFallbackKey(for: conversation),
              !appliedRouteAccountFallbacks.contains(key) else { return false }
        try? await Task.sleep(for: settle)
        guard !Task.isCancelled, routeAccountFallbackKey(for: conversation) == key,
              !appliedRouteAccountFallbacks.contains(key) else { return false }
        let route = runtimeRouting(for: conversation)
        guard let replacement = routeAccountReplacement(for: route),
              let model = replacementModel(for: route, account: replacement) else { return false }
        appliedRouteAccountFallbacks.insert(key)
        // Saving changes the key that owns the composer's .task. Once the
        // commit starts, let it finish publishing even if that view task is
        // cancelled by its own optimistic route update.
        let commit = Task { @MainActor in
            guard routeAccountFallbackKey(for: conversation) == key,
                  runtimeRouting(for: conversation) == route else { return false }
            return await updateRuntimeRouting(
                for: conversation,
                provider: replacement.provider,
                authChoice: replacement.authChoice,
                model: model,
                thinking: AgentModelPicker.normalizedThinking(
                    route.thinking?.nonEmpty ?? "medium", for: model, catalog: ompProviderCatalog
                )
            )
        }
        let saved = await commit.value
        if !saved { appliedRouteAccountFallbacks.remove(key) }
        return saved
    }

    /// Keeps the route's model when the replacement runs the same model
    /// namespace; otherwise uses the replacement's preferred model.
    private func replacementModel(for route: CloudModelRouting, account: CloudProviderAuthSnapshot) -> String? {
        let canonical = ProviderAuthenticationDefinition.canonicalID(account.provider)
        if canonical != ProviderAuthenticationDefinition.custom.id, let current = route.defaultModel?.nonEmpty {
            let namespace = RouteAccountChoice.runtimeProvider(for: route) ?? account.provider
            if RouteAccountChoice.sameModelNamespace(namespace, account.provider) {
                if let separator = current.firstIndex(of: "/"),
                   !RouteAccountChoice.sameModelNamespace(String(current[..<separator]), account.provider) {
                    return "\(account.provider)/\(current[current.index(after: separator)...])"
                }
                return current
            }
        }
        guard let definition = authenticationProviderDefinitions.first(where: {
            ProviderAuthenticationDefinition.canonicalID($0.id) == canonical
        }) else { return nil }
        return preferredModel(for: account, provider: definition)
    }
}
