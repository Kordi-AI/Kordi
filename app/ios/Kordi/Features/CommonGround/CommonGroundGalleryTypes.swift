import SwiftUI

// Shapes of the room gallery routes (`/v1/cloud/common-ground/rooms/:code/gallery`),
// camelCase as the server sends them. Decoding is lenient: a missing optional
// field is nil and a list entry that does not decode is skipped.

private extension KeyedDecodingContainer {
    func galleryValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// The entries of a list that decode; a missing list is empty.
    func galleryList<T: Decodable>(_ key: Key) -> [T] {
        guard var list = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var entries: [T] = []
        while !list.isAtEnd {
            if let entry = try? list.decode(T.self) {
                entries.append(entry)
            } else if (try? list.decode(CommonGroundGallerySkipped.self)) == nil {
                break
            }
        }
        return entries
    }
}

/// Consumes one list entry of any shape that did not decode.
private struct CommonGroundGallerySkipped: Decodable {
    init(from decoder: Decoder) throws {}
}

/// One artifact a room member shared to the room's gallery.
struct CommonGroundGalleryItem: Decodable, Hashable, Identifiable {
    let itemId: String
    let attachmentId: String
    let title: String
    let fileName: String
    let contentType: String?
    let sizeBytes: Int?
    let topic: String?
    /// The first characters of a text file; nil for anything else.
    let preview: String?
    let person: CommonGroundPerson
    let mine: Bool
    var commentCount: Int
    let createdAt: String

    var id: String { itemId }
    var kind: CommonGroundGalleryKind { .of(fileName: fileName, contentType: contentType) }

    init(itemId: String, attachmentId: String, title: String, fileName: String, contentType: String? = nil,
         sizeBytes: Int? = nil, topic: String? = nil, preview: String? = nil, person: CommonGroundPerson,
         mine: Bool = false, commentCount: Int = 0, createdAt: String = "") {
        self.itemId = itemId
        self.attachmentId = attachmentId
        self.title = title
        self.fileName = fileName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.topic = topic
        self.preview = preview
        self.person = person
        self.mine = mine
        self.commentCount = commentCount
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case itemId, attachmentId, title, fileName, contentType, sizeBytes, topic, preview, person, mine, commentCount, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        person = try c.decode(CommonGroundPerson.self, forKey: .person)
        attachmentId = c.galleryValue(.attachmentId, "")
        let fileName = c.galleryValue(.fileName, "")
        self.fileName = fileName
        title = c.galleryValue(.title, "").nonEmpty ?? fileName.nonEmpty ?? "Untitled"
        contentType = c.galleryValue(.contentType, nil as String?)
        sizeBytes = c.galleryValue(.sizeBytes, nil as Int?)
        topic = c.galleryValue(.topic, nil as String?)?.nonEmpty
        preview = c.galleryValue(.preview, nil as String?)
        mine = c.galleryValue(.mine, false)
        commentCount = c.galleryValue(.commentCount, 0)
        createdAt = c.galleryValue(.createdAt, "")
    }

    /// "You" for my own item, else the sharer's first name (or full name).
    func author(full: Bool = false) -> String {
        commonGroundGalleryAuthor(person, mine: mine, full: full)
    }
}

/// "You" for my own items and comments, otherwise the person's first or full name.
func commonGroundGalleryAuthor(_ person: CommonGroundPerson, mine: Bool, full: Bool) -> String {
    if mine { return "You" }
    let name = person.displayName
    return full ? name : String(name.split(separator: " ").first ?? Substring(name))
}

/// `GET rooms/:code/gallery`: the items, newest first, and whether I may share more.
struct CommonGroundGalleryList: Decodable, Hashable {
    var items: [CommonGroundGalleryItem]
    var canShare: Bool

    init(items: [CommonGroundGalleryItem] = [], canShare: Bool = false) {
        self.items = items
        self.canShare = canShare
    }

    private enum CodingKeys: String, CodingKey { case items, canShare }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.galleryList(.items)
        canShare = c.galleryValue(.canShare, false)
    }
}

/// `POST rooms/:code/gallery`: the items for the ids asked, in that order.
struct CommonGroundGalleryShared: Decodable, Hashable {
    let items: [CommonGroundGalleryItem]

    private enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        items = try decoder.container(keyedBy: CodingKeys.self).galleryList(.items)
    }
}

/// One of my artifacts the Share sheet offers.
struct CommonGroundGalleryCandidate: Decodable, Hashable, Identifiable {
    let attachmentId: String
    let title: String
    let fileName: String
    let contentType: String?
    let sizeBytes: Int?
    let updatedAt: String
    /// Already in this room's gallery.
    var shared: Bool

    var id: String { attachmentId }

    init(attachmentId: String, title: String, fileName: String, contentType: String? = nil,
         sizeBytes: Int? = nil, updatedAt: String = "", shared: Bool = false) {
        self.attachmentId = attachmentId
        self.title = title
        self.fileName = fileName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.updatedAt = updatedAt
        self.shared = shared
    }

    private enum CodingKeys: String, CodingKey { case attachmentId, title, fileName, contentType, sizeBytes, updatedAt, shared }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        attachmentId = try c.decode(String.self, forKey: .attachmentId)
        let fileName = c.galleryValue(.fileName, "")
        self.fileName = fileName
        title = c.galleryValue(.title, "").nonEmpty ?? fileName.nonEmpty ?? "Untitled"
        contentType = c.galleryValue(.contentType, nil as String?)
        sizeBytes = c.galleryValue(.sizeBytes, nil as Int?)
        updatedAt = c.galleryValue(.updatedAt, "")
        shared = c.galleryValue(.shared, false)
    }
}

/// `GET rooms/:code/gallery/candidates`.
struct CommonGroundGalleryCandidates: Decodable, Hashable {
    let artifacts: [CommonGroundGalleryCandidate]

    private enum CodingKeys: String, CodingKey { case artifacts }

    init(from decoder: Decoder) throws {
        artifacts = try decoder.container(keyedBy: CodingKeys.self).galleryList(.artifacts)
    }
}

/// A comment on a gallery item. `person` may be missing when the server
/// could not read it; the model fills in the viewer for their own.
struct CommonGroundGalleryComment: Decodable, Hashable, Identifiable {
    static let pendingPrefix = "pending:"

    let commentId: String
    var person: CommonGroundPerson
    let body: String
    let mine: Bool
    let createdAt: String

    var id: String { commentId }
    /// Still on its way to the server; it cannot be deleted yet.
    var isPending: Bool { commentId.hasPrefix(Self.pendingPrefix) }

    init(commentId: String, person: CommonGroundPerson, body: String, mine: Bool, createdAt: String) {
        self.commentId = commentId
        self.person = person
        self.body = body
        self.mine = mine
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case commentId, person, body, mine, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commentId = try c.decode(String.self, forKey: .commentId)
        person = c.galleryValue(.person, CommonGroundPerson(accountId: "", name: ""))
        body = c.galleryValue(.body, "")
        mine = c.galleryValue(.mine, false)
        createdAt = c.galleryValue(.createdAt, "")
    }

    func author(full: Bool = true) -> String {
        commonGroundGalleryAuthor(person, mine: mine, full: full)
    }
}

/// `GET rooms/:code/gallery/:itemId`: the item and its comments, oldest first.
struct CommonGroundGalleryItemView: Decodable, Hashable {
    var item: CommonGroundGalleryItem
    var comments: [CommonGroundGalleryComment]

    init(item: CommonGroundGalleryItem, comments: [CommonGroundGalleryComment] = []) {
        self.item = item
        self.comments = comments
    }

    private enum CodingKeys: String, CodingKey { case item, comments }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        item = try c.decode(CommonGroundGalleryItem.self, forKey: .item)
        comments = c.galleryList(.comments)
    }
}

/// `POST .../comments`.
struct CommonGroundGalleryCommentResponse: Decodable, Hashable {
    let comment: CommonGroundGalleryComment
}

/// An item's bytes from the content route.
struct CommonGroundGalleryContent: Hashable {
    let data: Data
    let contentType: String?
}
