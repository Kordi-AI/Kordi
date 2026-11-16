import SwiftUI

/// A card's 4:3 thumbnail: the preview text drawn by kind (a Markdown page,
/// a code page or a small table), an image read from the content route, or
/// the type tile for anything else. Drawn in proportion to the card width.
struct CommonGroundGalleryThumbnail: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    let item: CommonGroundGalleryItem
    @State private var image: UIImage?

    private enum Look {
        case image(UIImage)
        case markdown([CommonGroundGalleryPreviewLine])
        case code([String])
        case table([[String]])
        case tile
    }

    private var look: Look {
        let kind = item.kind
        if kind == .image, let image { return .image(image) }
        guard let preview = item.preview?.nonEmpty else { return .tile }
        switch kind {
        case .markdown: return .markdown(CommonGroundGalleryPreviewLine.markdown(preview, title: item.title))
        case .code: return .code(preview.components(separatedBy: .newlines).prefix(12).map { $0 })
        case .table:
            let tabs = CommonGroundGalleryText.isTabSeparated(fileName: item.fileName, contentType: item.contentType)
            let rows = CommonGroundGalleryText.rows(preview, tabs: tabs, limit: 6, columns: 4)
            return rows.isEmpty ? .tile : .table(rows)
        default: return .tile
        }
    }

    var body: some View {
        let look = look
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        Color(uiColor: .systemGray5)
            .aspectRatio(4 / 3, contentMode: .fit)
            .overlay {
                GeometryReader { geometry in
                    page(look, size: geometry.size)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if case .tile = look {} else {
                    CommonGroundGalleryTypeTile(fileName: item.fileName, contentType: item.contentType, size: .chip)
                        .padding(6)
                }
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
            .task(id: item.itemId) {
                guard item.kind == .image, image == nil else { return }
                image = await model.galleryThumbnail(code: code, item: item)
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder private func page(_ look: Look, size: CGSize) -> some View {
        let width = size.width
        switch look {
        case .image(let image):
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height)
                .clipped()
        case .markdown(let lines):
            paper(width: width, fill: Color(uiColor: .secondarySystemGroupedBackground)) {
                VStack(alignment: .leading, spacing: width * 0.018) {
                    Text(item.title)
                        .font(.system(size: width * 0.05, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line.text)
                            .font(.system(size: width * 0.034, weight: line.bold ? .semibold : .regular,
                                          design: line.mono ? .monospaced : .default))
                            .foregroundStyle(line.bold ? Color.primary : Color.secondary)
                            .lineLimit(line.mono ? 1 : 2)
                    }
                }
            }
        case .code(let lines):
            paper(width: width, fill: Self.codeBackground) {
                Text(lines.joined(separator: "\n"))
                    .font(.system(size: width * 0.033, design: .monospaced))
                    .foregroundStyle(Self.codeText)
                    .lineSpacing(width * 0.012)
                    .fixedSize(horizontal: true, vertical: false)
            }
        case .table(let rows):
            paper(width: width, fill: Color(uiColor: .secondarySystemGroupedBackground)) {
                Grid(alignment: .leading, horizontalSpacing: width * 0.03, verticalSpacing: width * 0.014) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cell)
                                    .font(.system(size: width * 0.034, weight: index == 0 ? .semibold : .regular).monospacedDigit())
                                    .foregroundStyle(index == 0 ? Color.primary : Color.secondary)
                                    .lineLimit(1)
                            }
                        }
                        if index < rows.count - 1 { Divider().gridCellUnsizedAxes(.horizontal) }
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
        case .tile:
            CommonGroundGalleryTypeTile(fileName: item.fileName, contentType: item.contentType, size: .large)
                .frame(width: size.width, height: size.height)
        }
    }

    /// A page set into the card: inset at the top and sides, running off the bottom.
    private func paper<Content: View>(width: CGFloat, fill: Color, @ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, width * 0.065)
            .padding(.vertical, width * 0.06)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(fill, in: UnevenRoundedRectangle(topLeadingRadius: width * 0.02, topTrailingRadius: width * 0.02))
            .clipped()
            .padding(.top, width * 0.07)
            .padding(.horizontal, width * 0.08)
            .padding(.bottom, -width * 0.04)
    }

    static let codeBackground = Color(red: 30 / 255, green: 30 / 255, blue: 34 / 255)
    static let codeText = Color(red: 200 / 255, green: 200 / 255, blue: 208 / 255)
}

/// One line of a Markdown thumbnail: a heading in bold, a list item with a
/// bullet, fenced code in monospace, inline marks removed.
struct CommonGroundGalleryPreviewLine: Equatable {
    let text: String
    var bold = false
    var mono = false

    static func markdown(_ preview: String, title: String, limit: Int = 7) -> [Self] {
        var lines: [Self] = []
        var fenced = false
        for raw in preview.components(separatedBy: .newlines) {
            guard lines.count < limit else { break }
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                fenced.toggle()
                continue
            }
            guard !line.isEmpty else { continue }
            if fenced {
                lines.append(Self(text: line, mono: true))
            } else if line.hasPrefix("#") {
                let heading = plain(String(line.drop { $0 == "#" }))
                // The title already heads the page.
                if lines.isEmpty, heading.caseInsensitiveCompare(title) == .orderedSame { continue }
                if !heading.isEmpty { lines.append(Self(text: heading, bold: true)) }
            } else if let marker = ["- ", "* ", "+ "].first(where: { line.hasPrefix($0) }) {
                lines.append(Self(text: "• " + plain(String(line.dropFirst(marker.count)))))
            } else if line.hasPrefix("|") {
                let cells = line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                guard !cells.allSatisfy({ $0.allSatisfy { "-: ".contains($0) } }) else { continue }
                lines.append(Self(text: plain(cells.joined(separator: "   "))))
            } else {
                lines.append(Self(text: plain(line.hasPrefix(">") ? String(line.dropFirst()) : line)))
            }
        }
        return lines
    }

    /// Text without emphasis, code and link marks.
    private static func plain(_ text: String) -> String {
        var text = text
        for mark in ["**", "__", "`"] { text = text.replacingOccurrences(of: mark, with: "") }
        if let regex = try? NSRegularExpression(pattern: #"\[([^\]]*)\]\([^)]*\)"#) {
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "$1")
        }
        return text.trimmingCharacters(in: .whitespaces)
    }
}
