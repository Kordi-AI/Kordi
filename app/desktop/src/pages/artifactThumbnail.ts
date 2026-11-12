import { useEffect, useRef, useState } from 'react';

import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { documentShareApiForEnvironment, type DocumentShareApi } from '@/features/documents/documentShareApi';
import { documentFormatForPath } from '@/features/documents/documentReaderModel';
import { rememberDocumentTitle } from '@/features/documents/documentTitles';
import type { SessionArtifact } from '@/kordi-app/types';

import { artifactPreviewKind } from './artifactPreviewFormat';
import { loadArtifactPreview } from './artifactPreviewLoader';

export type ArtifactThumbnailKind = ReturnType<typeof artifactPreviewKind>;

/** The first part of an artifact a card draws: its text and how to draw it. */
export type ArtifactThumbnailSource = { kind: ArtifactThumbnailKind; source: string };

export type ArtifactThumbnailState =
  | { status: 'loading' }
  | { status: 'ready'; thumbnail: ArtifactThumbnailSource }
  /** Nothing to draw: the card shows the file-type mark. */
  | { status: 'none' };

export type ArtifactThumbnailContext = {
  isNativeShell: boolean;
  baseRoot?: string | null;
  /** Reads cloud documents; tests and the visual page pass an in-memory version. */
  api?: Pick<DocumentShareApi, 'getDocument' | 'getDocumentRaw'> | null;
};

/** A card needs only the top of the file; this keeps Markdown and HTML rendering cheap. */
export const THUMBNAIL_SOURCE_CHARS = 6000;
const MAX_CACHED = 200;
const MAX_CONCURRENT = 3;

const cache = new Map<string, Promise<ArtifactThumbnailSource | null>>();
let running = 0;
const queue: Array<() => void> = [];

function runLimited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      task().then(resolve, reject).finally(() => {
        running -= 1;
        queue.shift()?.();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

/** Changes whenever the artifact may have new content, so a card redraws after an edit. */
export function artifactThumbnailKey(artifact: SessionArtifact, baseRoot?: string | null) {
  const root = artifact.pinned ? '' : baseRoot ?? '';
  return [root, artifact.id, artifact.path, artifact.attachmentId ?? '', artifact.timeLabel ?? '', artifact.live ? 'live' : 'ready'].join('\u0000');
}

function clip(source: string) {
  return source.length > THUMBNAIL_SOURCE_CHARS ? source.slice(0, THUMBNAIL_SOURCE_CHARS) : source;
}

let apiOverride: ArtifactThumbnailContext['api'] | undefined;

/** Lets tests and the login-free visual page read cloud documents from memory, for thumbnails and opening. */
export function setArtifactThumbnailApiForPreview(api: ArtifactThumbnailContext['api'] | undefined) {
  apiOverride = api;
  cache.clear();
}

/** The server API for reading cloud documents, or the preview's in-memory one. */
export function artifactDocumentApi() {
  if (apiOverride !== undefined) return apiOverride;
  try {
    return documentShareApiForEnvironment();
  } catch {
    return null;
  }
}

async function loadCloudDocument(artifact: SessionArtifact, api: NonNullable<ArtifactThumbnailContext['api']>): Promise<ArtifactThumbnailSource | null> {
  const attachmentId = artifact.attachmentId?.trim();
  const format = documentFormatForPath(artifact.path);
  if (!attachmentId || !format) return null;
  if (format === 'html') return { kind: 'html', source: clip(await api.getDocumentRaw(attachmentId)) };
  const document = await api.getDocument(attachmentId);
  rememberDocumentTitle(attachmentId, document.title);
  return { kind: 'markdown', source: clip(document.blocks.map((block) => block.source).join('\n\n')) };
}

async function loadLocalFile(artifact: SessionArtifact, context: ArtifactThumbnailContext): Promise<ArtifactThumbnailSource | null> {
  if (!context.isNativeShell && !isBrowserAppRuntime()) return null;
  const preview = await loadArtifactPreview({
    isNativeShell: context.isNativeShell,
    path: artifact.path,
    attachmentId: artifact.attachmentId,
    baseRoot: artifact.pinned ? null : context.baseRoot,
  });
  return { kind: artifactPreviewKind(preview.path || artifact.path), source: clip(preview.lines.map((line) => line.text).join('\n')) };
}

/** Reads the top of an artifact: the cloud copy of a shared document first, then the file on this Mac. */
export async function loadArtifactThumbnail(artifact: SessionArtifact, context: ArtifactThumbnailContext): Promise<ArtifactThumbnailSource | null> {
  // Images are binary; the card shows the file-type mark instead of reading them as text.
  if (artifactPreviewKind(artifact.path) === 'image') return null;
  const api = context.api === undefined ? artifactDocumentApi() : context.api;
  if (api && artifact.attachmentId?.trim() && documentFormatForPath(artifact.path)) {
    try {
      const cloud = await loadCloudDocument(artifact, api);
      if (cloud) return cloud;
    } catch {
      // Fall back to the copy on this Mac, if there is one.
    }
  }
  try {
    return await loadLocalFile(artifact, context);
  } catch {
    return null;
  }
}

function cachedThumbnail(key: string, load: () => Promise<ArtifactThumbnailSource | null>) {
  const existing = cache.get(key);
  if (existing) return existing;
  const request = runLimited(load);
  cache.set(key, request);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return request;
}

export function resetArtifactThumbnailsForTests() {
  cache.clear();
}

/** Loads a card's thumbnail once per artifact revision; cards that scroll back in reuse it. */
export function useArtifactThumbnail(artifact: SessionArtifact, context: ArtifactThumbnailContext, enabled = true): ArtifactThumbnailState {
  const key = artifactThumbnailKey(artifact, context.baseRoot);
  const [state, setState] = useState<{ key: string; value: ArtifactThumbnailState }>({ key: '', value: { status: 'loading' } });

  // The key covers every field the load reads; the latest artifact and context are read when it changes.
  const loadRef = useRef(() => loadArtifactThumbnail(artifact, context));
  useEffect(() => {
    loadRef.current = () => loadArtifactThumbnail(artifact, context);
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    cachedThumbnail(key, () => loadRef.current())
      .then((thumbnail) => {
        if (!cancelled) setState({ key, value: thumbnail && thumbnail.source.trim() ? { status: 'ready', thumbnail } : { status: 'none' } });
      })
      .catch(() => {
        if (!cancelled) setState({ key, value: { status: 'none' } });
      });
    return () => { cancelled = true; };
  }, [enabled, key]);

  return state.key === key ? state.value : { status: 'loading' };
}
