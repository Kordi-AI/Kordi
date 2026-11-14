import { CapabilityLibraryView } from './CapabilityLibraryView';
import { CommunitySkillDetail } from './CommunitySkillDetail';
import type { FactoryLibraryArtifact, FactoryLibraryFilter, FactoryLibrarySection } from './model';
import type { CommunitySkillCatalog } from './useCommunitySkillCatalog';
import type { useSkillLibrary } from './useSkillLibrary';

type FactoryLibraryDetailProps = {
  scope: FactoryLibraryFilter['scope'];
  kind: FactoryLibrarySection;
  selectedId: string | null;
  artifact: FactoryLibraryArtifact | null;
  skill: ReturnType<typeof useSkillLibrary>['skills'][number] | null;
  skillLibrary: ReturnType<typeof useSkillLibrary>;
  community: CommunitySkillCatalog;
  onEditInBuild: (artifact: FactoryLibraryArtifact) => void;
};

/** The Library detail pane: a community catalog skill, or an item from my library. */
export function FactoryLibraryDetail({ scope, kind, selectedId, artifact, skill, skillLibrary, community, onEditInBuild }: FactoryLibraryDetailProps) {
  if (scope === 'community') {
    return (
      <CommunitySkillDetail
        key={community.selected?.id ?? 'none'}
        summary={community.selected}
        loadingList={community.loading}
        installedSkills={skillLibrary.skills}
        mutatingSkillId={skillLibrary.mutatingSkillId}
        onInstalled={async (summaryId) => {
          community.markInstalled(summaryId);
          await skillLibrary.refresh();
        }}
        onSetEnabled={skillLibrary.setEnabled}
      />
    );
  }
  return (
    <CapabilityLibraryView
      key={`${kind}:${selectedId ?? 'none'}`}
      kind={kind}
      artifact={artifact}
      skill={skill}
      mutating={Boolean(skill && skillLibrary.mutatingSkillId === skill.id)}
      onSetEnabled={skillLibrary.setEnabled}
      onRemove={skillLibrary.remove}
      onEditInBuild={onEditInBuild}
    />
  );
}
