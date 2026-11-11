import XCTest
@testable import Kordi

/// Account › Memory's organizer (#2035): labels in three layers, filters
/// across layers, the long-press menu for own, other-member and group rows,
/// the memoryVersion 3 gate, several categories per memory (memoryVersion 4)
/// and origin names.
final class MemoryOrganizerTests: XCTestCase {
    private let cards = [
        MemoryCard(profileId: "p-work", kind: "work", title: "Work"),
        MemoryCard(profileId: "p-health", kind: "health", title: "Health"),
        MemoryCard(profileId: "p-daily", kind: "daily", title: "Daily"),
        MemoryCard(profileId: "p-lab", kind: "custom", title: "Lab"),
    ]

    private func memory(
        _ id: String, _ scope: CloudMemoryScope = .global, scopeId: String = "account", label: String? = nil,
        category: String? = "general_preferences", categories: [String]? = nil, cards: [String] = [], excluded: [String] = [],
        owner: String? = "acct_me", day: Int = 1
    ) -> CloudMemory {
        let at = String(format: "2026-10-%02dT09:00:00Z", day)
        var memory = CloudMemory(memoryId: id, scope: scope, scopeId: scopeId, scopeLabel: label, source: .manual,
                                 text: "Memory \(id)", createdAt: at, updatedAt: at, ownerAccountId: owner, category: category)
        memory.categories = categories
        memory.profileIds = cards
        memory.excludedProfileIds = excluded
        return memory
    }

    private var sample: [CloudMemory] {
        [
            memory("work", .conversation, scopeId: "s-1", category: "work_context", cards: ["p-work", "p-lab"], day: 3),
            memory("health", .conversation, scopeId: "s-2", category: "health_context", cards: ["p-health"], day: 4),
            memory("plan", category: "coordination_context", cards: ["p-work", "p-health", "p-daily"], day: 5),
            memory("pref", day: 2),
            memory("group-mine", .group, scopeId: "g-1", category: "work_context", day: 6),
            memory("group-theirs", .group, scopeId: "g-1", category: "work_context", owner: "acct_priya", day: 7),
        ]
    }

    private func organizer(_ memories: [CloudMemory]? = nil, cardsEnabled: Bool = true, multipleCategories: Bool = false) -> MemoryOrganizer {
        let origins = MemoryOriginNames(conversationTitles: ["s-1": "Onboarding chat", "s-2": "Health chat"], groupTitles: ["g-1": "Launch team"])
        return MemoryOrganizer(
            memories: memories ?? sample, cards: cards, cardsEnabled: cardsEnabled, multipleCategoriesEnabled: multipleCategories,
            viewerAccountId: "acct_me", origins: origins
        )
    }

    private func label(_ organizer: MemoryOrganizer, _ id: String, _ layer: MemoryLabelLayer, _ value: String) throws -> MemoryLabel {
        let memory = try XCTUnwrap(organizer.memories.first { $0.memoryId == id })
        return try XCTUnwrap(organizer.labels(for: memory).first { $0.layer == layer && $0.value == value })
    }

    func testRowsAreNewestFirstWithLabelsInThreeLayers() throws {
        let organizer = organizer()
        XCTAssertEqual(organizer.rows(filters: MemoryFilters()).map(\.memoryId), ["group-theirs", "group-mine", "plan", "health", "work", "pref"])
        let rows = Dictionary(uniqueKeysWithValues: organizer.memories.map { ($0.memoryId, organizer.labels(for: $0).map(\.title)) })
        XCTAssertEqual(rows["work"], ["Work", "Work card", "Lab card", "Onboarding chat"])
        XCTAssertEqual(rows["plan"], ["Schedule", "Every card", "Global"])
        // A row with no cards shows no card label; group rows show the category and the group only.
        XCTAssertEqual(rows["pref"], ["Preference", "Global"])
        XCTAssertEqual(rows["group-mine"], ["Work", "Launch team"])
        XCTAssertEqual(organizer.labels(for: organizer.memories[0]).map(\.layer), [.category, .card, .card, .origin])
    }

    func testFiltersMatchAnyLabelWithinALayerAndEveryLayer() throws {
        let organizer = organizer()
        var filters = MemoryFilters()
        filters.toggle(try label(organizer, "work", .card, "p-work"))
        filters.toggle(try label(organizer, "health", .card, "p-health"))
        XCTAssertEqual(organizer.rows(filters: filters).map(\.memoryId), ["health", "work"])
        filters.toggle(try label(organizer, "work", .origin, "conversation:s-1"))
        XCTAssertEqual(organizer.rows(filters: filters).map(\.memoryId), ["work"])
        filters.toggle(try label(organizer, "health", .category, "health_context"))
        XCTAssertTrue(organizer.rows(filters: filters).isEmpty)
        XCTAssertFalse(filters.isEmpty)
        filters.clear()
        XCTAssertTrue(filters.isEmpty)
        XCTAssertEqual(organizer.rows(filters: filters, query: "memory PLAN").map(\.memoryId), ["plan"])

        // Every card is its own label; it does not match the Work card filter.
        var every = MemoryFilters()
        every.toggle(try label(organizer, "plan", .card, MemoryOrganizer.everyCardValue))
        XCTAssertEqual(organizer.rows(filters: every).map(\.memoryId), ["plan"])
    }

    func testFilterRowCountsLabelsPerLayer() throws {
        let organizer = organizer()
        let groups = organizer.filterGroups(filters: MemoryFilters())
        XCTAssertEqual(groups.map(\.layer), [.card, .category, .origin])
        let cardChips = groups[0].chips.map { "\($0.label.title) \($0.count)" }
        XCTAssertEqual(cardChips, ["Work card 1", "Health card 1", "Lab card 1", "Every card 1"])
        XCTAssertEqual(groups[1].chips.first { $0.label.value == "work_context" }?.count, 3)
        XCTAssertEqual(groups[2].chips.map(\.label.title), ["Global", "Launch team", "Health chat", "Onboarding chat"])
        XCTAssertEqual(MemoryOrganizer.allMemoriesTitle(count: organizer.total), "All memories · 6")
    }

    func testMenuItemsForOwnOtherMemberAndGroupRows() throws {
        let organizer = organizer()
        func actions(_ id: String) throws -> MemoryRowActions {
            try organizer.actions(for: XCTUnwrap(organizer.memories.first { $0.memoryId == id }))
        }
        let work = try actions("work")
        XCTAssertEqual(work.categories, MemoryOrganizer.categoryOrder)
        XCTAssertEqual(work.addCards.map(\.title), ["Health", "Daily"])
        XCTAssertEqual(work.removeCards.map(\.title), ["Work", "Lab"])
        // "Every card" comes from the Schedule category and is not removed card by card.
        let plan = try actions("plan")
        XCTAssertEqual(plan.addCards.map(\.title), ["Lab"])
        XCTAssertTrue(plan.removeCards.isEmpty)
        let pref = try actions("pref")
        XCTAssertEqual(pref.addCards.count, 4)
        XCTAssertTrue(pref.removeCards.isEmpty)
        // Group rows: no card items; the viewer changes the category only of what they saved.
        let mine = try actions("group-mine")
        XCTAssertTrue(mine.addCards.isEmpty && mine.removeCards.isEmpty)
        XCTAssertFalse(mine.categories.contains("health_context"))
        XCTAssertFalse(mine.categories.contains("location_context"))
        XCTAssertFalse(mine.categories.contains("purchase_history_preferences"))
        XCTAssertFalse(mine.categories.contains("values_and_ethics"))
        XCTAssertEqual(mine.categories.count, 6)
        XCTAssertEqual(try actions("group-theirs"), MemoryRowActions())
    }

    func testBelowMemoryVersionThreeCardsAreHidden() {
        let organizer = organizer(cardsEnabled: false)
        XCTAssertEqual(organizer.memories.flatMap(organizer.cardLabels(for:)), [])
        XCTAssertEqual(organizer.filterGroups(filters: MemoryFilters()).map(\.layer), [.category, .origin])
        for memory in organizer.memories {
            let actions = organizer.actions(for: memory)
            XCTAssertTrue(actions.addCards.isEmpty && actions.removeCards.isEmpty, memory.memoryId)
        }
        XCTAssertEqual(organizer.rows(filters: MemoryFilters()).count, 6)
    }

    private var severalCategories: [CloudMemory] {
        [
            memory("trip", category: "coordination_context", categories: ["coordination_context", "work_context", "location_context"],
                   cards: ["p-work", "p-health", "p-daily"], day: 3),
            memory("lab", .conversation, scopeId: "s-1", category: "work_context", categories: ["work_context", "education_learner_profile"],
                   cards: ["p-work"], day: 2),
            memory("pref", day: 1),
            memory("group-mine", .group, scopeId: "g-1", category: "work_context", categories: ["work_context", "goals_and_constraints"], day: 4),
        ]
    }

    func testRowsShowOneChipPerCategoryInTheMemorysOrder() throws {
        let organizer = organizer(severalCategories, multipleCategories: true)
        let rows = Dictionary(uniqueKeysWithValues: organizer.memories.map { ($0.memoryId, organizer.labels(for: $0).map(\.title)) })
        XCTAssertEqual(rows["trip"], ["Schedule", "Work", "Location", "Every card", "Global"])
        XCTAssertEqual(rows["lab"], ["Work", "Learning", "Work card", "Onboarding chat"])
        XCTAssertEqual(rows["pref"], ["Preference", "Global"])
        XCTAssertEqual(rows["group-mine"], ["Work", "Goal", "Launch team"])
        let trip = try XCTUnwrap(organizer.memories.first)
        XCTAssertEqual(organizer.categoryLabels(for: trip).map(\.value), ["coordination_context", "work_context", "location_context"])
        // A schedule category anywhere in the list puts the memory on every card.
        var mixed = try XCTUnwrap(organizer.memories.first { $0.memoryId == "lab" })
        mixed.categories = ["work_context", "coordination_context"]
        XCTAssertTrue(organizer.showsEveryCard(mixed))
    }

    func testAMemoryMatchesAndCountsTowardEveryOneOfItsCategories() throws {
        let organizer = organizer(severalCategories, multipleCategories: true)
        let categories = try XCTUnwrap(organizer.filterGroups(filters: MemoryFilters()).first { $0.layer == .category })
        let counts = Dictionary(uniqueKeysWithValues: categories.chips.map { ($0.label.value, $0.count) })
        XCTAssertEqual(counts, [
            "general_preferences": 1, "work_context": 3, "education_learner_profile": 1, "coordination_context": 1,
            "location_context": 1, "goals_and_constraints": 1,
        ])
        var filters = MemoryFilters()
        filters.toggle(try label(organizer, "trip", .category, "work_context"))
        XCTAssertEqual(organizer.rows(filters: filters).map(\.memoryId), ["group-mine", "trip", "lab"])
        filters.clear()
        filters.toggle(try label(organizer, "trip", .category, "location_context"))
        XCTAssertEqual(organizer.rows(filters: filters).map(\.memoryId), ["trip"])
        filters.toggle(try label(organizer, "lab", .category, "education_learner_profile"))
        XCTAssertEqual(organizer.rows(filters: filters).map(\.memoryId), ["trip", "lab"])
    }

    func testCategoriesMenuKeepsOneToThreeCategories() throws {
        let organizer = organizer(severalCategories, multipleCategories: true)
        let trip = try XCTUnwrap(organizer.memories.first { $0.memoryId == "trip" })
        let pref = try XCTUnwrap(organizer.memories.first { $0.memoryId == "pref" })
        let lab = try XCTUnwrap(organizer.memories.first { $0.memoryId == "lab" })

        // Every chosen category shows a checkmark.
        XCTAssertEqual(MemoryOrganizer.categoryOrder.filter { organizer.isChosen($0, for: trip) },
                       ["work_context", "coordination_context", "location_context"])

        // The only category cannot be removed; others are added after it.
        XCTAssertNil(organizer.categories(afterToggling: "general_preferences", for: pref))
        XCTAssertFalse(organizer.canToggle("general_preferences", for: pref))
        XCTAssertEqual(organizer.categories(afterToggling: "work_context", for: pref), ["general_preferences", "work_context"])

        // Removing keeps the others in order.
        XCTAssertEqual(organizer.categories(afterToggling: "work_context", for: lab), ["education_learner_profile"])
        XCTAssertEqual(organizer.categories(afterToggling: "health_context", for: lab), ["work_context", "education_learner_profile", "health_context"])

        // With three chosen, unchosen ones are disabled and chosen ones can still be removed.
        XCTAssertNil(organizer.categories(afterToggling: "health_context", for: trip))
        XCTAssertFalse(organizer.canToggle("health_context", for: trip))
        XCTAssertTrue(organizer.canToggle("work_context", for: trip))
        XCTAssertEqual(organizer.categories(afterToggling: "coordination_context", for: trip), ["work_context", "location_context"])

        // A memory without a category takes the first one tapped.
        let none = memory("none", category: nil)
        XCTAssertEqual(organizer.categories(afterToggling: "work_context", for: none), ["work_context"])
    }

    func testGroupMemoriesOfferOnlySharedCategories() throws {
        let organizer = organizer(severalCategories, multipleCategories: true)
        let group = try XCTUnwrap(organizer.memories.first { $0.memoryId == "group-mine" })
        let choices = organizer.actions(for: group).categories
        XCTAssertEqual(choices, MemoryOrganizer.categoryOrder.filter { !MemoryOrganizer.groupRefusedCategories.contains($0) })
        XCTAssertEqual(choices.filter { organizer.isChosen($0, for: group) }, ["work_context", "goals_and_constraints"])
        XCTAssertEqual(organizer.categories(afterToggling: "coordination_context", for: group),
                       ["work_context", "goals_and_constraints", "coordination_context"])
    }

    func testBelowMemoryVersionFourTheMenuChoosesOneCategory() throws {
        let organizer = organizer()
        let work = try XCTUnwrap(organizer.memories.first { $0.memoryId == "work" })
        XCTAssertNil(organizer.categories(afterToggling: "work_context", for: work))
        XCTAssertEqual(organizer.categories(afterToggling: "health_context", for: work), ["health_context"])
        // Every item stays enabled, as before.
        XCTAssertTrue(MemoryOrganizer.categoryOrder.allSatisfy { organizer.canToggle($0, for: work) })
        XCTAssertEqual(MemoryOrganizer.categoryOrder.filter { organizer.isChosen($0, for: work) }, ["work_context"])
    }

    func testOriginNamesComeFromLoadedChatsThenTheScopeLabel() {
        let chat = ConversationSummary(
            id: "agent:1", kind: .agent, peerAccountId: "acct_me", agentId: "agent-1", ownerDisplayName: "Me",
            displayName: "Weekly planning", lastMessage: "", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "s-plan", subsessionId: "sub-plan"
        )
        let group = ConversationSummary(
            id: "group:1", kind: .group, peerAccountId: "acct_me", agentId: nil, ownerDisplayName: "Launch team",
            displayName: "main", lastMessage: "", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "session:group:g-uuid", groupSpaceId: "space-1"
        )
        let names = MemoryOriginNames(conversations: [chat, group])
        XCTAssertEqual(names.name(for: memory("a", .conversation, scopeId: "s-plan")), "Weekly planning")
        XCTAssertEqual(names.name(for: memory("b", .conversation, scopeId: "sub-plan")), "Weekly planning")
        XCTAssertEqual(names.name(for: memory("c", .group, scopeId: "g-uuid")), "Launch team")
        XCTAssertEqual(names.name(for: memory("d", .group, scopeId: "space-1")), "Launch team")
        XCTAssertEqual(names.name(for: memory("e", .conversation, scopeId: "gone", label: "Old chat")), "Old chat")
        XCTAssertEqual(names.name(for: memory("f", .conversation, scopeId: "gone")), "Chat")
        XCTAssertEqual(names.name(for: memory("g", .project, scopeId: "p", label: "~/Projects/kordi")), "kordi")
        XCTAssertEqual(names.name(for: memory("h")), "Global")
        XCTAssertEqual(MemoryOriginNames.key(for: memory("h")), "global")
        XCTAssertEqual(MemoryOriginNames.key(for: memory("i", .group, scopeId: "g-uuid")), "group:g-uuid")
    }

    @MainActor
    func testPreviewServiceAddsAndRemovesCards() async throws {
        let service = PreviewMemoryService(latency: .zero)
        let model = MemorySettingsModel(service: service, accountLabel: nil, viewerAccountId: "acct_me", cardsEnabled: true)
        await model.load()
        XCTAssertEqual(model.cards.map(\.title), ["Work", "Health", "Daily", "Lab"])
        let lesson = try XCTUnwrap(model.memories.first { $0.memoryId == "lesson-2" })
        XCTAssertEqual(lesson.profileIds, ["prof-work"])
        let lab = try XCTUnwrap(model.cards.last)
        await model.addToCard(lesson, card: lab)
        XCTAssertEqual(model.memories.first { $0.memoryId == "lesson-2" }?.profileIds, ["prof-work", "prof-lab"])
        await model.removeFromCard(lesson, card: model.cards[0])
        let changed = try XCTUnwrap(model.memories.first { $0.memoryId == "lesson-2" })
        XCTAssertEqual(changed.profileIds, ["prof-lab"])
        XCTAssertEqual(changed.excludedProfileIds, ["prof-work"])
        await model.setCategory(changed, to: "health_context")
        XCTAssertEqual(model.memories.first { $0.memoryId == "lesson-2" }?.profileIds, ["prof-health", "prof-lab"])
        let group = try XCTUnwrap(model.memories.first { $0.memoryId == "lesson-7" })
        await model.addToCard(group, card: lab)
        XCTAssertNotNil(model.errorMessage)
    }

    @MainActor
    func testPreviewServiceTogglesSeveralCategories() async throws {
        let service = PreviewMemoryService(latency: .zero)
        let model = MemorySettingsModel(service: service, accountLabel: nil, viewerAccountId: "acct_me", cardsEnabled: true, multipleCategoriesEnabled: true)
        await model.load()
        func lesson() throws -> CloudMemory { try XCTUnwrap(model.memories.first { $0.memoryId == "lesson-2" }) }
        XCTAssertEqual(try lesson().allCategories, ["work_context"])
        await model.toggleCategory(try lesson(), "health_context")
        XCTAssertEqual(try lesson().allCategories, ["work_context", "health_context"])
        XCTAssertEqual(try lesson().category, "work_context")
        XCTAssertEqual(try lesson().profileIds, ["prof-work", "prof-health"])
        await model.toggleCategory(try lesson(), "location_context")
        // A fourth category is not added.
        await model.toggleCategory(try lesson(), "goals_and_constraints")
        XCTAssertEqual(try lesson().allCategories, ["work_context", "health_context", "location_context"])
        await model.toggleCategory(try lesson(), "work_context")
        XCTAssertEqual(try lesson().allCategories, ["health_context", "location_context"])
        XCTAssertEqual(try lesson().category, "health_context")
        await model.toggleCategory(try lesson(), "health_context")
        // The only category stays.
        await model.toggleCategory(try lesson(), "location_context")
        XCTAssertEqual(try lesson().allCategories, ["location_context"])
        XCTAssertNil(model.errorMessage)
    }

    @MainActor
    func testBelowMemoryVersionFourATapReplacesTheCategory() async throws {
        let service = PreviewMemoryService(latency: .zero)
        let model = MemorySettingsModel(service: service, accountLabel: nil, viewerAccountId: "acct_me", cardsEnabled: true)
        await model.load()
        let lesson = try XCTUnwrap(model.memories.first { $0.memoryId == "lesson-2" })
        await model.toggleCategory(lesson, "health_context")
        XCTAssertEqual(model.memories.first { $0.memoryId == "lesson-2" }?.allCategories, ["health_context"])
    }
}
