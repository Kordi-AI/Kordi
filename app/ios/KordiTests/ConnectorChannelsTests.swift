import XCTest
@testable import Kordi

/// Slack channel choices: settings mapping and the list helpers.
@MainActor
final class ConnectorChannelsTests: XCTestCase {
    func testSettingsMapToChosenChannelsWithNames() throws {
        let json = #"""
        {
          "connectorId": "conn_slack",
          "provider": "slack",
          "status": "connected",
          "readScopes": ["channels:history", "channels:read"],
          "settings": {"channels": ["C1", "G2"], "channelNames": {"C1": "general"}}
        }
        """#
        let summary = try JSONDecoder().decode(CloudConnectorSummary.self, from: Data(json.utf8))
        let state = CloudConnectorsMapping.state(.slack, summary: summary)
        XCTAssertEqual(state.channels, [
            ConnectorChannel(id: "C1", name: "general"),
            ConnectorChannel(id: "G2", name: nil),
        ])

        let settings = CloudConnectorsMapping.settings([
            ConnectorChannel(id: "C1", name: "general"),
            ConnectorChannel(id: "G2", name: nil),
        ])
        XCTAssertEqual(settings, CloudConnectorSettings(channels: ["C1", "G2"], channelNames: ["C1": "general"]))
    }

    func testOtherProvidersHaveNoChannels() throws {
        let json = #"{"connectorId": "conn_gh", "provider": "github", "status": "connected", "settings": {}}"#
        let summary = try JSONDecoder().decode(CloudConnectorSummary.self, from: Data(json.utf8))
        XCTAssertNil(CloudConnectorsMapping.state(.github, summary: summary).channels)
    }

    func testChoicesMergeFilterAndToggle() {
        let options = [
            ConnectorChannelOption(id: "C1", name: "general", isPrivate: false),
            ConnectorChannelOption(id: "G2", name: "launch", isPrivate: true),
        ]
        let chosen = [ConnectorChannel(id: "C9", name: "old-channel")]
        let choices = ConnectorChannelChoices.merge(options, chosen: chosen)
        XCTAssertEqual(choices.map(\.id), ["C9", "C1", "G2"])
        XCTAssertEqual(ConnectorChannelChoices.filter(choices, query: "#LAU").map(\.id), ["G2"])
        XCTAssertEqual(ConnectorChannelChoices.filter(choices, query: " ").count, 3)

        let added = ConnectorChannelChoices.toggle(chosen, option: options[1], on: true)
        XCTAssertEqual(added.map(\.id), ["C9", "G2"])
        XCTAssertEqual(ConnectorChannelChoices.toggle(added, option: options[1], on: false).map(\.id), ["C9"])
    }

    func testSavedChannelsTakeListedNamesAndNeverAnIdAsName() {
        let options = [ConnectorChannelOption(id: "C1", name: "general", isPrivate: false)]
        let named = ConnectorChannelChoices.named([
            ConnectorChannel(id: "C1", name: nil),
            ConnectorChannel(id: "C9", name: "C9"),
            ConnectorChannel(id: "C8", name: "old-channel"),
        ], options: options)
        XCTAssertEqual(named, [
            ConnectorChannel(id: "C1", name: "general"),
            ConnectorChannel(id: "C9", name: nil),
            ConnectorChannel(id: "C8", name: "old-channel"),
        ])

        let settings = CloudConnectorsMapping.settings([
            ConnectorChannel(id: "C1", name: "general"),
            ConnectorChannel(id: "C9", name: "C9"),
        ])
        XCTAssertEqual(settings.channelNames, ["C1": "general"])
    }
}
