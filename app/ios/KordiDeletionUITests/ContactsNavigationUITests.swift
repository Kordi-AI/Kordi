import XCTest

@MainActor
final class ContactsNavigationUITests: ProviderUITestCase {
    func testContactsToolbarUsesOppositeSidesAndKeepsBothActions() {
        let app = launch("--preview-contacts-tab")
        let grounding = app.buttons["Grounding"]
        let addContact = app.buttons["Add contact"]
        XCTAssertTrue(grounding.waitForExistence(timeout: 15))
        XCTAssertTrue(addContact.exists)
        XCTAssertLessThan(grounding.frame.midX, app.frame.midX)
        XCTAssertGreaterThan(addContact.frame.midX, app.frame.midX)
        XCTAssertEqual(grounding.frame.midY, addContact.frame.midY, accuracy: 2)
        capture("Contacts native toolbar", app: app)

        addContact.tap()
        XCTAssertTrue(app.navigationBars["Add contact"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(grounding.waitForExistence(timeout: 5))
        grounding.tap()
        XCTAssertTrue(grounding.waitForNonExistence(timeout: 5))
        capture("Grounding destination", app: app)
        app.terminate()
    }

    func testContactsGroupOffersEveryChannelAndReturnsToTheGroup() {
        let app = launch()
        let contacts = app.tabBars.buttons["Contacts"]
        XCTAssertTrue(contacts.waitForExistence(timeout: 15))
        contacts.tap()
        XCTAssertTrue(app.buttons["Grounding"].waitForExistence(timeout: 5))

        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Mobile builders,")).firstMatch
        tap(group, in: app)
        XCTAssertTrue(app.navigationBars["Mobile builders"].waitForExistence(timeout: 5))
        let main = element("group-channel-session:group:mobile", in: app)
        let second = element("group-channel-session:group:mobile-release", in: app)
        XCTAssertTrue(main.waitForExistence(timeout: 5))
        XCTAssertTrue(second.exists)
        second.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(main.waitForExistence(timeout: 5))
        main.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.terminate()
    }
}

@MainActor
final class MainTabPerformanceUITests: ProviderUITestCase {
    func testSessionForkControlKeepsPreviewAndSessionNavigation() {
        let app = launch("--preview-agent-page")
        let parent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan the mobile release,")).firstMatch
        let child = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Review the TestFlight checklist,")).firstMatch
        XCTAssertTrue(parent.waitForExistence(timeout: 15))
        XCTAssertTrue(child.exists)
        let hideForks = app.buttons["Hide forks"].firstMatch
        XCTAssertTrue(hideForks.exists)
        capture("Agent session timestamps expanded", app: app)
        hideForks.tap()
        XCTAssertTrue(child.waitForNonExistence(timeout: 5))
        capture("Agent session timestamps collapsed", app: app)
        app.buttons["Show forks"].firstMatch.tap()
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        child.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(parent.waitForExistence(timeout: 5))
        parent.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testArchiveToolbarAndAgentSessionCreationRemainReachable() {
        let app = launch("--preview-chats-tab")
        let archive = app.buttons["chat-archive"]
        XCTAssertTrue(archive.waitForExistence(timeout: 15))
        XCTAssertLessThan(archive.frame.midX, app.frame.midX)
        archive.tap()
        XCTAssertTrue(app.staticTexts["No Archived Chats"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()

        let contact = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Maya Chen,")).firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 5))
        contact.press(forDuration: 0.8)
        let archiveAction = app.buttons["archive-session"]
        XCTAssertTrue(archiveAction.waitForExistence(timeout: 5))
        archiveAction.tap()
        XCTAssertTrue(archiveAction.waitForNonExistence(timeout: 5))
        XCTAssertTrue(contact.waitForNonExistence(timeout: 5))
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: archive)
        waitForExpectations(timeout: 5)
        archive.tap()
        XCTAssertTrue(app.navigationBars["Archived Chats"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Maya Chen"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()

        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(archive.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["New session"].exists)
        app.buttons["Start a chat"].tap()
        let newAgentChat = app.buttons["Chat with agent"]
        XCTAssertTrue(newAgentChat.waitForExistence(timeout: 5))
        newAgentChat.tap()
        XCTAssertTrue(app.navigationBars["Chat with agent"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testNativeChatSearchRestoresRowsAndNewChatMenu() {
        let app = launch("--preview-chats-tab")
        let search = app.searchFields["Search chats"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        search.typeText("Maya")
        XCTAssertTrue(app.staticTexts["Maya Chen"].waitForExistence(timeout: 5))
        let otherContact = app.staticTexts["Ethan Park"]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: otherContact)
        waitForExpectations(timeout: 5)

        let dismissSearch = app.buttons["Close"].exists ? app.buttons["Close"] : app.buttons["Cancel"]
        dismissSearch.tap()
        XCTAssertTrue(otherContact.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["Start a chat"].tap()
        let newContactChat = app.buttons["Chat with contact"]
        XCTAssertTrue(newContactChat.waitForExistence(timeout: 5))
        newContactChat.tap()
        XCTAssertTrue(app.navigationBars["Chat with contact"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testRepeatedChatPullRefreshKeepsRowsAndScrollPosition() throws {
        let app = launch()
        let chats = app.tabBars.buttons["Chats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15))
        let list = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app.tables.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let firstRow = list.cells.firstMatch
        XCTAssertTrue(firstRow.exists)
        let label = firstRow.label
        let initialY = firstRow.frame.minY

        for _ in 0..<3 {
            let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
            let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
            start.press(forDuration: 0.05, thenDragTo: end)
            let settled = NSPredicate { _, _ in
                firstRow.exists && abs(firstRow.frame.minY - initialY) < 2
            }
            expectation(for: settled, evaluatedWith: nil)
            waitForExpectations(timeout: 5)
            XCTAssertEqual(firstRow.label, label)
            XCTAssertTrue(chats.isSelected)
        }
        app.tabBars.buttons["Contacts"].tap()
        chats.tap()
        XCTAssertEqual(list.cells.firstMatch.label, label)
        app.terminate()
    }

    func testBottomTabSwitchingHitches() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Hitch metrics require iOS 26.") }
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Chats"].waitForExistence(timeout: 15))
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTHitchMetric(application: app), XCTClockMetric()], options: options) {
            for title in ["Contacts", "Agents", "Digest", "Account", "Chats"] {
                let tab = app.tabBars.buttons[title]
                tab.tap()
                XCTAssertTrue(tab.isSelected, "The selected tab must match the tapped destination")
            }
        }
        app.terminate()
    }
}
