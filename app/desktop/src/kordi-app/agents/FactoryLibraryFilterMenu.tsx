import { Blocks, Check, ChevronDown, Globe2, Puzzle, Wrench } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  communityProviderLabel,
  type FactoryCommunityProvider,
  type FactoryLibraryFilter,
  type FactoryLibrarySection,
} from './model';
import { libraryKindLabel } from './factoryLibraryUtils';
import { useDismissibleDetails } from './useDismissibleDetails';

const KIND_ICONS = { skill: Puzzle, tool: Wrench, plugin: Blocks } satisfies Record<FactoryLibrarySection, typeof Puzzle>;

/** The menu at the right edge of the Library search field: scope and type in one place. */
export function FactoryLibraryFilterMenu({
  filter,
  counts,
  providers,
  onChange,
}: {
  filter: FactoryLibraryFilter;
  counts: Record<FactoryLibrarySection, number>;
  providers: FactoryCommunityProvider[];
  onChange: (filter: FactoryLibraryFilter) => void;
}) {
  const { open: menuOpen, close: closeMenu, detailsRef: menuDetailsRef, summaryRef: menuSummaryRef, onToggle: onMenuToggle } = useDismissibleDetails();
  const label = filter.scope === 'mine' ? libraryKindLabel(filter.kind) : communityProviderLabel(filter.provider);
  const choose = (next: FactoryLibraryFilter) => {
    closeMenu(true);
    onChange(next);
  };

  return (
    <details ref={menuDetailsRef} className="app-factory-filter-menu" onToggle={onMenuToggle}>
      <summary
        ref={menuSummaryRef}
        className="app-factory-filter-trigger"
        aria-label={`Show: ${label}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {label}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </summary>
      <div className="app-factory-menu-panel app-factory-filter-panel" role="menu" aria-label="Show in Library">
        <div className="app-factory-menu-label" role="presentation">My library</div>
        {(['skill', 'tool', 'plugin'] as const).map((kind) => {
          const Icon = KIND_ICONS[kind];
          const checked = filter.scope === 'mine' && filter.kind === kind;
          return (
            <button key={kind} type="button" role="menuitemradio" aria-checked={checked} onClick={() => choose({ scope: 'mine', kind })}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{libraryKindLabel(kind)}</span>
              <small>{counts[kind]}</small>
              <Check className={cn('h-3 w-3', !checked && 'invisible')} aria-hidden="true" />
            </button>
          );
        })}
        <hr />
        <div className="app-factory-menu-label" role="presentation">Community</div>
        {providers.map((provider) => {
          const checked = filter.scope === 'community' && filter.provider === provider;
          return (
            <button key={provider} type="button" role="menuitemradio" aria-checked={checked} onClick={() => choose({ scope: 'community', provider })}>
              <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{communityProviderLabel(provider)}</span>
              <small />
              <Check className={cn('h-3 w-3', !checked && 'invisible')} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </details>
  );
}
