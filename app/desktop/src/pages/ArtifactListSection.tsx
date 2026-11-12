import type { ConversationParticipant, SessionArtifact } from '@/kordi-app/types';

import { fileNameFromPath } from './artifactPreviewFormat';
import { ArtifactListRow } from './ArtifactListRow';
import { compactArtifactLocation } from './artifactRowModel';

type ArtifactListSectionProps = {
  title: string;
  section: 'generated' | 'related' | 'memory';
  description?: string;
  artifacts: SessionArtifact[];
  activeArtifact: SessionArtifact | null;
  onSelect: (artifactId: string) => void;
  onOpenExternal?: (artifact: SessionArtifact) => void;
  participants?: ConversationParticipant[];
};

export function ArtifactListSection({ title, section, description, artifacts, activeArtifact, onSelect, onOpenExternal, participants }: ArtifactListSectionProps) {
  if (artifacts.length === 0) return null;

  // Rows fill the column, so a filled row lines up with the toolbar edges above the list.
  return (
    <section className="app-artifact-list-section" data-artifact-section={section}>
      {title ? <h3 className="app-artifact-list-section-title">{title}</h3> : null}
      {description ? <div className="mb-2 text-[11px] leading-5 text-[color:var(--utility-muted-text)]">{description}</div> : null}
      <div className="flex flex-col gap-px">
        {artifacts.map((artifact) => (
          <ArtifactListRow
            key={artifact.id}
            artifact={{ ...artifact, name: artifact.name || fileNameFromPath(artifact.path) }}
            location={compactArtifactLocation(artifact.path, artifact.name || fileNameFromPath(artifact.path))}
            isActive={activeArtifact?.id === artifact.id}
            participants={participants ?? []}
            onSelect={() => onSelect(artifact.id)}
            onOpenExternal={onOpenExternal ? () => onOpenExternal(artifact) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
