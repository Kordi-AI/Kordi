// How a Gallery item reads: its kind (which viewer and thumbnail draw it), its short type label, and
// who shared it. Kinds follow the file name first, then the content type.

import { companionViewerKind, extensionOf } from '@/features/documents/viewers/viewerKind';
import type { ArtifactThumbnailKind } from '@/pages/artifactThumbnail';
import { firstName } from './storeGroupInvites';
import type { CgGalleryItem } from './types';

export type CgGalleryKind = 'markdown' | 'html' | 'code' | 'table' | 'image' | 'pdf' | 'file';

const TEXT_TYPE = /^text\/|json|xml|javascript|typescript|yaml|toml|x-sh|sql/;

function kindForType(contentType: string): CgGalleryKind | null {
  if (contentType === 'text/markdown' || contentType === 'text/x-markdown') return 'markdown';
  if (contentType === 'text/html') return 'html';
  if (contentType === 'text/csv' || contentType === 'text/tab-separated-values') return 'table';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  return null;
}

export function galleryKind(fileName: string, contentType: string | null): CgGalleryKind {
  const extension = extensionOf(fileName);
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!extension) return kindForType(type) ?? (!type || TEXT_TYPE.test(type) ? 'code' : 'file');
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (extension === 'html' || extension === 'htm') return 'html';
  const viewer = companionViewerKind(fileName);
  if (viewer === 'table') return 'table';
  if (viewer === 'image' || viewer === 'svg') return 'image';
  if (viewer === 'pdf' || viewer === 'file') return viewer;
  // Any other extension reads as code unless the server says the file is not text.
  return !type || TEXT_TYPE.test(type) ? 'code' : kindForType(type) ?? 'file';
}

/** True for kinds read as text: their bytes decode into the code, table, Markdown or HTML view. */
export const isTextKind = (kind: CgGalleryKind) => kind === 'markdown' || kind === 'html' || kind === 'code' || kind === 'table';

const KIND_LABELS: Record<CgGalleryKind, string> = { markdown: 'MD', html: 'HTML', code: 'CODE', table: 'CSV', image: 'IMG', pdf: 'PDF', file: 'FILE' };

/** The type chip: the file's own extension when short, else the kind's. */
export function galleryTypeLabel(fileName: string, kind: CgGalleryKind): string {
  const extension = extensionOf(fileName);
  if (extension === 'markdown') return 'MD';
  return extension && extension.length <= 5 ? extension.toUpperCase() : KIND_LABELS[kind];
}

/** How a card draws its thumbnail from the item's preview text; null shows the type tile. */
export function galleryThumbnailKind(fileName: string, kind: CgGalleryKind): ArtifactThumbnailKind | null {
  if (kind === 'markdown') return 'markdown';
  if (kind === 'table') return 'table';
  if (kind === 'code') return extensionOf(fileName) === 'json' ? 'json' : 'source';
  return null;
}

/** "You" for my own items and comments, otherwise the person's first name (card) or full name. */
export function galleryAuthor(entry: Pick<CgGalleryItem, 'mine' | 'person'>, full = false): string {
  if (entry.mine) return 'You';
  const name = entry.person.name.trim() || 'Someone';
  return full ? name : firstName(name);
}

/** Room topics that have at least one item, in the room's order. */
export function galleryTopics(roomTopics: string[], items: CgGalleryItem[]): string[] {
  const used = new Set(items.map((item) => item.topic).filter(Boolean));
  return roomTopics.filter((topic) => used.has(topic));
}

/** `About "<title>": `, prefilled in the chat when Message is used from an item. */
export const galleryMessageDraft = (title: string) => `About "${title}": `;

export function formatGallerySize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
