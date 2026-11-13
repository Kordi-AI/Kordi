import { useEffect, useState } from 'react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { SessionArtifact } from '@/kordi-app/types';

import {
  loadArtifactImage,
  loadArtifactPdf,
  loadArtifactQuickLookThumbnail,
  quickLookArtifact,
  type ArtifactImage,
  type ArtifactQuickLookThumbnail,
} from './artifactPreviewLoader';
import { companionViewerKind } from './viewers/viewerKind';

export type CompanionBinaryFile = {
  image: ArtifactImage | null;
  pdf: ArtifactImage | null;
  thumbnail: ArtifactQuickLookThumbnail | null;
};

const EMPTY: CompanionBinaryFile = { image: null, pdf: null, thumbnail: null };

async function downloadCloudCopy(attachmentId: string) {
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  return defaultCloudAuthClient().downloadAttachmentContent(session.token, attachmentId);
}

/**
 * Reads a companion tab's file as bytes when its viewer needs them: an image, a PDF (as an object
 * URL it revokes), or the Quick Look thumbnail of a file shown as a card. Files on this Mac also
 * get Quick Look. Text files are left to the source loader.
 */
export function useCompanionBinaryFile({ artifact, previewBaseRoot, sourceView, canReadLocally, nativeShell, reloads }: {
  artifact: SessionArtifact;
  previewBaseRoot: string | null;
  sourceView: boolean;
  canReadLocally: boolean;
  nativeShell: boolean;
  reloads: number;
}) {
  const kind = companionViewerKind(artifact.path);
  const readsBinary = sourceView && (kind === 'image' || kind === 'pdf' || kind === 'file');
  const cloudSourceId = sourceView ? artifact.attachmentId?.trim() || null : null;
  const key = `${previewBaseRoot ?? ''}:${artifact.id}:${artifact.path}:${reloads}`;
  const [loaded, setLoaded] = useState<{ key: string; file: CompanionBinaryFile } | null>(null);

  useEffect(() => {
    if (!readsBinary || (!canReadLocally && !cloudSourceId)) return undefined;
    let cancelled = false;
    let objectUrl: string | null = null;
    const input = { isNativeShell: nativeShell, path: artifact.path, attachmentId: artifact.attachmentId, baseRoot: previewBaseRoot };
    const request = (async (): Promise<CompanionBinaryFile> => {
      if (kind === 'file') {
        // Quick Look draws from a file on this Mac; a cloud-only copy shows the type mark.
        return { ...EMPTY, thumbnail: cloudSourceId ? null : await loadArtifactQuickLookThumbnail(input) };
      }
      if (cloudSourceId) {
        const blob = await downloadCloudCopy(cloudSourceId);
        objectUrl = URL.createObjectURL(blob);
        const file = { src: objectUrl, sizeBytes: blob.size };
        return kind === 'pdf' ? { ...EMPTY, pdf: file } : { ...EMPTY, image: file };
      }
      if (kind === 'pdf') {
        const { blob, sizeBytes } = await loadArtifactPdf(input);
        objectUrl = URL.createObjectURL(blob);
        return { ...EMPTY, pdf: { src: objectUrl, sizeBytes } };
      }
      return { ...EMPTY, image: await loadArtifactImage(input) };
    })();
    request
      .then((file) => { if (!cancelled) setLoaded({ key, file }); })
      .catch(() => { if (!cancelled) setLoaded({ key, file: EMPTY }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.attachmentId, artifact.path, canReadLocally, cloudSourceId, key, kind, nativeShell, previewBaseRoot, readsBinary]);

  const quickLook = nativeShell && canReadLocally && !cloudSourceId && kind !== 'code' && kind !== 'table'
    ? () => { void quickLookArtifact({ path: artifact.path, baseRoot: previewBaseRoot }).catch(() => undefined); }
    : undefined;

  return {
    readsBinary,
    file: loaded?.key === key ? loaded.file : null,
    waiting: readsBinary && (canReadLocally || Boolean(cloudSourceId)) && loaded?.key !== key,
    quickLook,
  };
}
