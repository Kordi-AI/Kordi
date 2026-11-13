import { useCallback, useState } from 'react';

import type { DocumentShareApi } from '@/features/documents/documentShareApi';
import { documentFormatForPath } from '@/features/documents/documentReaderModel';
import type { SessionArtifact } from '@/kordi-app/types';
import { openDesktopChatArtifact, openDesktopChatArtifactCopy } from '@/lib/desktopArtifactOpen';

import { fileNameFromPath } from './artifactPreviewFormat';
import { artifactDocumentApi } from './artifactDocumentApi';

export type OpenArtifactExternallyDeps = {
  api?: Pick<DocumentShareApi, 'getDocument' | 'getDocumentRaw'> | null;
  /** Opens a fresh copy of a cloud document's text under its file name. */
  openCopy?: (name: string, contents: string) => Promise<unknown>;
  open?: (path: string, baseRoot: string | null) => Promise<unknown>;
};

export const OPEN_ARTIFACT_FAILED = 'Could not open the file.';

async function cloudDocumentSource(api: NonNullable<OpenArtifactExternallyDeps['api']>, attachmentId: string, path: string) {
  if (documentFormatForPath(path) === 'html') return api.getDocumentRaw(attachmentId);
  const document = await api.getDocument(attachmentId);
  return document.blocks.map((block) => block.source).join('\n\n');
}

/**
 * Opens an artifact in its default app on this Mac. A shared document opens a fresh copy of its
 * cloud version, which carries everyone's edits; any other file opens where it is in the project.
 */
export async function openArtifactExternally(
  artifact: SessionArtifact,
  baseRoot: string | null | undefined,
  { api = artifactDocumentApi(), openCopy = openDesktopChatArtifactCopy, open = openDesktopChatArtifact }: OpenArtifactExternallyDeps = {},
) {
  const root = artifact.pinned ? null : baseRoot ?? null;
  const attachmentId = artifact.attachmentId?.trim();
  if (attachmentId && api && documentFormatForPath(artifact.path)) {
    try {
      const source = await cloudDocumentSource(api, attachmentId, artifact.path);
      await openCopy(fileNameFromPath(artifact.path), source);
      return;
    } catch {
      // Fall back to the file in the project, if there is one.
    }
  }
  await open(artifact.path, root);
}

/**
 * The open-in-default-app action for the Artifacts list and cards, and the error it last reported.
 * Absent outside the desktop app, which is the only place that can reach the files.
 */
export function useOpenArtifactExternally(isNativeShell: boolean, baseRoot: string | null | undefined) {
  const [error, setError] = useState<string | null>(null);
  const openFile = useCallback((artifact: SessionArtifact) => {
    setError(null);
    openArtifactExternally(artifact, baseRoot).catch(() => setError(OPEN_ARTIFACT_FAILED));
  }, [baseRoot]);
  return { open: isNativeShell ? openFile : undefined, error };
}
