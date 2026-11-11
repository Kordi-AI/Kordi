import XCTest

/// The complete Beta app with offline synthetic memories.
final class MemoryCategoriesUITests: ProviderUITestCase {
    func testCategoryChoicesAndSecondaryFilter() {
        let app = launch("--preview-memory")
        let row = element("memory-row-lesson-1", in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        XCTAssertTrue(reveal(row, in: app))
        capture("Memory categories before editing", app: app)
        func categories() {
            row.press(forDuration: 1)
            app.buttons["Categories"].firstMatch.tap()
        }
        categories()
        XCTAssertFalse(app.buttons["Preference"].firstMatch.isEnabled)
        app.buttons["Work"].firstMatch.tap()
        categories()
        app.buttons["Learning"].firstMatch.tap()
        categories()
        XCTAssertFalse(app.buttons["Health"].firstMatch.isEnabled)
        capture("Memory category limit", app: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.15)).tap()
        XCTAssertTrue(reveal(row, in: app))
        capture("Memory with three categories", app: app)
        let learning = row.buttons["Learning"].firstMatch
        XCTAssertTrue(learning.waitForExistence(timeout: 5))
        learning.tap()
        XCTAssertTrue(element("memory-filter-clear", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(row.exists)
        XCTAssertFalse(element("memory-row-lesson-8", in: app).exists)
        capture("Memory filtered by secondary category", app: app)
    }

    func testImportReviewShowsAllCategories() {
        let app = launch("--preview-memory", "--preview-memory-import")
        let labels = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Task note · Work · AGENTS.md'"))
        XCTAssertTrue(labels.firstMatch.waitForExistence(timeout: 20))
        capture("Memory import review categories", app: app)
    }
}
