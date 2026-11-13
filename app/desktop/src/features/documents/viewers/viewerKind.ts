// Which viewer the companion pane uses for a file, by its extension.
const RASTER_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'ico']);
// Files the panel cannot draw yet; they get a way out instead of a misleading error.
export const NO_PREVIEW = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages', 'zip', 'gz', 'tar', 'mov', 'mp4', 'mp3', 'wav']);

type ViewerKind = 'code' | 'table' | 'svg' | 'image';

/** Code and text, a table, an SVG drawing, or a raster image. */
export function companionViewerKind(path: string | null | undefined): ViewerKind {
  const extension = extensionOf(path);
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (extension === 'svg') return 'svg';
  if (RASTER_IMAGES.has(extension)) return 'image';
  return 'code';
}

export function extensionOf(path: string | null | undefined) {
  return path?.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
}
