import Foundation

/// Typed calls for a room's gallery under `/v1/cloud/common-ground/rooms/:code/gallery`.
/// An older server answers every one with a 404 that carries no Common
/// ground error code; see `CommonGroundModel.isGalleryRouteMissing`.
extension CloudAPIClient {
    private static let gallerySegmentCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private func galleryPath(_ code: String, _ rest: String = "") -> String {
        "/v1/cloud/common-ground/rooms/\(gallerySegment(code))/gallery" + (rest.isEmpty ? "" : "/\(rest)")
    }

    private func gallerySegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: Self.gallerySegmentCharacters) ?? value
    }

    func commonGroundGallery(token: String, code: String) async throws -> CommonGroundGalleryList {
        try await send(path: galleryPath(code), method: "GET", token: token, fallback: "Could not load the gallery.")
    }

    /// My artifacts, newest first, each marked when already in this gallery.
    func commonGroundGalleryCandidates(token: String, code: String) async throws -> [CommonGroundGalleryCandidate] {
        let response: CommonGroundGalleryCandidates = try await send(
            path: galleryPath(code, "candidates"), method: "GET", token: token, fallback: "Could not load your artifacts."
        )
        return response.artifacts
    }

    /// Shares 1 to 8 of my artifacts with an optional topic.
    func shareToCommonGroundGallery(token: String, code: String, attachmentIds: [String], topic: String?) async throws -> [CommonGroundGalleryItem] {
        struct Body: Encodable { let attachmentIds: [String]; let topic: String? }
        let response: CommonGroundGalleryShared = try await send(
            path: galleryPath(code), method: "POST", token: token,
            body: Body(attachmentIds: attachmentIds, topic: topic), fallback: "Could not share."
        )
        return response.items
    }

    func removeFromCommonGroundGallery(token: String, code: String, itemId: String) async throws {
        try await sendWithoutResponse(
            path: galleryPath(code, gallerySegment(itemId)), method: "DELETE", token: token, fallback: "Could not remove it."
        )
    }

    func commonGroundGalleryItem(token: String, code: String, itemId: String) async throws -> CommonGroundGalleryItemView {
        try await send(path: galleryPath(code, gallerySegment(itemId)), method: "GET", token: token, fallback: "Could not load this item.")
    }

    func addCommonGroundGalleryComment(token: String, code: String, itemId: String, body: String) async throws -> CommonGroundGalleryComment {
        struct Body: Encodable { let body: String }
        let response: CommonGroundGalleryCommentResponse = try await send(
            path: galleryPath(code, "\(gallerySegment(itemId))/comments"), method: "POST", token: token,
            body: Body(body: body), fallback: "Could not add the comment."
        )
        return response.comment
    }

    func deleteCommonGroundGalleryComment(token: String, code: String, itemId: String, commentId: String) async throws {
        try await sendWithoutResponse(
            path: galleryPath(code, "\(gallerySegment(itemId))/comments/\(gallerySegment(commentId))"), method: "DELETE",
            token: token, fallback: "Could not delete the comment."
        )
    }

    /// The item's bytes and content type, read like attachment content.
    func commonGroundGalleryContent(token: String, code: String, itemId: String) async throws -> CommonGroundGalleryContent {
        let fallback = "Could not open this file."
        var request = try makeRequest(
            path: galleryPath(code, "\(gallerySegment(itemId))/content"), method: "GET", token: token, query: [], body: nil
        )
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 90
        do {
            let (data, response) = try await transportData(for: request, fallback: fallback)
            try validate(response: response, data: data, fallback: fallback)
            let contentType = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")
            return CommonGroundGalleryContent(data: data, contentType: contentType)
        } catch let error as CloudAPIError {
            throw error
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) { throw CancellationError() }
            throw CloudAPIError(code: "network_error", message: fallback, statusCode: 0)
        }
    }
}
