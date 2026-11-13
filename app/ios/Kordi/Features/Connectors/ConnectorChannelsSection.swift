import SwiftUI

/// The Channels section of a connected Slack connector: a searchable list of
/// the channels the person can choose. Each change saves right away.
struct ConnectorChannelsSection: View {
    let definition: ConnectorDefinition
    @ObservedObject var store: ConnectorsStore
    let onReconnect: () -> Void

    private enum Loaded: Equatable {
        case loading
        case reconnect(String)
        case failed(String)
        case ready([ConnectorChannelOption])
    }

    @State private var loaded: Loaded = .loading
    @State private var query = ""
    @State private var saving = false
    @State private var saveError: String?

    private var providerId: ConnectorProviderId { definition.providerId }
    private var chosen: [ConnectorChannel] { store.states[providerId]?.channels ?? [] }
    private var busy: Bool { saving || store.busyProviderId == providerId }

    var body: some View {
        SettingsDivider()
        SettingsSectionTitle("Channels")
        content
            .task { await load() }
            .onChange(of: store.states[providerId]) {
                // After signing in again, try the list once more.
                if case .reconnect = loaded { Task { await load() } }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch loaded {
        case .loading:
            SettingsLoadingRow("Loading channels…")
        case .reconnect(let message):
            SettingsRow {
                CompactSettingsLabel(title: message, systemImage: nil)
            } trailing: {
                Button("Reconnect", action: onReconnect)
                    .font(SettingsFont.action)
                    .disabled(busy)
            }
        case .failed(let message):
            SettingsErrorLabel(message)
            Button("Try again") { Task { await load() } }
                .font(SettingsFont.action)
                .frame(minHeight: SettingsMetrics.textRowMinHeight)
        case .ready(let options):
            SettingsSearchField("Search channels", text: $query)
            let choices = ConnectorChannelChoices.filter(
                ConnectorChannelChoices.merge(options, chosen: chosen),
                query: query
            )
            if choices.isEmpty {
                SettingsCaption("No channels found.")
            }
            ForEach(choices) { option in
                Toggle(isOn: binding(option)) {
                    CompactSettingsLabel(
                        title: "#\(option.name)",
                        systemImage: option.isPrivate ? "lock" : "number"
                    )
                }
                .frame(minHeight: SettingsMetrics.textRowMinHeight)
                .disabled(busy || (!isChosen(option) && chosen.count >= ConnectorChannelChoices.maxChosen))
                .accessibilityLabel(option.isPrivate ? "\(option.name), private channel" : option.name)
            }
            if let saveError {
                SettingsErrorLabel(saveError)
            }
        }
    }

    private func isChosen(_ option: ConnectorChannelOption) -> Bool {
        chosen.contains { $0.id == option.id }
    }

    private func binding(_ option: ConnectorChannelOption) -> Binding<Bool> {
        Binding(
            get: { isChosen(option) },
            set: { on in Task { await save(ConnectorChannelChoices.toggle(chosen, option: option, on: on)) } }
        )
    }

    private func load() async {
        loaded = .loading
        do {
            loaded = .ready(try await store.client.listChannels(providerId))
        } catch let error as ConnectorsClientError where error.code == CloudConnectorsClient.scopeMissingCode {
            loaded = .reconnect(error.message)
        } catch {
            loaded = .failed(ConnectorsStore.message(error, fallback: "Could not load channels."))
        }
    }

    private func save(_ channels: [ConnectorChannel]) async {
        saving = true
        saveError = nil
        defer { saving = false }
        do {
            store.apply(try await store.client.saveChannels(providerId, channels: channels))
        } catch {
            saveError = ConnectorsStore.message(error, fallback: "Could not save channels.")
        }
    }
}

/// Pure helpers for the channel list, shared with tests.
enum ConnectorChannelChoices {
    /// Most channels the server accepts.
    static let maxChosen = 50

    /// Listed options plus chosen channels Slack no longer lists, so they can
    /// be turned off.
    static func merge(_ options: [ConnectorChannelOption], chosen: [ConnectorChannel]) -> [ConnectorChannelOption] {
        let listed = Set(options.map(\.id))
        let missing = chosen
            .filter { !listed.contains($0.id) }
            .map { ConnectorChannelOption(id: $0.id, name: $0.name ?? $0.id, isPrivate: $0.id.hasPrefix("G")) }
        return missing + options
    }

    /// Choices whose name contains `query`, ignoring case and a leading `#`.
    static func filter(_ choices: [ConnectorChannelOption], query: String) -> [ConnectorChannelOption] {
        var needle = query.trimmingCharacters(in: .whitespaces)
        if needle.hasPrefix("#") { needle.removeFirst() }
        guard !needle.isEmpty else { return choices }
        return choices.filter { $0.name.localizedCaseInsensitiveContains(needle) }
    }

    /// `chosen` with `option` turned on or off, keeping the chosen order.
    static func toggle(_ chosen: [ConnectorChannel], option: ConnectorChannelOption, on: Bool) -> [ConnectorChannel] {
        let rest = chosen.filter { $0.id != option.id }
        return on ? rest + [ConnectorChannel(id: option.id, name: option.name)] : rest
    }
}
