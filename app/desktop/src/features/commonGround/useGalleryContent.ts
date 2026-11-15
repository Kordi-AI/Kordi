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
const thumbnails = new Map<string, Promise<string | null>>();

/** An image item's object URL for its card, read once per item and kept while the page is open. */
function thumbnailUrl(client: ContentClient, code: string, itemId: string): Promise<string | null> {
  const key = `${code}:${itemId}`;
  const cached = thumbnails.get(key);
  if (cached) return cached;
  const next = client.galleryContent(code, itemId).then((blob) => URL.createObjectURL(blob)).catch(() => {
    thumbnails.delete(key);
    return null;
  });
  thumbnails.set(key, next);
  if (thumbnails.size > MAX_THUMBNAILS) {
    const [oldestKey, oldest] = thumbnails.entries().next().value as [string, Promise<string | null>];
    thumbnails.delete(oldestKey);
    void oldest.then((url) => { if (url) URL.revokeObjectURL(url); });
  }
  return next;
}

/** The object URL of an image card once it is near the viewport; null until then or when it fails. */
export function useGalleryThumbnailUrl(client: ContentClient, code: string, itemId: string, active: boolean): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${code}:${itemId}`;
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void thumbnailUrl(client, code, itemId).then((url) => { if (!cancelled) setLoaded({ key, url }); });
    return () => { cancelled = true; };
  }, [active, client, code, itemId, key]);
  return loaded?.key === key ? loaded.url : null;
}
