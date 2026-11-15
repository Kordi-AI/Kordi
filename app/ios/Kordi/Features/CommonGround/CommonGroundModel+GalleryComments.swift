import Foundation

/// Comments on a room gallery item. A new comment shows at once and is
/// swapped for the server's copy; a deleted one goes at once and comes back
/// when the server refuses. A refresh may land while a request is out, with
/// or without the comment, so the counts follow what is actually shown.
extension CommonGroundModel {
    /// Adds a comment; false when it was refused (or empty or too long).
    func addGalleryComment(code: String, itemId: String, body: String) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= Self.galleryCommentMax else { return false }
        let key = Self.galleryKey(code, itemId)
        galleryRuntime.pendingSequence += 1
        let pendingId = CommonGroundGalleryComment.pendingPrefix + "\(galleryRuntime.pendingSequence)"
        let pending = CommonGroundGalleryComment(
            commentId: pendingId, person: me, body: text, mine: true,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        changeGalleryComments(code: code, itemId: itemId, count: 1) { $0.comments.append(pending) }
        let busyKey = Self.galleryCommentBusyKey(itemId)
        busy = busyKey
        notice = nil
        defer { if busy == busyKey { busy = nil } }
        func shows(_ id: String) -> Bool { gallery.items[key]?.comments.contains { $0.commentId == id } ?? false }
        do {
            var comment = try await call { try await $0.addCommonGroundGalleryComment(token: $1, code: code, itemId: itemId, body: text) }
            if comment.person.accountId.isEmpty { comment.person = me }
            let open = gallery.items[key] != nil
            let pendingShown = shows(pendingId)
            let serverShown = shows(comment.commentId)
            let count = !open ? 0 : serverShown ? (pendingShown ? -1 : 0) : (pendingShown ? 0 : 1)
            changeGalleryComments(code: code, itemId: itemId, count: count) { view in
                if serverShown {
                    view.comments.removeAll { $0.commentId == pendingId }
                } else if let index = view.comments.firstIndex(where: { $0.commentId == pendingId }) {
                    view.comments[index] = comment
                } else {
                    view.comments.append(comment)
                }
            }
            return true
        } catch {
            let count = gallery.items[key] == nil || shows(pendingId) ? -1 : 0
            changeGalleryComments(code: code, itemId: itemId, count: count) { view in
                view.comments.removeAll { $0.commentId == pendingId }
            }
            report(error)
            return false
        }
    }

    /// Deletes a comment (mine, or any on my item); false when the server refused.
    func deleteGalleryComment(code: String, itemId: String, commentId: String) async -> Bool {
        let key = Self.galleryKey(code, itemId)
        guard let view = gallery.items[key], let index = view.comments.firstIndex(where: { $0.commentId == commentId }),
              !view.comments[index].isPending else { return false }
        let removed = view.comments[index]
        changeGalleryComments(code: code, itemId: itemId, count: -1) { view in
            view.comments.removeAll { $0.commentId == commentId }
        }
        let busyKey = Self.galleryCommentBusyKey(itemId)
        busy = busyKey
        notice = nil
        defer { if busy == busyKey { busy = nil } }
        do {
            try await call { try await $0.deleteCommonGroundGalleryComment(token: $1, code: code, itemId: itemId, commentId: commentId) }
            return true
        } catch let error as CloudAPIError where error.code == "common_ground_gallery_comment_not_found" {
            // Deleted elsewhere already.
            return true
        } catch {
            let restore = !(gallery.items[key]?.comments.contains { $0.commentId == commentId } ?? false)
            changeGalleryComments(code: code, itemId: itemId, count: restore ? 1 : 0) { view in
                guard !view.comments.contains(where: { $0.commentId == commentId }) else { return }
                view.comments.insert(removed, at: min(index, view.comments.count))
            }
            report(error)
            return false
        }
    }

    /// Changes an open item's comments and moves its count, and the room
    /// list's count for it, by `count`.
    private func changeGalleryComments(code: String, itemId: String, count: Int,
                                       _ change: (inout CommonGroundGalleryItemView) -> Void) {
        let key = Self.galleryKey(code, itemId)
        if var view = gallery.items[key] {
            view.item.commentCount = max(0, view.item.commentCount + count)
            change(&view)
            gallery.items[key] = view
        }
        guard count != 0, var list = gallery.lists[code],
              let index = list.items.firstIndex(where: { $0.itemId == itemId }) else { return }
        list.items[index].commentCount = max(0, list.items[index].commentCount + count)
        gallery.lists[code] = list
    }
}
