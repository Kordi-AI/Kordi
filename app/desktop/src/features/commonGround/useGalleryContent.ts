import { useEffect, useState } from 'react';

import type { CommonGroundClient } from './client';
import { isTextKind, type CgGalleryKind } from './galleryFormat';

type ContentClient = Pick<CommonGroundClient, 'galleryContent'>;

/** A shared file read for its viewer: text for text kinds, an object URL for images and PDFs. */
export type CgGalleryContent =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; text: string; url: null; sizeBytes: number }
  | { status: 'ready'; text: null; url: string; sizeBytes: number };

/** Whether a kind needs the file's bytes at all; other files show a file card without them. */
export const needsContent = (kind: CgGalleryKind) => isTextKind(kind) || kind === 'image' || kind === 'pdf';

/**
 * Reads the open item's file through the authenticated content route once per item. Object URLs are
 * revoked when the item closes.
 */
export function useGalleryContent(client: ContentClient, code: string, itemId: string, kind: CgGalleryKind): CgGalleryContent {
  const [loaded, setLoaded] = useState<{ key: string; content: CgGalleryContent } | null>(null);
  const key = `${code}:${itemId}:${kind}`;
  const wanted = needsContent(kind);
  useEffect(() => {
    if (!wanted) return undefined;
    let cancelled = false;
    let url: string | null = null;
    client.galleryContent(code, itemId).then(async (blob) => {
      if (cancelled) return;
      if (isTextKind(kind)) {
        const text = await blob.text();
        if (!cancelled) setLoaded({ key, content: { status: 'ready', text, url: null, sizeBytes: blob.size } });
        return;
      }
      url = URL.createObjectURL(blob);
      setLoaded({ key, content: { status: 'ready', text: null, url, sizeBytes: blob.size } });
    }).catch(() => {
      if (!cancelled) setLoaded({ key, content: { status: 'failed' } });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, code, itemId, kind, key, wanted]);
  return loaded?.key === key ? loaded.content : { status: wanted ? 'loading' : 'failed' };
}

const MAX_THUMBNAILS = 60;
type Thumbnail = { url: Promise<string | null>; users: number };
/** Least recently used first; an entry a mounted card uses is never evicted or revoked. */
const thumbnails = new Map<string, Thumbnail>();

/** Evicts unused entries, oldest first, while more than `MAX_THUMBNAILS` are kept; may stay over while cards use them. */
function evictThumbnails() {
  for (const [key, entry] of thumbnails) {
    if (thumbnails.size <= MAX_THUMBNAILS) return;
    if (entry.users > 0) continue;
    thumbnails.delete(key);
    void entry.url.then((url) => { if (url) URL.revokeObjectURL(url); });
  }
}

/** Retains an image item's thumbnail for a mounted card, read once per item and marked most recently used. */
function retainThumbnail(client: ContentClient, code: string, itemId: string): Thumbnail {
  const key = `${code}:${itemId}`;
  const cached = thumbnails.get(key);
  if (cached) {
    thumbnails.delete(key);
    thumbnails.set(key, cached);
    cached.users += 1;
    return cached;
  }
  const entry: Thumbnail = {
    users: 1,
    // A failed read leaves the cache so a later mount asks again.
    url: client.galleryContent(code, itemId).then((blob) => URL.createObjectURL(blob)).catch(() => {
      if (thumbnails.get(key) === entry) thumbnails.delete(key);
      return null;
    }),
  };
  thumbnails.set(key, entry);
  evictThumbnails();
  return entry;
}

function releaseThumbnail(entry: Thumbnail) {
  entry.users = Math.max(0, entry.users - 1);
  evictThumbnails();
}

/** The object URL of an image card once it is near the viewport; null until then or when it fails. */
export function useGalleryThumbnailUrl(client: ContentClient, code: string, itemId: string, active: boolean): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${code}:${itemId}`;
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const entry = retainThumbnail(client, code, itemId);
    void entry.url.then((url) => { if (!cancelled) setLoaded({ key, url }); });
    return () => {
      cancelled = true;
      releaseThumbnail(entry);
    };
  }, [active, client, code, itemId, key]);
  return loaded?.key === key ? loaded.url : null;
}
