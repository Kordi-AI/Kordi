import Foundation

/// The account a chat's agent route names, as the iPhone can judge it.
///
/// The iPhone lists only the accounts saved in the Kordi account. A route set
/// on the Mac can name the Mac's active sign-in (`local-active-oauth`), which
/// only the Mac resolves, so it is never unavailable here. A `kind:id` choice
/// names one saved account and is unavailable once the account list has
/// loaded without it.
enum RouteAccountChoice {
    /// Choices that mean "the account active on the device that runs the turn".
    static let deviceActive: Set<String> = ["local-active-oauth", "local-active-api-key", "ios-api-key"]
    /// Accounts stored only in the Kordi account, so a loaded list without one means it was removed.
    static let hostedOnlyPrefixes = ["cloud-login:", "cloud-api-key:", "ios-codex:", "ios-api-key:"]

    static func namesOneAccount(_ choice: String) -> Bool {
        guard !deviceActive.contains(choice), let colon = choice.firstIndex(of: ":") else { return false }
        return colon > choice.startIndex && choice.index(after: colon) < choice.endIndex
    }

    /// The label of a routed choice that no saved account matches.
    static func missingLabel(_ choice: String) -> String {
        deviceActive.contains(choice) ? "Mac sign-in" : "Account unavailable"
    }

    static func isHostedOnly(_ choice: String) -> Bool {
        hostedOnlyPrefixes.contains { choice.hasPrefix($0) && choice.count > $0.count }
    }

    /// ChatGPT sign-ins run `openai-codex` models; OpenAI keys run `openai` models.
    static func sameModelNamespace(_ left: String, _ right: String) -> Bool {
        modelNamespace(left) == modelNamespace(right)
    }

    private static func modelNamespace(_ provider: String) -> String {
        let value = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["openai-codex", "codex", "openai-codex-device"].contains(value)
            ? "openai-codex"
            : ProviderAuthenticationDefinition.canonicalID(value)
    }
}

extension AppModel {
    /// True when the route names one saved account that the loaded account list lacks.
    func routeAccountIsUnavailable(_ route: CloudModelRouting) -> Bool {
        routeAccountIsUnavailable(provider: route.defaultAuthProvider, choice: route.defaultAuthChoice)
    }

    func routeAccountIsUnavailable(provider: String?, choice: String?) -> Bool {
        guard hasLoadedProviderAuthentication,
              let choice = choice?.nonEmpty,
              RouteAccountChoice.namesOneAccount(choice) else { return false }
        return !authenticationSnapshots(for: provider ?? "").contains { $0.authChoice == choice }
    }

    /// A route may keep the Mac's active sign-in or name a saved account of its provider.
    func routeAccountCanBeSaved(_ choice: String, provider: String) -> Bool {
        RouteAccountChoice.deviceActive.contains(choice)
            || authenticationSnapshots(for: provider).contains { $0.authChoice == choice }
    }

    /// Identifies a route that should move off a removed account, or nil.
    /// Only hosted-only accounts qualify: a missing Mac sign-in (`profile:`)
    /// may still be on the Mac, which decides for its own accounts.
    func routeAccountFallbackKey(for conversation: ConversationSummary) -> String? {
        guard canChangeRuntimeRouting(for: conversation) else { return nil }
        let route = runtimeRouting(for: conversation)
        guard routeAccountIsUnavailable(route),
              let choice = route.defaultAuthChoice?.nonEmpty,
              RouteAccountChoice.isHostedOnly(choice),
              routeAccountReplacement(for: route) != nil else { return nil }
        return [account?.accountId ?? "", conversation.sessionId, route.defaultAuthProvider ?? "", choice]
            .joined(separator: "|")
    }

    /// The active account of the route's provider. Another provider is never
    /// chosen automatically; the owner picks one.
    func routeAccountReplacement(for route: CloudModelRouting) -> CloudProviderAuthSnapshot? {
        guard let provider = route.defaultAuthProvider?.nonEmpty else { return nil }
        return activeAccount(for: provider)
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
        let saved = await updateRuntimeRouting(
            for: conversation,
            provider: replacement.provider,
            authChoice: replacement.authChoice,
            model: model,
            thinking: AgentModelPicker.normalizedThinking(
                route.thinking?.nonEmpty ?? "medium", for: model, catalog: ompProviderCatalog
            )
        )
        if !saved { appliedRouteAccountFallbacks.remove(key) }
        return saved
    }

    /// Keeps the route's model when the replacement runs the same model
    /// namespace; otherwise uses the replacement's preferred model.
    private func replacementModel(for route: CloudModelRouting, account: CloudProviderAuthSnapshot) -> String? {
        let canonical = ProviderAuthenticationDefinition.canonicalID(account.provider)
        if canonical != ProviderAuthenticationDefinition.custom.id, let current = route.defaultModel?.nonEmpty {
            let namespace = current.firstIndex(of: "/").map { String(current[..<$0]) }
                ?? route.defaultAuthProvider ?? account.provider
            if RouteAccountChoice.sameModelNamespace(namespace, account.provider) { return current }
        }
        guard let definition = authenticationProviderDefinitions.first(where: {
            ProviderAuthenticationDefinition.canonicalID($0.id) == canonical
        }) else { return nil }
        return preferredModel(for: account, provider: definition)
    }
}
