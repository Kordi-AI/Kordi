import SwiftUI
import UniformTypeIdentifiers

/// How a gallery item reads: which thumbnail and viewer draw it, and its
/// short type label. The file name decides first, then the content type, as
/// on the Mac.
enum CommonGroundGalleryKind: Equatable {
    case markdown, html, code, table, image, pdf, file

    private static let rasterImages: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "bmp", "ico", "tif", "tiff"]
    /// Documents, media and archives shown as a file with Quick Look. SVG
    /// joins them here because UIImage cannot draw it.
    private static let fileCards: Set<String> = [
        "doc", "docx", "rtf", "xls", "xlsx", "ppt", "pptx", "key", "numbers", "pages", "zip", "gz", "tar", "tgz", "dmg",
        "mov", "mp4", "m4v", "webm", "mp3", "m4a", "wav", "aiff", "flac", "epub", "psd", "ai", "sketch", "fig", "svg",
    ]
    private static let textTypeMarkers = ["json", "xml", "javascript", "typescript", "yaml", "toml", "x-sh", "sql"]

    static func of(fileName: String, contentType: String?) -> Self {
        let ext = fileExtension(fileName)
        let type = essence(contentType)
        guard !ext.isEmpty else { return forType(type) ?? (isText(type) ? .code : .file) }
        if ["md", "markdown", "mdx"].contains(ext) { return .markdown }
        if ext == "html" || ext == "htm" { return .html }
        if ext == "csv" || ext == "tsv" { return .table }
        if rasterImages.contains(ext) { return .image }
        if ext == "pdf" { return .pdf }
        if fileCards.contains(ext) { return .file }
        // Any other extension reads as code unless the server says the file is not text.
        return isText(type) ? .code : forType(type) ?? .file
    }

    private static func forType(_ type: String) -> Self? {
        switch type {
        case "text/markdown", "text/x-markdown": .markdown
        case "text/html": .html
        case "text/csv", "text/tab-separated-values": .table
        case "application/pdf": .pdf
        case "image/svg+xml": .file
        default: type.hasPrefix("image/") ? .image : nil
        }
    }

    /// No type, or one that is text.
    private static func isText(_ type: String) -> Bool {
        type.isEmpty || type.hasPrefix("text/") || textTypeMarkers.contains { type.contains($0) }
    }

    /// The lowercased extension of a file name, or "".
    static func fileExtension(_ fileName: String) -> String {
        let base = fileName.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? fileName
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return String(base[base.index(after: dot)...]).lowercased()
    }

    /// "text/csv" from "text/csv; charset=utf-8".
    static func essence(_ contentType: String?) -> String {
        (contentType ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    }

    /// Read as text: the bytes decode into the Markdown, HTML, code or table view.
    var isText: Bool { self == .markdown || self == .html || self == .code || self == .table }

    /// Above these sizes the item screen shows the file row instead of
    /// reading the file into memory.
    static let textViewMaxBytes = 2 * 1024 * 1024
    static let mediaViewMaxBytes = 25 * 1024 * 1024

    /// The kind the item screen draws: a file too large to read there is a
    /// file row; an unknown size is read.
    func forViewing(sizeBytes: Int?) -> Self {
        guard let sizeBytes else { return self }
        let limit = isText ? Self.textViewMaxBytes : self == .image || self == .pdf ? Self.mediaViewMaxBytes : nil
        guard let limit, sizeBytes > limit else { return self }
        return .file
    }

    private var label: String {
        switch self {
        case .markdown: "MD"
        case .html: "HTML"
        case .code: "CODE"
        case .table: "CSV"
        case .image: "IMG"
        case .pdf: "PDF"
        case .file: "FILE"
        }
    }

    /// The type chip: the file's own extension when short, else the kind's label.
    func typeLabel(fileName: String) -> String {
        let ext = Self.fileExtension(fileName)
        if ext == "markdown" { return "MD" }
        return !ext.isEmpty && ext.count <= 5 ? ext.uppercased() : label
    }

    /// The type tile's colour, one per kind.
    var tint: Color {
        switch self {
        case .markdown: KordiTheme.brandCyan
        case .html: .orange
        case .code: KordiTheme.agentViolet
        case .table: .green
        case .image: .teal
        case .pdf: .red
        case .file: Color(uiColor: .systemGray)
        }
    }
}

/// Reading a gallery file's text: UTF-8 without a byte order mark, and the
/// first rows of a CSV or TSV file.
enum CommonGroundGalleryText {
    static func decode(_ data: Data) -> String? {
        guard var text = String(data: data, encoding: .utf8) else { return nil }
        if text.hasPrefix("\u{feff}") { text.removeFirst() }
        return text
    }

    static func isTabSeparated(fileName: String, contentType: String?) -> Bool {
        CommonGroundGalleryKind.fileExtension(fileName) == "tsv"
            || CommonGroundGalleryKind.essence(contentType) == "text/tab-separated-values"
    }

    /// Up to `limit` rows of up to `columns` cells. Quoted cells may hold
    /// the separator and doubled quotes; a quoted line break ends the row.
    static func rows(_ text: String, tabs: Bool, limit: Int, columns: Int = 12) -> [[String]] {
        let separator: Character = tabs ? "\t" : ","
        var rows: [[String]] = []
        for line in text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            guard rows.count < limit else { break }
            var cells: [String] = []
            var cell = ""
            var quoted = false
            var previous: Character?
            for character in line {
                if character == "\"" {
                    // A quote right after a closing quote is a doubled, literal one.
                    if !quoted, previous == "\"" {
                        cell.append("\"")
                        quoted = true
                    } else {
                        quoted.toggle()
                    }
                } else if character == separator, !quoted {
                    cells.append(cell)
                    cell = ""
                } else {
                    cell.append(character)
                }
                previous = character
            }
            cells.append(cell)
            rows.append(Array(cells.prefix(columns)).map { $0.trimmingCharacters(in: .whitespaces) })
        }
        return rows
    }

    /// A file name Quick Look can read: the item's name, given an extension
    /// from its content type when it has none.
    static func fileName(for item: CommonGroundGalleryItem, contentType: String?) -> String {
        var name = item.fileName.nonEmpty ?? item.title
        name = String(name.map { "/:\\".contains($0) ? "-" : $0 })
        guard CommonGroundGalleryKind.fileExtension(name).isEmpty else { return name }
        let type = CommonGroundGalleryKind.essence(contentType ?? item.contentType)
        if let ext = UTType(mimeType: type)?.preferredFilenameExtension { return "\(name).\(ext)" }
        return name
    }
}
