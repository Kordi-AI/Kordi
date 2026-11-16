import XCTest
@testable import Kordi

/// The room gallery: wire shapes, file kinds, the model slice (list, share,
/// remove, comments, hints) and an older server without the routes.
@MainActor
final class CommonGroundGalleryTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17084")!
    private static let galleryPath = "/v1/cloud/common-ground/rooms/4821/gallery"
    private static let itemPath = galleryPath + "/item_1"
    private static let commentsPath = itemPath + "/comments"
    private static let key = CommonGroundModel.galleryKey("4821", "item_1")

    // Wire shapes from bridges/cloud-server/src/common_ground/gallery.rs.
    static let bea = #"{"accountId":"acct_b","name":"Bea Okafor","avatarUrl":null,"hasCard":true,"relationship":{"contact":true}}"#
    static let alex = #"{"accountId":"acct_a","name":"Alex Rivera","avatarUrl":null}"#
    static let item1 = #"""
    {"itemId":"item_1","attachmentId":"att_1","title":"Runner cache notes","fileName":"runner-cache.md",
     "contentType":"text/markdown","sizeBytes":1200,"topic":"Infrastructure and CI",
     "preview":"# Runner cache notes\n\nA warm cache cut most jobs by half.\n- pnpm store","person":\#(bea),
     "mine":false,"commentCount":1,"createdAt":"2026-11-15T09:00:00Z"}
    """#
    static let item2 = #"""
    {"itemId":"item_2","attachmentId":"att_2","title":"","fileName":"ci-minutes.csv","contentType":null,"sizeBytes":null,
     "topic":null,"preview":null,"person":\#(alex),"mine":true,"commentCount":0,"createdAt":"2026-11-15T08:00:00Z"}
    """#
    static let item3 = #"""
    {"itemId":"item_3","attachmentId":"att_3","title":"Preview deploy runbook","fileName":"deploy.md","contentType":"text/markdown",
     "sizeBytes":800,"topic":"Agent tools","preview":null,"person":\#(alex),"mine":true,"commentCount":0,"createdAt":"2026-11-15T10:00:00Z"}
    """#
    static let list = #"{"items":[\#(item1),{"itemId":"broken"},\#(item2)],"canShare":true}"#
    static let candidates = #"""
    {"artifacts":[
      {"attachmentId":"att_3","title":"Preview deploy runbook","fileName":"deploy.md","contentType":"text/markdown","sizeBytes":800,"updatedAt":"2026-11-14T10:00:00Z","shared":false},
      {"attachmentId":"att_4","title":"Tool call types","fileName":"tools.ts","updatedAt":"2026-11-13T10:00:00Z","shared":false},
      {"attachmentId":"att_1","title":"Runner cache notes","fileName":"runner-cache.md","updatedAt":"2026-11-12T10:00:00Z","shared":true}
    ]}
    """#
    static let chenComment = #"{"commentId":"c_1","person":{"accountId":"acct_c","name":"Chen Li"},"body":"Does the key include the lockfile hash?","mine":false,"createdAt":"2026-11-15T09:10:00Z"}"#
    static let itemView = #"{"item":\#(item1),"comments":[\#(chenComment),{"commentId":7}]}"#
    static let myComment = #"{"comment":{"commentId":"c_2","person":null,"body":"Nice","mine":true,"createdAt":"2026-11-15T09:20:00Z"}}"#

    private func stubbedModel() -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex Rivera")) { (api, "session-value") }
    }

    private func count(_ method: String, _ path: String) -> Int {
        CommonGroundURLProtocol.paths.filter { $0 == "\(method) \(path)" }.count
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<300 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), "Timed out", file: file, line: line)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func loadedModel() async -> CommonGroundModel {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("GET", Self.galleryPath, [(200, Self.list)])
        CommonGroundURLProtocol.stub("GET", Self.itemPath, [(200, Self.itemView)])
        await model.loadGallery("4821")
        model.openGalleryItem(code: "4821", itemId: "item_1")
        await model.loadGalleryItem(code: "4821", itemId: "item_1")
        return model
    }

    // MARK: Shapes

    func testGalleryShapesDecodeLenientlyAndSkipBadEntries() throws {
        let list = try decode(CommonGroundGalleryList.self, Self.list)
        XCTAssertTrue(list.canShare)
        XCTAssertEqual(list.items.map(\.itemId), ["item_1", "item_2"], "An entry without a person is skipped")
        let first = try XCTUnwrap(list.items.first)
        XCTAssertEqual(first.person.relationship?.contact, true)
        XCTAssertEqual(first.topic, "Infrastructure and CI")
        XCTAssertEqual(first.author(), "Bea")
        XCTAssertEqual(first.author(full: true), "Bea Okafor")
        XCTAssertEqual(first.kind, .markdown)
        let second = try XCTUnwrap(list.items.last)
        XCTAssertEqual(second.title, "ci-minutes.csv", "A blank title falls back to the file name")
        XCTAssertNil(second.contentType)
        XCTAssertEqual(second.author(), "You")
        XCTAssertEqual(try decode(CommonGroundGalleryList.self, "{}").items, [])

        let candidates = try decode(CommonGroundGalleryCandidates.self, Self.candidates).artifacts
        XCTAssertEqual(candidates.map(\.attachmentId), ["att_3", "att_4", "att_1"])
        XCTAssertEqual(candidates.map(\.shared), [false, false, true])
        XCTAssertNil(candidates[1].contentType)

        let view = try decode(CommonGroundGalleryItemView.self, Self.itemView)
        XCTAssertEqual(view.comments.map(\.commentId), ["c_1"])
        XCTAssertEqual(view.comments.first?.author(), "Chen Li")
        let comment = try decode(CommonGroundGalleryCommentResponse.self, Self.myComment).comment
        XCTAssertTrue(comment.person.accountId.isEmpty, "A missing person decodes as empty")
        XCTAssertEqual(comment.author(), "You")
        XCTAssertFalse(comment.isPending)
    }

    func testKindsFollowTheFileNameThenTheContentType() {
        typealias Kind = CommonGroundGalleryKind
        XCTAssertEqual(Kind.of(fileName: "notes.md", contentType: "application/octet-stream"), .markdown)
        XCTAssertEqual(Kind.of(fileName: "Untitled", contentType: "text/markdown; charset=utf-8"), .markdown)
        XCTAssertEqual(Kind.of(fileName: "page.html", contentType: nil), .html)
        XCTAssertEqual(Kind.of(fileName: "rows.tsv", contentType: nil), .table)
        XCTAssertEqual(Kind.of(fileName: "shot.PNG", contentType: nil), .image)
        XCTAssertEqual(Kind.of(fileName: "flow.pdf", contentType: nil), .pdf)
        XCTAssertEqual(Kind.of(fileName: "deck.pptx", contentType: nil), .file)
        XCTAssertEqual(Kind.of(fileName: "icon.svg", contentType: "image/svg+xml"), .file)
        XCTAssertEqual(Kind.of(fileName: "receive.ts", contentType: nil), .code)
        XCTAssertEqual(Kind.of(fileName: "data.bin", contentType: "application/zip"), .file)
        XCTAssertEqual(Kind.of(fileName: "photo", contentType: "image/jpeg"), .image)
        XCTAssertEqual(Kind.of(fileName: ".env", contentType: nil), .code)

        XCTAssertEqual(Kind.markdown.typeLabel(fileName: "a.markdown"), "MD")
        XCTAssertEqual(Kind.code.typeLabel(fileName: "receive.ts"), "TS")
        XCTAssertEqual(Kind.code.typeLabel(fileName: "Makefile.config2x"), "CODE")
        XCTAssertEqual(Kind.markdown.typeLabel(fileName: "Untitled"), "MD")
    }

    func testTheItemScreenShowsAFileRowForTextOver2MBAndMediaOver25MB() {
        typealias Kind = CommonGroundGalleryKind
        XCTAssertEqual(Kind.textViewMaxBytes, 2 * 1024 * 1024)
        XCTAssertEqual(Kind.mediaViewMaxBytes, 25 * 1024 * 1024)
        for kind in [Kind.markdown, .html, .code, .table] {
            XCTAssertEqual(kind.forViewing(sizeBytes: Kind.textViewMaxBytes), kind)
            XCTAssertEqual(kind.forViewing(sizeBytes: Kind.textViewMaxBytes + 1), .file)
            XCTAssertEqual(kind.forViewing(sizeBytes: nil), kind)
        }
        for kind in [Kind.image, .pdf] {
            XCTAssertEqual(kind.forViewing(sizeBytes: Kind.textViewMaxBytes + 1), kind)
            XCTAssertEqual(kind.forViewing(sizeBytes: Kind.mediaViewMaxBytes), kind)
            XCTAssertEqual(kind.forViewing(sizeBytes: Kind.mediaViewMaxBytes + 1), .file)
            XCTAssertEqual(kind.forViewing(sizeBytes: nil), kind)
        }
        XCTAssertEqual(Kind.file.forViewing(sizeBytes: Int.max), .file)
    }

    func testTableRowsAndMarkdownThumbnailLines() {
        let rows = CommonGroundGalleryText.rows("Job,Runs,Note\nLint,640,\"fast, cheap\"\n\nBuild,\"3\"\"\",x\n", tabs: false, limit: 5)
        XCTAssertEqual(rows, [["Job", "Runs", "Note"], ["Lint", "640", "fast, cheap"], ["Build", "3\"", "x"]])
        XCTAssertEqual(CommonGroundGalleryText.rows("a\tb\nc\td", tabs: true, limit: 1), [["a", "b"]])
        XCTAssertEqual(CommonGroundGalleryText.decode(Data("\u{feff}hi".utf8)), "hi")

        let lines = CommonGroundGalleryPreviewLine.markdown(
            "# Runner cache\n\nA **warm** cache.\n## Steps\n- [pnpm](https://pnpm.io) store\n```\nkey: deps\n```",
            title: "Runner cache"
        )
        XCTAssertEqual(lines.map(\.text), ["A warm cache.", "Steps", "• pnpm store", "key: deps"])
        XCTAssertEqual(lines.map(\.bold), [false, true, false, false])
        XCTAssertEqual(lines.last?.mono, true)

        let items = try? decode(CommonGroundGalleryList.self, Self.list).items
        XCTAssertEqual(CommonGroundGalleryTab.chips(roomTopics: ["Agent tools", "Infrastructure and CI"], items: items ?? []),
                       ["Infrastructure and CI"], "Only room topics that have items, in the room's order")
    }

    func testMessageDraftIsPrefilledOnce() throws {
        let item = try XCTUnwrap(try decode(CommonGroundGalleryList.self, Self.list).items.first)
        XCTAssertEqual(item.messageDraft, "About \"Runner cache notes\": ")
        ConversationDraftPrefill.set(item.messageDraft, for: "person:acct_b")
        XCTAssertEqual(ConversationDraftPrefill.take(for: "person:acct_b"), item.messageDraft)
        XCTAssertNil(ConversationDraftPrefill.take(for: "person:acct_b"))
    }

    // MARK: Model

    func testAServerWithoutTheRoutesHidesTheGallery() async {
        let model = stubbedModel()
        XCTAssertFalse(model.galleryEnabled, "Hidden until a gallery route answers")
        await model.loadGallery("4821", quiet: false)
        XCTAssertEqual(model.gallery.supported, false)
        XCTAssertFalse(model.galleryEnabled)
        XCTAssertNil(model.notice, "A missing route is not an error")
        await model.loadGallery("4821")
        XCTAssertEqual(count("GET", Self.galleryPath), 1, "No more calls once the server showed it has no gallery")
    }

    func testAMissingRoomIsNotAMissingRoute() async {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("GET", Self.galleryPath, [(404, #"{"errorCode":"common_ground_room_not_found","message":"Room not found."}"#)])
        await model.loadGallery("4821", quiet: false)
        XCTAssertNil(model.gallery.supported)
        XCTAssertEqual(model.notice, CommonGroundModel.roomNotFound)
    }

    func testListLoadsAndAnOpenItemKeepsTheListInStep() async throws {
        let model = await loadedModel()
        XCTAssertTrue(model.galleryEnabled)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.map(\.itemId), ["item_1", "item_2"])
        XCTAssertEqual(model.gallery.items[Self.key]?.comments.map(\.commentId), ["c_1"])
        XCTAssertEqual(model.galleryItem(code: "4821", itemId: "item_2")?.fileName, "ci-minutes.csv")
        XCTAssertEqual(model.galleryRelationship(for: try XCTUnwrap(model.galleryItem(code: "4821", itemId: "item_1")).person)?.contact, true)
    }

    func testShareSendsPicksAndTopicThenPutsNewItemsFirst() async throws {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("GET", Self.galleryPath + "/candidates", [(200, Self.candidates)])
        CommonGroundURLProtocol.stub("POST", Self.galleryPath, [
            (201, #"{"items":[\#(Self.item3)]}"#),
            (409, #"{"errorCode":"common_ground_gallery_limit","message":"You can share up to 20 items in a room."}"#),
        ])
        await model.loadGalleryCandidates("4821")
        XCTAssertEqual(model.gallery.candidates["4821"]?.count, 3)

        let shared = await model.shareToGallery(code: "4821", attachmentIds: ["att_3"], topic: " Agent tools ")
        XCTAssertTrue(shared)
        let body = try XCTUnwrap(CommonGroundURLProtocol.requests.last?.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["attachmentIds"] as? [String], ["att_3"])
        XCTAssertEqual(json["topic"] as? String, "Agent tools")
        XCTAssertEqual(model.gallery.lists["4821"]?.items.map(\.itemId), ["item_3", "item_1", "item_2"])
        XCTAssertEqual(model.gallery.candidates["4821"]?.first?.shared, true)

        let refused = await model.shareToGallery(code: "4821", attachmentIds: ["att_4"], topic: "  ")
        XCTAssertFalse(refused)
        let second = try XCTUnwrap(CommonGroundURLProtocol.requests.last?.body)
        XCTAssertNil((try JSONSerialization.jsonObject(with: second) as? [String: Any])?["topic"], "A blank topic is none")
        XCTAssertEqual(model.notice, "You can share up to 20 items in a room.")
        XCTAssertEqual(model.gallery.lists["4821"]?.items.count, 3)
        XCTAssertNil(model.busy)
    }

    func testRemoveDropsTheItemAndAGoneItemIsDropped() async {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("DELETE", Self.galleryPath + "/item_2", [(204, "")])
        let removed = await model.removeFromGallery(code: "4821", itemId: "item_2")
        XCTAssertTrue(removed)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.map(\.itemId), ["item_1"])

        CommonGroundURLProtocol.stub("GET", Self.itemPath, [(404, #"{"errorCode":"common_ground_gallery_item_not_found","message":"Item not found."}"#)])
        let present = await model.loadGalleryItem(code: "4821", itemId: "item_1", quiet: true)
        XCTAssertFalse(present)
        XCTAssertNil(model.galleryItem(code: "4821", itemId: "item_1"))
        XCTAssertEqual(model.notice, "This item was removed.")
    }

    func testACommentShowsAtOnceAndIsSwappedForTheServerCopy() async throws {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("POST", Self.commentsPath, [(201, Self.myComment)])
        CommonGroundURLProtocol.hold(Self.commentsPath)
        let sending = Task { await model.addGalleryComment(code: "4821", itemId: "item_1", body: "  Nice  ") }
        try await waitUntil { CommonGroundURLProtocol.hasHeldResponse(Self.commentsPath) }
        let pending = try XCTUnwrap(model.gallery.items[Self.key]?.comments.last)
        XCTAssertTrue(pending.isPending)
        XCTAssertEqual(pending.body, "Nice")
        XCTAssertEqual(model.gallery.items[Self.key]?.item.commentCount, 2)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.first?.commentCount, 2)

        CommonGroundURLProtocol.release(Self.commentsPath)
        let sent = await sending.value
        XCTAssertTrue(sent)
        let body = try XCTUnwrap(CommonGroundURLProtocol.requests.last?.body)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: body) as? [String: Any])?["body"] as? String, "Nice")
        let comments = try XCTUnwrap(model.gallery.items[Self.key]?.comments)
        XCTAssertEqual(comments.map(\.commentId), ["c_1", "c_2"])
        XCTAssertEqual(comments.last?.person.accountId, "acct_a", "The viewer stands in for a missing person")
        XCTAssertEqual(model.gallery.items[Self.key]?.item.commentCount, 2)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.first?.commentCount, 2)
    }

    func testARefusedCommentIsTakenBack() async {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("POST", Self.commentsPath, [(409, #"{"errorCode":"common_ground_room_closed","message":"This room has closed."}"#)])
        let sent = await model.addGalleryComment(code: "4821", itemId: "item_1", body: "Late")
        XCTAssertFalse(sent)
        XCTAssertEqual(model.gallery.items[Self.key]?.comments.map(\.commentId), ["c_1"])
        XCTAssertEqual(model.gallery.items[Self.key]?.item.commentCount, 1)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.first?.commentCount, 1)
        XCTAssertEqual(model.notice, "This room is closed.")
        let tooLong = await model.addGalleryComment(code: "4821", itemId: "item_1", body: String(repeating: "a", count: 2001))
        XCTAssertFalse(tooLong)
        XCTAssertEqual(count("POST", Self.commentsPath), 1, "Nothing over 2,000 characters is sent")
    }

    func testDeletingACommentIsImmediateAndComesBackWhenRefused() async {
        let model = await loadedModel()
        let deletePath = Self.commentsPath + "/c_1"
        CommonGroundURLProtocol.stub("DELETE", deletePath, [
            (500, #"{"errorCode":"server_error","message":"Try again."}"#),
            (204, ""),
        ])
        let refused = await model.deleteGalleryComment(code: "4821", itemId: "item_1", commentId: "c_1")
        XCTAssertFalse(refused)
        XCTAssertEqual(model.gallery.items[Self.key]?.comments.map(\.commentId), ["c_1"])
        XCTAssertEqual(model.gallery.lists["4821"]?.items.first?.commentCount, 1)
        XCTAssertEqual(model.notice, "Try again.")

        let deleted = await model.deleteGalleryComment(code: "4821", itemId: "item_1", commentId: "c_1")
        XCTAssertTrue(deleted)
        XCTAssertEqual(model.gallery.items[Self.key]?.comments, [])
        XCTAssertEqual(model.gallery.items[Self.key]?.item.commentCount, 0)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.first?.commentCount, 0)
    }

    // MARK: Hints

    private static let item2Path = galleryPath + "/item_2"
    /// item_2 after two comments and a new title and preview.
    static let item2Changed = #"""
    {"item":{"itemId":"item_2","attachmentId":"att_2","title":"CI minutes","fileName":"ci-minutes.csv","contentType":null,"sizeBytes":null,
     "topic":null,"preview":"job,minutes","person":\#(alex),"mine":true,"commentCount":2,"createdAt":"2026-11-15T08:00:00Z"},"comments":[]}
    """#
    static let beaComment = #"{"commentId":"c_3","person":\#(bea),"body":"It does.","mine":false,"createdAt":"2026-11-15T09:30:00Z"}"#

    private func galleryHint(_ payload: String) throws -> CommonGroundSyncHint? {
        let json = #"{"stream_seq":1,"event_id":"evt_1","protocol_version":2,"type":"common_ground.gallery.updated","critical":false,"#
            + #""conversation_id":null,"entity_id":null,"entity_version":null,"occurred_at":"2026-11-15T09:00:00Z","payload":\#(payload)}"#
        return CommonGroundSyncHint(event: try decode(CloudChatEvent.self, json))
    }

    func testGalleryHintsDecodeFromSyncEvents() throws {
        XCTAssertTrue(CommonGroundSyncHint.eventTypes.contains("common_ground.gallery.updated"))
        XCTAssertEqual(try galleryHint(#"{"code":"4821","itemId":"item_1"}"#), .gallery(code: "4821", itemIds: ["item_1"], change: .list),
                       "An older server names one item and no change")
        XCTAssertEqual(try galleryHint(#"{"code":"4821"}"#), .gallery(code: "4821", itemIds: [], change: .list))
        XCTAssertEqual(try galleryHint(#"{"code":"4821","itemId":"item_1","itemIds":["item_1","item_2"],"change":"item"}"#),
                       .gallery(code: "4821", itemIds: ["item_1", "item_2"], change: .item))
        XCTAssertEqual(try galleryHint(#"{"code":"4821","itemId":"item_3","itemIds":["item_3"],"change":"list"}"#),
                       .gallery(code: "4821", itemIds: ["item_3"], change: .list))
        XCTAssertEqual(try galleryHint(#"{"code":"4821","itemId":"item_1","change":"moved"}"#),
                       .gallery(code: "4821", itemIds: ["item_1"], change: .list), "An unknown change is a list change")
        XCTAssertNil(try galleryHint(#"{"itemId":"item_1"}"#), "A gallery hint names its room")
    }

    func testAHintRefetchesTheLoadedListAndTheOpenItemItNames() async throws {
        let model = await loadedModel()
        await model.refreshGallery(code: "4821", hintedItems: ["item_2"], list: true)
        XCTAssertEqual(count("GET", Self.galleryPath), 2)
        XCTAssertEqual(count("GET", Self.itemPath), 1, "An item that is not named is not refetched")

        model.closeGalleryItem(code: "4821", itemId: "item_1")
        await model.refreshGallery(code: "4821", hintedItems: ["item_1"], list: true)
        XCTAssertEqual(count("GET", Self.itemPath), 1, "A closed item is not refetched")

        await model.refreshGallery(code: "9999", hintedItems: [], list: true)
        XCTAssertEqual(count("GET", "/v1/cloud/common-ground/rooms/9999/gallery"), 0, "A room not loaded is not fetched")

        model.openGalleryItem(code: "4821", itemId: "item_1")
        model.receive(.gallery(code: "4821", itemIds: ["item_1"], change: .list))
        model.receive(.gallery(code: "4821", itemIds: [], change: .list))
        try await waitUntil { count("GET", Self.itemPath) == 2 }
        XCTAssertEqual(count("GET", Self.galleryPath), 4, "Hints close together refresh the list once")
    }

    func testAnItemHintUpdatesOneListEntryWithoutAListRequest() async throws {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("GET", Self.item2Path, [(200, Self.item2Changed)])
        model.receive(.gallery(code: "4821", itemIds: ["item_2"], change: .item))
        try await waitUntil { model.galleryItem(code: "4821", itemId: "item_2")?.commentCount == 2 }
        let entry = try XCTUnwrap(model.galleryItem(code: "4821", itemId: "item_2"))
        XCTAssertEqual(entry.title, "CI minutes")
        XCTAssertEqual(entry.preview, "job,minutes")
        XCTAssertEqual(model.gallery.lists["4821"]?.items.map(\.itemId), ["item_1", "item_2"])
        XCTAssertNil(model.gallery.items[CommonGroundModel.galleryKey("4821", "item_2")], "No view is made for a closed item")
        XCTAssertEqual(count("GET", Self.galleryPath), 1, "The list is not refetched")
        XCTAssertEqual(count("GET", Self.itemPath), 1, "An item that is not named is not refetched")

        model.closeGalleryItem(code: "4821", itemId: "item_1")
        CommonGroundURLProtocol.stub("GET", Self.itemPath, [(200, #"{"item":\#(Self.item1),"comments":[\#(Self.chenComment),\#(Self.beaComment)]}"#)])
        await model.refreshGallery(code: "4821", hintedItems: ["item_1"], list: false)
        XCTAssertEqual(model.gallery.items[Self.key]?.comments.map(\.commentId), ["c_1", "c_3"], "A kept view is replaced")

        await model.refreshGallery(code: "4821", hintedItems: ["item_9"], list: false)
        XCTAssertEqual(count("GET", Self.galleryPath + "/item_9"), 0, "An item the list does not hold is not fetched")
        XCTAssertEqual(count("GET", Self.galleryPath), 1)
    }

    func testAListHintOrOneWithoutAChangeRefetchesTheList() async throws {
        let model = await loadedModel()
        model.closeGalleryItem(code: "4821", itemId: "item_1")
        model.receive(try XCTUnwrap(try galleryHint(#"{"code":"4821","itemId":"item_2"}"#)))
        try await waitUntil { count("GET", Self.galleryPath) == 2 }

        model.receive(.gallery(code: "4821", itemIds: ["item_2"], change: .item))
        model.receive(.gallery(code: "4821", itemIds: ["item_3"], change: .list))
        try await waitUntil { count("GET", Self.galleryPath) == 3 }

        model.receive(.gallery(code: "4821", itemIds: [], change: .item))
        try await waitUntil { count("GET", Self.galleryPath) == 4 }
        XCTAssertEqual(count("GET", Self.item2Path), 0, "A list refresh refetches only the open items")
        XCTAssertEqual(count("GET", Self.itemPath), 1)
    }

    func testEveryNamedItemReachesAnOpenItem() async throws {
        let model = await loadedModel()
        model.receive(.gallery(code: "4821", itemIds: ["item_3", "item_1"], change: .list))
        try await waitUntil { count("GET", Self.itemPath) == 2 }
        XCTAssertEqual(count("GET", Self.galleryPath), 2)

        CommonGroundURLProtocol.stub("GET", Self.item2Path, [(200, Self.item2Changed)])
        model.receive(.gallery(code: "4821", itemIds: ["item_2", "item_1"], change: .item))
        try await waitUntil { model.galleryItem(code: "4821", itemId: "item_2")?.commentCount == 2 }
        XCTAssertEqual(count("GET", Self.itemPath), 3)
        XCTAssertEqual(count("GET", Self.galleryPath), 2, "Items changed in place do not refetch the list")
    }

    func testAGoneItemIsDroppedQuietly() async {
        let model = await loadedModel()
        CommonGroundURLProtocol.stub("GET", Self.item2Path, [(404, #"{"errorCode":"common_ground_gallery_item_not_found","message":"Item not found."}"#)])
        await model.refreshGallery(code: "4821", hintedItems: ["item_2"], list: false)
        XCTAssertEqual(model.gallery.lists["4821"]?.items.map(\.itemId), ["item_1"])
        XCTAssertNil(model.notice, "A gone item leaves without a notice")
        XCTAssertEqual(count("GET", Self.galleryPath), 1)

        let older = await loadedModel()
        await older.refreshGallery(code: "4821", hintedItems: ["item_2"], list: false)
        XCTAssertEqual(older.gallery.supported, false, "A server without the item route turns the gallery off")
        XCTAssertNil(older.notice)
    }

    func testMoreThanEightItemsChangedInPlaceRefetchTheList() async throws {
        let model = await loadedModel()
        let others = (1...8).map { "other_\($0)" }
        await model.refreshGallery(code: "4821", hintedItems: Set(others), list: false)
        XCTAssertEqual(count("GET", Self.galleryPath), 1, "Eight items stay item refreshes")

        for itemId in ["item_1"] + others { model.receive(.gallery(code: "4821", itemIds: [itemId], change: .item)) }
        try await waitUntil { count("GET", Self.galleryPath) == 2 && count("GET", Self.itemPath) == 2 }
        XCTAssertFalse(CommonGroundURLProtocol.paths.contains { $0.contains("/other_") }, "Items not loaded are not fetched")
    }
}
