import { useState } from 'react';

import type { FactoryLibraryFilter, FactoryLibrarySection } from './model';
import { useCommunitySkillCatalog } from './useCommunitySkillCatalog';

/**
 * The Library search filter: my library (by kind) or a community catalog.
 * The catalog list loads once the Library section opens so the filter menu can show it.
 */
export function useFactoryLibraryFilter(
  libraryOpen: boolean,
  librarySection: FactoryLibrarySection,
  setLibrarySection: (section: FactoryLibrarySection) => void,
) {
  const [libraryScope, setLibraryScope] = useState<FactoryLibraryFilter['scope']>('mine');
  const communityCatalog = useCommunitySkillCatalog(libraryOpen && libraryScope === 'community', libraryOpen);
  const { provider, setProvider } = communityCatalog;
  const libraryFilter: FactoryLibraryFilter = libraryScope === 'community'
    ? { scope: 'community', provider }
    : { scope: 'mine', kind: librarySection };
  const changeLibraryFilter = (filter: FactoryLibraryFilter) => {
    setLibraryScope(filter.scope);
    if (filter.scope === 'mine') setLibrarySection(filter.kind);
    else setProvider(filter.provider);
  };
  return { libraryScope, setLibraryScope, communityCatalog, libraryFilter, changeLibraryFilter };
}
