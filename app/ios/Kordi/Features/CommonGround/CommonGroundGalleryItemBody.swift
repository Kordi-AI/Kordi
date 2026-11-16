import SwiftUI
import UIKit

/// What the item screen shows of the artifact: still loading, could not be
/// read, a file opened through Quick Look, or its contents by kind.
enum CommonGroundGalleryContentPhase {
    case loading
    case failed
    case file
    case text(String)
    case html(Data)
    case image(UIImage)

    /// Code longer than this shows its start; Open shows the whole file.
    static let textLimit = 100_000

    var isReady: Bool {
        switch self {
        case .text, .html, .image: true
        case .loading, .failed, .file: false
        }
    }

    static func make(kind: CommonGroundGalleryKind, content: CommonGroundGalleryContent) -> Self {
        switch kind {
        case .image:
            return UIImage(data: content.data).map(Self.image) ?? .failed
        case .html:
            return CommonGroundGalleryText.decode(content.data) == nil ? .failed : .html(content.data)
        case .markdown, .code, .table:
            return CommonGroundGalleryText.decode(content.data).map(Self.text) ?? .failed
        case .pdf, .file:
            return .file
        }
    }
}

/// The artifact read-only, with the app's viewers: Markdown rendered as in
/// chat, HTML in the document reader's sandboxed web view, code and plain
/// text monospaced, a CSV or TSV file as a table, images inline, and PDFs
/// and other files through Quick Look.
struct CommonGroundGalleryItemBody: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let item: CommonGroundGalleryItem
    let phase: CommonGroundGalleryContentPhase
    let opening: Bool
    let open: () -> Void
    @State private var htmlHeight: CGFloat = 320

    private static let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

    var body: some View {
        switch phase {
        case .loading:
            note { ProgressView("Loading") }
        case .failed:
            note {
                Text("Can't open this file")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case .file:
            fileRow
        case .html(let data):
            DocumentHTMLView(data: data, contentHeight: $htmlHeight)
                .frame(height: htmlHeight)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.shape)
                .clipShape(Self.shape)
        case .image(let image):
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
                .background(Color(uiColor: .systemGray5))
                .clipShape(Self.shape)
                .accessibilityLabel(item.title)
        case .text(let text):
            textBody(text)
        }
    }

    @ViewBuilder private func textBody(_ text: String) -> some View {
        switch item.kind {
        case .markdown:
            MarkdownMessageContent(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.shape)
        case .table:
            table(text)
        default:
            code(text)
        }
    }

    private func code(_ text: String) -> some View {
        let shown = text.count > CommonGroundGalleryContentPhase.textLimit
            ? String(text.prefix(CommonGroundGalleryContentPhase.textLimit)) + "\n…"
            : text
        return ScrollView(.horizontal, showsIndicators: false) {
            Text(shown)
                .font(.footnote.monospaced())
                .foregroundStyle(CommonGroundGalleryThumbnail.codeText)
                .fixedSize(horizontal: true, vertical: false)
                .padding(14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CommonGroundGalleryThumbnail.codeBackground, in: Self.shape)
        .environment(\.colorScheme, .dark)
    }

    private func table(_ text: String) -> some View {
        let tabs = CommonGroundGalleryText.isTabSeparated(fileName: item.fileName, contentType: item.contentType)
        let rows = CommonGroundGalleryText.rows(text, tabs: tabs, limit: 200)
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                                .font(.footnote.weight(index == 0 ? .semibold : .regular).monospacedDigit())
                                .foregroundStyle(index == 0 ? Color.primary : Color.secondary)
                                .lineLimit(1)
                        }
                    }
                    if index < rows.count - 1 { Divider().gridCellUnsizedAxes(.horizontal) }
                }
            }
            .padding(14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.shape)
    }

    private var fileRow: some View {
        let size = item.sizeBytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
        return CommonGroundSection {
            Button(action: open) {
                HStack(spacing: 12) {
                    CommonGroundGalleryTypeTile(fileName: item.fileName, contentType: item.contentType)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.fileName.nonEmpty ?? item.title)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if let size {
                            Text(size)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    if opening {
                        ProgressView()
                    } else {
                        Text("Open")
                            .font(.body)
                            .foregroundStyle(chatTheme.accent)
                    }
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .padding(.vertical, 8)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(SessionRowButtonStyle())
            .disabled(opening)
        }
    }

    private func note<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, minHeight: 120)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.shape)
    }
}

/// Files written for Quick Look, one folder per item under the temporary directory.
enum CommonGroundGalleryFiles {
    static func write(_ content: CommonGroundGalleryContent, item: CommonGroundGalleryItem) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-gallery", isDirectory: true)
            .appendingPathComponent(item.itemId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "item", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(CommonGroundGalleryText.fileName(for: item, contentType: content.contentType))
        try content.data.write(to: url, options: .atomic)
        return url
    }
}
