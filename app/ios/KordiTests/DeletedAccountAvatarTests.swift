import SwiftUI
import XCTest
@testable import Kordi

/// The Deleted account stand-in is one flat muted square wherever it is drawn:
/// no picture, no generated avatar, no glyph and no initials.
@MainActor
final class DeletedAccountAvatarTests: XCTestCase {
    private let standIn = KordiDeletedAccount.accountId

    func testEveryPlaceTheStandInIsDrawnShowsThePlaceholder() {
        let avatars: [(String, IdentityAvatar)] = [
            // Chat list row and details hero of a kept chat: named Deleted account, seeded by the stand-in.
            ("chat row", IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .person, size: 44, seed: standIn)),
            // Transcript sender, from `MessageAuthorIdentity.deletedAccount`.
            ("sender", IdentityAvatar(
                name: MessageAuthorIdentity.deletedAccount.name,
                imageSource: MessageAuthorIdentity.deletedAccount.source,
                kind: .person, size: 28, seed: MessageAuthorIdentity.deletedAccount.seed
            )),
            // A group tile or member row: the stand-in's member row may carry a generated picture.
            ("group tile", IdentityAvatar(
                name: "Deleted account", imageSource: "https://cdn.example.test/avatars/marble/acct_kordi_deleted.png",
                kind: .person, size: 20, seed: standIn, cornerRadius: 1
            )),
            // A quote chip whose source message this iPhone has not loaded.
            ("quote chip", IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .person, size: 16, seed: "Deleted account")),
            ("unseeded", IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .person)),
        ]
        for (place, avatar) in avatars {
            XCTAssertTrue(avatar.showsDeletedAccountPlaceholder, place)
            XCTAssertNil(avatar.resolvedImageSource, "\(place): no remote or generated picture is requested")
        }
    }

    func testRealPeopleKeepTheirAvatars() {
        let lee = IdentityAvatar(name: "Lee Example", imageSource: nil, kind: .person, seed: "acct_lee")
        XCTAssertFalse(lee.showsDeletedAccountPlaceholder)
        XCTAssertNotNil(lee.resolvedImageSource, "a person keeps their generated avatar")

        // Someone who chose the name is still drawn as themselves.
        let namesake = IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .person, seed: "acct_sky")
        XCTAssertFalse(namesake.showsDeletedAccountPlaceholder)
        XCTAssertFalse(IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .group).showsDeletedAccountPlaceholder)
        XCTAssertFalse(IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .agent, seed: standIn).showsDeletedAccountPlaceholder)
    }

    /// Rendered, the placeholder is one colour edge to edge: nothing is drawn inside it.
    func testThePlaceholderIsAFlatSquare() throws {
        let placeholder = try pixels(IdentityAvatar(name: "Deleted account", imageSource: nil, kind: .person, size: 52, seed: standIn))
        XCTAssertFalse(placeholder.hasMarks(inside: 6...45), "no glyph, initials or picture")

        // The same check sees a person's initials.
        let initials = try pixels(IdentityAvatar(name: "Lee Example", imageSource: nil, kind: .person, size: 52))
        XCTAssertTrue(initials.hasMarks(inside: 6...45))
    }

    // MARK: Rendering

    private struct Pixels {
        let width: Int
        let bytes: [UInt8]

        func at(_ x: Int, _ y: Int) -> [UInt8] {
            let offset = (y * width + x) * 4
            return Array(bytes[offset..<offset + 4])
        }

        /// Whether any pixel of the square `range` by `range` differs from the
        /// one in the middle of its left edge, which is background.
        func hasMarks(inside range: ClosedRange<Int>) -> Bool {
            let mid = (range.lowerBound + range.upperBound) / 2
            let background = at(range.lowerBound, mid)
            for y in range { for x in range where at(x, y) != background { return true } }
            return false
        }
    }

    private func pixels(_ avatar: IdentityAvatar) throws -> Pixels {
        let renderer = ImageRenderer(content: avatar.environment(\.colorScheme, .light))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        let width = image.width
        let height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        XCTAssertTrue(drawn)
        XCTAssertGreaterThanOrEqual(width, 52)
        return Pixels(width: width, bytes: bytes)
    }
}
