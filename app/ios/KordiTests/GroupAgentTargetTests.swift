import Foundation
import Testing

private final class GroupAgentTargetFixtureBundle: NSObject {}
@testable import Kordi

@Suite @MainActor
struct GroupAgentTargetTests {
    @Test
    func sharedGroupAgentTargetContract() throws {
        struct Fixture: Decodable {
            let name: String
            let participants: [CloudGroupParticipant]?
            let message: CloudGroupMessagePayload
            let expected: GroupAgentTarget?
        }
        struct Fixtures: Decodable {
            let participants: [CloudGroupParticipant]
            let cases: [Fixture]
        }
        let url = try #require(Bundle(for: GroupAgentTargetFixtureBundle.self).url(forResource: "group-cases", withExtension: "json", subdirectory: "agent-targeting"))
        let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: url))
        for fixture in fixtures.cases {
            let participants = fixture.participants ?? fixtures.participants
            #expect(GroupAgentTarget.resolve(fixture.message, participants: participants) == fixture.expected, "\(fixture.name)")
            let envelope = CloudGroupControlEnvelope(kind: "group-message", groupId: "session:group:targeting", groupSpaceId: nil, groupTitle: nil, createdByAccountId: "acct_sender", actor: participants[0], participants: participants, message: fixture.message)
            let restored = try #require(CloudGroupMessageCodec.parse(CloudGroupMessageCodec.encode(envelope))?.message)
            #expect(GroupAgentTarget.resolve(restored, participants: participants) == fixture.expected, "\(fixture.name) after sync")
            if let expected = fixture.expected {
                #expect(restored.targetCloudAgentId == expected.agentId)
                #expect(restored.targetCloudAgentOwnerAccountId == expected.ownerAccountId)
            }
        }
    }

    @Test @MainActor
    func facilitatorMentionIsAnsweredByTheServerAndNeverRoutedToAPersonsAgent() {
        let facilitator = KordiSystemAgentIdentity.mentionTarget
        #expect(facilitator.mentionText == "@Facilitator")
        #expect(facilitator.isFacilitator)
        #expect(ComposerMentionMenuItem(kind: .target(facilitator)).detail() == "Built in")
        #expect(ComposerMentionMenuItem(kind: .target(facilitator)).section == .agents)

        let participants = ["sender", "peer"].map { CloudGroupParticipant(accountId: "acct_\($0)", displayName: $0, avatarUrl: nil, role: "person") }
        let peerAgent = ComposerMentionTarget(id: "agent:cloud-agent:acct_peer", displayName: "Kordi", kind: .agent, accountId: "acct_peer", agentId: "cloud-agent:acct_peer", ownerName: "peer", avatarSource: nil)
        let targets = [facilitator, peerAgent]
        let text = "@Facilitator find a time"
        let mentions = ComposerMentionTargetCatalog.mentions(in: text, selectedTarget: facilitator, targets: targets)
        #expect(mentions.map(\.targetIdentityId) == ["agent:cloud-agent:acct_kordi_pip"])
        #expect(mentions.first?.agentId == nil)
        #expect(ComposerMentionTargetCatalog.groupTarget(in: text, selectedTarget: facilitator, targets: targets, senderAccountId: "acct_sender", participants: participants) == nil)
        // Beside a person's agent, that agent still gets the request.
        let both = "@Facilitator and @Kordipeer check status"
        #expect(ComposerMentionTargetCatalog.groupTarget(in: both, selectedTarget: peerAgent, targets: targets, senderAccountId: "acct_sender", participants: participants)?.id == peerAgent.id)
    }

    @Test @MainActor
    func groupComposerGenericAliasSelectsSenderAndPreservesExplicitPeer() {
        let participants = ["sender", "peer"].map { CloudGroupParticipant(accountId: "acct_\($0)", displayName: $0, avatarUrl: nil, role: "person") }
        let targets = participants.map { ComposerMentionTarget(id: "agent:cloud-agent:\($0.accountId)", displayName: "Kordi", kind: .agent, accountId: $0.accountId, agentId: "cloud-agent:\($0.accountId)", ownerName: $0.displayName, avatarSource: nil) }
        let generic = ComposerMentionTargetCatalog.groupTarget(in: "@Kordi check status", selectedTarget: nil, targets: targets, senderAccountId: "acct_sender", participants: participants)
        #expect(generic?.accountId == "acct_sender")
        let peer = targets[1]
        let explicit = ComposerMentionTargetCatalog.groupTarget(in: "\(peer.mentionText) check status", selectedTarget: peer, targets: targets, senderAccountId: "acct_sender", participants: participants)
        #expect(explicit?.accountId == "acct_peer")
    }

}
