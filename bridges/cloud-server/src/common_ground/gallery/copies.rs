//! What a gallery item copies from its artifact: the title and a short text
//! preview. A share copies them from the text it reads; a save or rename of
//! the sharer's document copies them again (see [`super::refresh`]).

use crate::document_shares::model::DocumentFormat;
use crate::document_shares::render::{document_format, html_title, markdown_title};

use super::artifacts::Artifact;

/// Text files up to this size get a preview and a title from their text.
pub(super) const MAX_PREVIEW_SOURCE_BYTES: usize = 256 * 1024;
const PREVIEW_CHARS: usize = 800;
/// Characters of a document's stored text `GET gallery/candidates` reads
/// for its title.
pub(in crate::common_ground) const HEAD_CHARS: i32 = 16_384;

/// File extensions read as text when the content type does not say.
const TEXT_EXTENSIONS: &[&str] = &[
    "adoc", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "go", "h", "hpp", "htm", "html",
    "ini", "java", "js", "json", "jsonl", "jsx", "kt", "log", "markdown", "md", "mdx", "mjs",
    "php", "py", "rb", "rs", "rst", "scss", "sh", "sql", "swift", "toml", "ts", "tsv", "tsx",
    "txt", "vue", "xml", "yaml", "yml",
];

/// Non-`text/*` content types that are text.
const TEXT_APPLICATION_TYPES: &[&str] = &[
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-sh",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/sql",
    "application/xhtml+xml",
];

/// Whether a file is text a preview can quote: Markdown, plain text, code,
/// CSV/TSV or JSON by its content type, or by its extension when the type
/// is missing or generic.
pub(in crate::common_ground) fn text_like(content_type: Option<&str>, file_name: &str) -> bool {
    let essence = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if essence.starts_with("text/") || TEXT_APPLICATION_TYPES.contains(&essence.as_str()) {
        return true;
    }
    if !essence.is_empty() && essence != "application/octet-stream" {
        return false;
    }
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match base.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            TEXT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// Whether a share reads `artifact`'s text: a text file of at most
/// [`MAX_PREVIEW_SOURCE_BYTES`].
pub(super) fn reads_text(artifact: &Artifact) -> bool {
    text_like(artifact.content_type.as_deref(), &artifact.file_name)
        && artifact
            .size_bytes
            .is_none_or(|size| size <= MAX_PREVIEW_SOURCE_BYTES as i64)
}

/// `bytes` as text a gallery item can copy from: valid UTF-8, without a
/// leading byte order mark, and without NUL, which Postgres text cannot
/// hold and text files do not have; `None` for anything else.
pub(in crate::common_ground) fn readable_text(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    (!text.contains('\0')).then_some(text)
}

/// The title and preview a gallery item copies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::common_ground) struct Copies {
    pub title: String,
    pub preview: Option<String>,
}

/// What a gallery item copies from `artifact` given its text (`None` when
/// it is not text or could not be read): the title of a Markdown or HTML
/// document from its text (see [`title`]), and a preview of the first
/// [`PREVIEW_CHARS`] characters of text that is not blank.
pub(in crate::common_ground) fn copies(artifact: &Artifact, text: Option<&str>) -> Copies {
    Copies {
        title: title(artifact, text),
        preview: text
            .filter(|text| !text.trim().is_empty())
            .map(|text| text.chars().take(PREVIEW_CHARS).collect()),
    }
}

/// A Markdown document's first level-1 heading or an HTML document's
/// `<title>`, as the chat reader shows it; else the title without the text
/// ([`Artifact::title`]).
fn title(artifact: &Artifact, text: Option<&str>) -> String {
    let content_type = artifact.content_type.as_deref().unwrap_or_default();
    let found = match (text, document_format(content_type, &artifact.file_name)) {
        (Some(text), Some(DocumentFormat::Markdown)) => markdown_title(text),
        (Some(text), Some(DocumentFormat::Html)) => html_title(text),
        _ => None,
    };
    found.unwrap_or_else(|| artifact.title.clone())
}

/// The title `GET gallery/candidates` shows: [`copies`]' title from the
/// first [`HEAD_CHARS`] characters of the document's stored text, without
/// their last line when the text may continue past them; without stored
/// text, [`Artifact::title`].
pub(in crate::common_ground) fn candidate_title(artifact: &Artifact) -> String {
    let Some(head) = artifact.head.as_deref() else {
        return artifact.title.clone();
    };
    let head = if head.chars().count() >= HEAD_CHARS as usize {
        head.rfind('\n').map_or("", |end| &head[..end])
    } else {
        head
    };
    title(artifact, readable_text(head.as_bytes()))
}
