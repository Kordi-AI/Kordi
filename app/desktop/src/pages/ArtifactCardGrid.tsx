import { useMemo, useState } from 'react';

import { ErrorLine } from '@/components/ui/ErrorLine';
import { openArtifactInCompanion } from '@/features/documents/companionDocument';
import { useDocumentReaderHost } from '@/features/documents/documentReaderHost';
import type { ConversationParticipant, DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';

import { ArtifactCard } from './ArtifactCard';
import { ArtifactPreviewWindow } from './ArtifactInspector';
import { artifactPreviewKind, fileNameFromPath } from './artifactPreviewFormat';
import { loadArtifactPreview } from './artifactPreviewLoader';
import type { ArtifactThumbnailContext } from './artifactThumbnail';
import { OPEN_ARTIFACT_FAILED, openArtifactExternally } from './openArtifactExternally';

type ArtifactCardGridProps = {
  isNativeShell: boolean;
  artifacts: SessionArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  previewBaseRoot?: string | null;
  participants?: ConversationParticipant[];
  /** Reads cloud documents for thumbnails; tests and the visual page pass an in-memory version. */
  thumbnailApi?: ArtifactThumbnailContext['api'];
};

const KIND_LABEL: Record<string, string> = { html: 'Preview', svg: 'Preview', markdown: 'Markdown', mermaid: 'Mermaid', table: 'Table', json: 'JSON' };

/**
 * The card layout of a chat's Artifacts tab: one dense grid with a thumbnail of each artifact's
 * first lines, created files first and changed project files after them (their cards say how they
 * changed). Markdown and HTML open in the companion pane; other files open in the preview window.
 */
export function ArtifactCardGrid({
  isNativeShell,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  previewBaseRoot,
  participants = [],
  thumbnailApi,
}: ArtifactCardGridProps) {
  const documentsInCompanion = Boolean(useDocumentReaderHost().opensDocumentsInCompanion);
  const [picked, setPicked] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{ artifact: SessionArtifact; preview: DesktopArtifactPreview } | null>(null);
  const ordered = useMemo(() => [
    ...artifacts.filter((artifact) => (artifact.category ?? 'artifact') === 'artifact'),
    ...artifacts.filter((artifact) => artifact.category === 'related'),
  ], [artifacts]);
  const thumbnailContext = useMemo<ArtifactThumbnailContext>(() => (
    thumbnailApi === undefined ? { isNativeShell, baseRoot: previewBaseRoot } : { isNativeShell, baseRoot: previewBaseRoot, api: thumbnailApi }
  ), [isNativeShell, previewBaseRoot, thumbnailApi]);

  const open = (artifact: SessionArtifact) => {
    setPicked(artifact.id);
    onSelectArtifact(artifact.id);
    const baseRoot = artifact.pinned ? null : previewBaseRoot;
    if (documentsInCompanion && openArtifactInCompanion(artifact, baseRoot)) return;
    loadArtifactPreview({ isNativeShell, path: artifact.path, attachmentId: artifact.attachmentId, baseRoot })
      .then((preview) => setPreviewing({ artifact, preview }))
      .catch(() => undefined);
  };

  // Only a card the person opened here is marked, so nothing looks selected on arrival.
  const card = (artifact: SessionArtifact) => (
    <ArtifactCard
      key={artifact.id}
      artifact={{ ...artifact, name: artifact.name || fileNameFromPath(artifact.path) }}
      isActive={picked === artifact.id && activeArtifactId === artifact.id}
      participants={participants}
      thumbnailContext={thumbnailContext}
      onOpen={() => open(artifact)}
      onOpenExternal={isNativeShell ? () => {
        setOpenError(null);
        openArtifactExternally(artifact, previewBaseRoot).catch(() => setOpenError(OPEN_ARTIFACT_FAILED));
      } : undefined}
    />
  );

  return (
    <div data-artifact-card-layout="true" className="app-artifact-card-layout">
      {openError ? <ErrorLine className="mb-2">{openError}</ErrorLine> : null}
      <div className="app-artifact-card-grid">{ordered.map(card)}</div>
      {previewing ? (
        <ArtifactPreviewWindow
          preview={previewing.preview}
          title={fileNameFromPath(previewing.artifact.path)}
          kindLabel={KIND_LABEL[artifactPreviewKind(previewing.artifact.path)] ?? 'Source'}
          onClose={() => setPreviewing(null)}
        />
      ) : null}
    </div>
  );
}
