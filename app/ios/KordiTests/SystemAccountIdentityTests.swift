import XCTest
@testable import Kordi

final class SystemAccountIdentityTests: XCTestCase {
    private let planJSON = #"""
    {"eventId":"plan","revision":3,"state":"polling","title":"Dinner","managerIds":["acct_me"],
     "participants":[
       {"participantId":"acct_me","displayName":"Jamie Lin","organizer":true,"rsvp":"yes"},
       {"participantId":"acct_maya","displayName":"Maya","organizer":false,"rsvp":"pending"},
       {"participantId":"acct_kordi_system","displayName":"System","organizer":false,"rsvp":"pending"},
       {"participantId":"acct_kordi_pip","displayName":"System","organizer":false,"rsvp":"pending"}
     ]}
    """#

    func testDirectPlanCardNoticeFromOrganizerShowsAsSystem() throws {
        let conversation = makeDirect()
        var wire = makeWire(id: "plan", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind)
        wire.planCard = try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8))
        let reply = makeWire(id: "mine", from: "acct_me", to: "acct_maya", kind: nil)

        let projected = CloudDirectMessageProjector.project([wire, reply], conversation: conversation, ownAccountId: "acct_me")
        let notice = try XCTUnwrap(projected.first { $0.id == "plan" })
        let own = try XCTUnwrap(projected.first { $0.id == "mine" })

        XCTAssertEqual(notice.author, .person)
        XCTAssertEqual(notice.authorName, KordiSystemIdentity.displayName)
        XCTAssertNotNil(notice.planCard)
        XCTAssertEqual(own.author, .me)
        let identity = MessageAuthorIdentity.resolve(notice, in: conversation, account: nil, mentionTargets: [])
        XCTAssertTrue(KordiSystemIdentity.matches(seed: identity.seed))
        XCTAssertFalse(KordiSystemAgentIdentity.matches(name: identity.name, seed: identity.seed))
    }

    func testAgentPlanCardShowsAsTheAgentInDirectChat() throws {
        var wire = makeWire(id: "plan", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind)
        wire.planCard = try plannedCard(agentId: "cloud-agent:acct_me", agentName: "Kordi", owner: "acct_me", ownerName: "Jamie Lin")

        let owned = try XCTUnwrap(CloudDirectMessageProjector.project(
            [wire], conversation: makeDirect(), ownAccountId: "acct_me").first)
        XCTAssertEqual(owned.author, .agent, "Never the owner's own bubble")
        XCTAssertEqual(owned.authorName, "Jamie Lin's Kordi")
        XCTAssertEqual(owned.senderOwnerName, "You")
        XCTAssertEqual(owned.messageKind, PlanCardAgentSender.messageKind)
        XCTAssertFalse(KordiSystemIdentity.isSystemNotice(owned))
        XCTAssertFalse(owned.isSystemNotice)
        XCTAssertNotNil(owned.planCard)
        XCTAssertEqual(owned.planCardPart().author, .agent)
        XCTAssertEqual(owned.planCardPart().senderOwnerName, "You")
        let identity = MessageAuthorIdentity.resolve(
            owned, in: makeDirect(), account: nil, mentionTargets: [])
        XCTAssertEqual(identity.name, "Jamie Lin's Kordi")
        XCTAssertEqual(identity.seed, "cloud-agent:acct_me")
        XCTAssertFalse(KordiSystemIdentity.matches(seed: identity.seed))

        let seenByPeer = try XCTUnwrap(CloudDirectMessageProjector.project(
            [wire], conversation: makeDirect(), ownAccountId: "acct_maya").first)
        XCTAssertEqual(seenByPeer.author, .agent)
        XCTAssertEqual(seenByPeer.senderOwnerName, "Jamie Lin")
    }

    func testAgentPlanCardShowsAsTheAgentInGroup() throws {
        let conversation = makeGroup()
        var card = makeWire(
            id: "plan", from: "acct_maya", to: "acct_me", kind: KordiSystemIdentity.messageKind,
            sessionId: "session:group:mobile")
        card.planCard = try plannedCard(agentId: "agent_scout", agentName: "Scout", owner: "acct_maya", ownerName: "Maya")
        let own = makeWire(id: "own", from: "acct_maya", to: "acct_me", kind: nil, sessionId: "session:group:mobile")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [card, own]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first { $0.id == "plan" })

        XCTAssertEqual(message.author, .agent)
        XCTAssertEqual(message.authorName, "Scout")
        XCTAssertEqual(message.senderOwnerName, "Maya")
        XCTAssertEqual(message.messageKind, PlanCardAgentSender.messageKind)
        XCTAssertEqual(projected.first { $0.id == "own" }?.authorName, "Maya")
    }

    func testCardWithoutPlannerOrFromAnotherAccountStaysSystem() throws {
        let conversation = makeGroup()
        var meet = makeWire(
            id: "meet", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind,
            sessionId: "session:group:mobile")
        meet.planCard = try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8))
        var forged = makeWire(
            id: "forged", from: "acct_maya", to: "acct_me", kind: KordiSystemIdentity.messageKind,
            sessionId: "session:group:mobile")
        forged.planCard = try plannedCard(agentId: nil, agentName: "Kordi", owner: "acct_me", ownerName: "Jamie Lin")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [meet, forged]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        for id in ["meet", "forged"] {
            let message = try XCTUnwrap(projected.first { $0.id == id })
            XCTAssertEqual(message.author, .person, id)
            XCTAssertEqual(message.authorName, KordiSystemIdentity.displayName, id)
            XCTAssertNil(message.senderOwnerName, id)
            XCTAssertEqual(message.messageKind, KordiSystemIdentity.messageKind, id)
            XCTAssertEqual(
                MessageAuthorIdentity.resolve(message, in: conversation, account: nil, mentionTargets: []),
                KordiSystemIdentity.avatar, id)
        }
    }

    func testPlanCardDecodesPlannerAndToleratesItsAbsence() throws {
        let card = try plannedCard(agentId: "agent_scout", agentName: "Scout", owner: "acct_maya", ownerName: "Maya")
        XCTAssertEqual(card.plannedBy, PlanCardPlanner(
            agentId: "agent_scout", agentName: "Scout", ownerAccountId: "acct_maya", ownerName: "Maya"))
        let roundTrip = try JSONDecoder().decode(PlanCard.self, from: JSONEncoder().encode(card))
        XCTAssertEqual(roundTrip, card)

        XCTAssertNil(try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8)).plannedBy)
        for garbage in [#""Scout""#, #"{"agentName":"Scout"}"#, #"{"agentName":" ","ownerAccountId":"acct_maya"}"#, "null"] {
            let json = #"{"eventId":"plan","revision":1,"state":"polling","title":"Dinner","plannedBy":"# + garbage + "}"
            let decoded = try JSONDecoder().decode(PlanCard.self, from: Data(json.utf8))
            XCTAssertNil(decoded.plannedBy, garbage)
            XCTAssertEqual(decoded.title, "Dinner", garbage)
        }
    }

    func testDirectNoticeFromPeerShowsAsSystem() throws {
        let wire = makeWire(id: "plan", from: "acct_maya", to: "acct_me", kind: KordiSystemIdentity.messageKind)

        let projected = CloudDirectMessageProjector.project([wire], conversation: makeDirect(), ownAccountId: "acct_me")
        let notice = try XCTUnwrap(projected.first)

        XCTAssertEqual(notice.author, .person)
        XCTAssertEqual(notice.authorName, KordiSystemIdentity.displayName)
    }

    func testGroupNoticeSentByViewerIsNotOwnBubble() throws {
        let conversation = makeGroup()
        let notice = makeWire(
            id: "notice", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind,
            sessionId: "session:group:mobile"
        )
        let own = makeWire(id: "own", from: "acct_me", to: "acct_maya", kind: nil, sessionId: "session:group:mobile")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [notice, own]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first { $0.id == "notice" })

        XCTAssertEqual(message.author, .person)
        XCTAssertEqual(message.authorName, KordiSystemIdentity.displayName)
        XCTAssertEqual(projected.first { $0.id == "own" }?.author, .me)
    }

    func testMessageFromSystemAccountIsNamedSystem() {
        XCTAssertEqual(KordiSystemIdentity.groupAuthorName(
            messageKind: nil, fromAccountId: KordiSystemIdentity.accountId,
            participantNames: [:], fallback: "Mobile builders"
        ), KordiSystemIdentity.displayName)
        XCTAssertEqual(KordiSystemIdentity.author(
            messageKind: nil, fromAccountId: KordiSystemIdentity.accountId, ownAccountId: "acct_me"
        ), .person)
    }

    func testSystemAccountIsNeverAPlanParticipantOrMember() throws {
        let card = try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8))

        XCTAssertEqual(card.participants.map(\.participantId), ["acct_me", "acct_maya"])
        XCTAssertTrue(KordiSystemIdentity.isServiceAccount(KordiSystemIdentity.accountId))
        XCTAssertTrue(KordiSystemIdentity.isServiceAccount(KordiSystemAgentIdentity.accountId))
        XCTAssertFalse(KordiSystemIdentity.isServiceAccount("acct_maya"))
        XCTAssertFalse(KordiSystemIdentity.isSystem(accountId: KordiSystemAgentIdentity.accountId))
    }

    private func plannedCard(agentId: String?, agentName: String, owner: String, ownerName: String) throws -> PlanCard {
        let planner: [String: Any?] = [
            "agentId": agentId, "agentName": agentName, "ownerAccountId": owner, "ownerName": ownerName, "avatarUrl": nil
        ]
        var card = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(planJSON.utf8)) as? [String: Any])
        card["plannedBy"] = planner.mapValues { $0 ?? NSNull() }
        return try JSONDecoder().decode(PlanCard.self, from: JSONSerialization.data(withJSONObject: card))
    }

    private func makeDirect() -> ConversationSummary {
        ConversationSummary(
            id: "person:acct_maya", kind: .person, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Maya", displayName: "Maya", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:person:maya", groupParticipants: []
        )
    }

    private func makeGroup() -> ConversationSummary {
        ConversationSummary(
            id: "group:mobile", kind: .group, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Mobile builders", displayName: "Mobile builders", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Jamie Lin", avatarUrl: nil, role: "owner"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member")
            ]
        )
    }

    private func makeWire(
        id: String, from: String, to: String, kind: String?, sessionId: String = "session:person:maya"
    ) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: from,
            toAccountId: to,
            body: "Dinner plan",
            createdAt: "2026-10-21T10:00:00Z",
            deliveredAt: "2026-10-21T10:00:01Z",
            readAt: nil,
            direction: from == "acct_me" ? "outgoing" : "incoming",
            sessionId: sessionId,
            messageKind: kind
        )
    }
}
