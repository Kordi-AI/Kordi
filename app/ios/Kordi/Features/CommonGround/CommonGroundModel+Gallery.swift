import Foundation
import UIKit

/// A room gallery's state on the Grounding model: one value, so a change
/// redraws the room's Gallery tab and an open item together.
struct CommonGroundGalleryState {
    /// Nil until a gallery route answered; false once the server showed it
    /// has no gallery, which keeps the room screen as it was.
    var supported: Bool?
    var lists: [String: CommonGroundGalleryList] = [:]
    /// My artifacts for the Share sheet, by room code.
    var candidates: [String: [CommonGroundGalleryCandidate]] = [:]
    /// Opened items with their comments, by `CommonGroundModel.galleryKey`.
    var items: [String: CommonGroundGalleryItemView] = [:]
}

/// What the gallery keeps outside published state: downloaded files and
/// image thumbnails, the item screens on display, and hint coalescing.
@MainActor
final class CommonGroundGalleryRuntime {
    final class Box {
        let content: CommonGroundGalleryContent
        init(_ content: CommonGroundGalleryContent) { self.content = content }
    }

    let content = NSCache<NSString, Box>()
    let thumbnails = NSCache<NSString, UIImage>()
    /// Item screens on display, which gallery hints refresh.
    var openItems: Set<String> = []
    var hintTasks: [String: Task<Void, Never>] = [:]
    var hintedItems: [String: Set<String>] = [:]
    var pendingSequence = 0

    init() {
        content.totalCostLimit = 48 * 1_024 * 1_024
        thumbnails.countLimit = 120
    }
}

/// The room gallery: members share their own artifacts, the others open them
/// read-only and comment. Comments land at once and roll back when the
/// server refuses; shares and removals wait for the server. An older server
/// without the routes turns the gallery off (`gallery.supported == false`).
extension CommonGroundModel {
    /// Gallery hints for one room arriving this close together cause one refresh.
    nonisolated static let galleryHintDelay: Duration = .milliseconds(300)
    static let galleryShareMax = 8
    static let galleryCommentMax = 2000
    /// Images up to this size draw a thumbnail; larger ones show their type.
    static let galleryThumbnailByteLimit = 12 * 1_024 * 1_024

    static let galleryMessages: [String: String] = [
        "common_ground_gallery_limit": "You can share up to 20 items in a room.",
        "common_ground_gallery_not_shareable": "Some of these can't be shared.",
        "common_ground_gallery_item_not_found": "This item was removed.",
        "common_ground_gallery_comment_not_found": "This comment was deleted.",
    ]

    static func galleryKey(_ code: String, _ itemId: String) -> String { "\(code)|\(itemId)" }
    static func galleryCandidatesBusyKey(_ code: String) -> String { "gallery-candidates:\(code)" }
    static func galleryShareBusyKey(_ code: String) -> String { "gallery-share:\(code)" }
    static func galleryRemoveBusyKey(_ itemId: String) -> String { "gallery-remove:\(itemId)" }
    static func galleryCommentBusyKey(_ itemId: String) -> String { "gallery-comment:\(itemId)" }

    /// The room screen shows Gallery once the server answered a gallery route.
    var galleryEnabled: Bool { gallery.supported == true }

    /// A 404 without a Common ground error code: the server has no such route.
    static func isGalleryRouteMissing(_ error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        return error.statusCode == 404 && !error.code.hasPrefix("common_ground")
    }

    /// Turns the gallery off for a server without its routes; true when it did.
    private func galleryUnsupported(_ error: Error) -> Bool {
        guard Self.isGalleryRouteMissing(error) else { return false }
        gallery = CommonGroundGalleryState(supported: false)
        return true
    }

    func galleryItem(code: String, itemId: String) -> CommonGroundGalleryItem? {
        gallery.items[Self.galleryKey(code, itemId)]?.item ?? gallery.lists[code]?.items.first { $0.itemId == itemId }
    }

    /// The newest relationship with a sharer or commenter: a local update,
    /// then what the gallery sent, then any other loaded view.
    func galleryRelationship(for person: CommonGroundPerson) -> CommonGroundRelationship? {
        relationships[person.accountId] ?? person.relationship ?? relationship(for: person.accountId)
    }

    // MARK: List

    /// Loads a room's gallery. `quiet` keeps failures off screen (the room
    /// opening, a hint).
    func loadGallery(_ code: String, quiet: Bool = true) async {
        guard gallery.supported != false else { return }
        do {
            let list = try await call { try await $0.commonGroundGallery(token: $1, code: code) }
            gallery.supported = true
            if gallery.lists[code] != list { gallery.lists[code] = list }
        } catch {
            if !galleryUnsupported(error), !quiet { report(error) }
        }
    }

    /// Loads my artifacts for the Share sheet; the old list goes first so the
    /// sheet shows the server's.
    func loadGalleryCandidates(_ code: String) async {
        gallery.candidates[code] = nil
        guard let candidates = await run(Self.galleryCandidatesBusyKey(code), {
            try await $0.commonGroundGalleryCandidates(token: $1, code: code)
        }) else { return }
        gallery.candidates[code] = candidates
    }

    /// Shares my picks with a topic or none; the new items go first. False
    /// when the server refused.
    func shareToGallery(code: String, attachmentIds: [String], topic: String?) async -> Bool {
        let ids = Array(attachmentIds.prefix(Self.galleryShareMax))
        guard !ids.isEmpty else { return false }
        let topic = topic?.nonEmpty
        guard let added = await run(Self.galleryShareBusyKey(code), {
            try await $0.shareToCommonGroundGallery(token: $1, code: code, attachmentIds: ids, topic: topic)
        }) else { return false }
        gallery.supported = true
        let fresh = Set(added.map(\.itemId))
        var list = gallery.lists[code] ?? CommonGroundGalleryList(canShare: true)
        list.items = added + list.items.filter { !fresh.contains($0.itemId) }
        gallery.lists[code] = list
        let shared = Set(ids + added.map(\.attachmentId))
        if var candidates = gallery.candidates[code] {
            for index in candidates.indices where shared.contains(candidates[index].attachmentId) {
                candidates[index].shared = true
            }
            gallery.candidates[code] = candidates
        }
        return true
    }

    /// The sharer takes an item out of the gallery. One already gone counts as removed.
    func removeFromGallery(code: String, itemId: String) async -> Bool {
        let key = Self.galleryRemoveBusyKey(itemId)
        busy = key
        notice = nil
        defer { if busy == key { busy = nil } }
        do {
            try await call { try await $0.removeFromCommonGroundGallery(token: $1, code: code, itemId: itemId) }
        } catch let error as CloudAPIError where error.code == "common_ground_gallery_item_not_found" {
            // Removed elsewhere already.
        } catch {
            report(error)
            return false
        }
        dropGalleryItem(code: code, itemId: itemId)
        return true
    }

    func dropGalleryItem(code: String, itemId: String) {
        let key = Self.galleryKey(code, itemId)
        gallery.items[key] = nil
        gallery.lists[code]?.items.removeAll { $0.itemId == itemId }
        galleryRuntime.content.removeObject(forKey: key as NSString)
        galleryRuntime.thumbnails.removeObject(forKey: key as NSString)
    }

    // MARK: Item

    func openGalleryItem(code: String, itemId: String) { galleryRuntime.openItems.insert(Self.galleryKey(code, itemId)) }
    func closeGalleryItem(code: String, itemId: String) { galleryRuntime.openItems.remove(Self.galleryKey(code, itemId)) }

    /// Loads an item and its comments. False when it is gone (removed, the
    /// sharer left, the viewer left the room, or no route); it is dropped then.
    @discardableResult
    func loadGalleryItem(code: String, itemId: String, quiet: Bool = false) async -> Bool {
        do {
            let view = try await call { try await $0.commonGroundGalleryItem(token: $1, code: code, itemId: itemId) }
            gallery.supported = true
            applyGalleryItem(view, code: code)
            return true
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) { return true }
            let status = (error as? CloudAPIError)?.statusCode ?? 0
            let gone = galleryUnsupported(error) || status == 403 || status == 404
            if gone { dropGalleryItem(code: code, itemId: itemId) }
            if gone || !quiet { report(error) }
            return !gone
        }
    }

    /// Lands an item the server sent and keeps the room's list in step.
    /// Comments still on their way stay at the end.
    func applyGalleryItem(_ view: CommonGroundGalleryItemView, code: String) {
        let key = Self.galleryKey(code, view.item.itemId)
        let pending = (gallery.items[key]?.comments ?? []).filter(\.isPending)
        var next = view
        next.comments = view.comments.map(withViewer) + pending
        next.item.commentCount += pending.count
        gallery.items[key] = next
        if let index = gallery.lists[code]?.items.firstIndex(where: { $0.itemId == next.item.itemId }) {
            gallery.lists[code]?.items[index] = next.item
        }
    }

    /// The viewer stands in for a comment of theirs the server sent without a person.
    private func withViewer(_ comment: CommonGroundGalleryComment) -> CommonGroundGalleryComment {
        guard comment.person.accountId.isEmpty, comment.mine else { return comment }
        var comment = comment
        comment.person = me
        return comment
    }

    /// The item's bytes, kept for a while so the card, the screen and Quick Look share them.
    func galleryContent(code: String, itemId: String) async throws -> CommonGroundGalleryContent {
        let key = Self.galleryKey(code, itemId) as NSString
        if let cached = galleryRuntime.content.object(forKey: key) { return cached.content }
        let content = try await call { try await $0.commonGroundGalleryContent(token: $1, code: code, itemId: itemId) }
        galleryRuntime.content.setObject(CommonGroundGalleryRuntime.Box(content), forKey: key, cost: content.data.count)
        return content
    }

    /// A card's image, read from the content route and scaled down once.
    func galleryThumbnail(code: String, item: CommonGroundGalleryItem) async -> UIImage? {
        let key = Self.galleryKey(code, item.itemId) as NSString
        if let image = galleryRuntime.thumbnails.object(forKey: key) { return image }
        guard item.kind == .image, (item.sizeBytes ?? 0) <= Self.galleryThumbnailByteLimit,
              let content = try? await galleryContent(code: code, itemId: item.itemId),
              let image = UIImage(data: content.data) else { return nil }
        let shortest = max(1, min(image.size.width, image.size.height))
        let scale = min(1, 640 / shortest)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let thumbnail = await image.byPreparingThumbnail(ofSize: size) ?? image
        galleryRuntime.thumbnails.setObject(thumbnail, forKey: key)
        return thumbnail
    }

    // MARK: Hints

    /// `common_ground.gallery.updated`: after a short pause, refetches the
    /// room's gallery when it is loaded and the named items that are open.
    func scheduleGalleryRefresh(code: String, itemId: String?) {
        guard gallery.supported != false else { return }
        galleryRuntime.hintedItems[code, default: []].insert(itemId ?? "")
        guard galleryRuntime.hintTasks[code] == nil else { return }
        galleryRuntime.hintTasks[code] = Task { [weak self] in
            try? await Task.sleep(for: Self.galleryHintDelay)
            guard let self else { return }
            let items = self.galleryRuntime.hintedItems.removeValue(forKey: code) ?? []
            self.galleryRuntime.hintTasks[code] = nil
            await self.refreshGallery(code: code, hintedItems: items)
        }
    }

    func refreshGallery(code: String, hintedItems: Set<String>) async {
        if gallery.lists[code] != nil { await loadGallery(code, quiet: true) }
        for itemId in hintedItems.sorted() where galleryRuntime.openItems.contains(Self.galleryKey(code, itemId)) {
            await loadGalleryItem(code: code, itemId: itemId, quiet: true)
        }
    }
}
