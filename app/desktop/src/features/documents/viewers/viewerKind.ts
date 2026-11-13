// Which viewer the companion pane uses for a file, by its extension.
const RASTER_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'ico']);
// Documents, media, and archives the panel shows as a file card with Quick Look.
const FILE_CARD = new Set(['doc', 'docx', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages', 'zip', 'gz', 'tar', 'tgz', 'dmg', 'mov', 'mp4', 'm4v', 'webm', 'mp3', 'm4a', 'wav', 'aiff', 'flac', 'epub', 'psd', 'ai', 'sketch', 'fig']);

type ViewerKind = 'code' | 'table' | 'svg' | 'image' | 'pdf' | 'file';

/** Code and text, a table, an SVG drawing, a raster image, a PDF, or a file card with Quick Look. */
export function companionViewerKind(path: string | null | undefined): ViewerKind {
  const extension = extensionOf(path);
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (extension === 'svg') return 'svg';
  if (RASTER_IMAGES.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (FILE_CARD.has(extension)) return 'file';
  return 'code';
}

export function extensionOf(path: string | null | undefined) {
  return path?.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
}
