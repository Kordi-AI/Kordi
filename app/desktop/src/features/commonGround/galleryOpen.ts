import { openArtifactExternally } from '@/features/documents/openArtifactExternally';
import { openDesktopChatArtifactCopy } from '@/lib/desktopArtifactOpen';
import type { CgGalleryItem } from './types';

/**
 * Opens a shared text file in its default app on this Mac, from the bytes the item screen read: the
 * Artifacts open action, given a fresh copy of the file under its name. Images, PDFs and other
 * binary files have no such copy, so they offer no open button.
 */
export function openGalleryItemExternally(item: CgGalleryItem, text: string, openCopy = openDesktopChatArtifactCopy) {
  const name = item.fileName || item.title;
  return openArtifactExternally(
    { id: item.itemId, path: name, name: item.title, kind: 'file', summary: '', pinned: true },
    null,
    { api: null, open: () => openCopy(name, text) },
  );
}
