import { useMemo, useState } from 'react';

import { ErrorLine } from '@/components/ui/ErrorLine';
import { openArtifactInSidePanel } from '@/features/documents/companionDocument';
import { useDocumentReaderHost } from '@/features/documents/documentReaderHost';
import type { ConversationParticipant, DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';

import { ArtifactCard } from './ArtifactCard';
import { ArtifactPreviewWindow } from './ArtifactInspector';
import { fileNameFromPath } from './artifactPreviewFormat';
import { loadArtifactPreview } from './artifactPreviewLoader';
import type { ArtifactThumbnailContext } from './artifactThumbnail';
import { useOpenArtifactExternally } from './openArtifactExternally';

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


/**
 * The card layout of a chat's Artifacts tab: one dense grid with a thumbnail of each artifact's
 * first lines, created files first and changed project files after them (their cards say how they
 * changed). Every artifact opens as a tab in the companion pane; the preview window is only the
 * fallback where there is no companion.
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
  const { open: openExternally, error: openError } = useOpenArtifactExternally(isNativeShell, previewBaseRoot);
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
    if (documentsInCompanion && openArtifactInSidePanel(artifact, baseRoot)) return;
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
      onOpenExternal={openExternally ? () => openExternally(artifact) : undefined}
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
          onClose={() => setPreviewing(null)}
        />
      ) : null}
    </div>
  );
}
