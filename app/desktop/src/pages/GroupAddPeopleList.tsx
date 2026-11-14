import { useMemo } from 'react';
import { Check, LoaderCircle, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ChatCreatePersonOption } from '@/features/chat/chatCreateFlows';
import { formatPresenceLine } from '@/kordi-app/contactPresenceLine';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import { normalizedSearch } from './groupManagementMembers';
import { addPeopleButtonLabel, type GroupGroundingPeople } from './groupGroundingPeople';
import { contactStableId, hasDuplicateName, visibleIdentityLabel } from './groupManagementIdentity';

function SectionHeading({ children }: { children: string }) {
  return <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold text-[color:var(--utility-muted-text)]">{children}</div>;
}

/** Add people › People: search, then Contacts (added right away) and From Grounding (invited). */
export function GroupAddPeopleList({
  searchId,
  query,
  onQueryChange,
  addOptions,
  filteredAddOptions,
  selectedContactIds,
  selectedAddContactIds,
  onToggleContact,
  duplicateNames,
  grounding,
  disabled,
  pendingAction,
  onSubmit,
}: {
  searchId: string;
  query: string;
  onQueryChange: (query: string) => void;
  addOptions: ChatCreatePersonOption[];
  filteredAddOptions: ChatCreatePersonOption[];
  selectedContactIds: string[];
  selectedAddContactIds: string[];
  onToggleContact: (contactId: string) => void;
  duplicateNames: Map<string, number>;
  grounding: GroupGroundingPeople;
  /** True when the viewer cannot add people to this group. */
  disabled: boolean;
  pendingAction: string | null;
  onSubmit: () => void;
}) {
  const filteredGrounding = useMemo(() => {
    const needle = normalizedSearch(query);
    if (!needle) return grounding.people;
    return grounding.people.filter((person) => [person.name, person.handle, person.source]
      .some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [grounding.people, query]);
  const total = selectedAddContactIds.length + grounding.selected.length;
  return (
    <>
      <label htmlFor={searchId} className="sr-only">Search people to add</label>
      <div className="app-group-management-search relative my-2">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--utility-muted-text)]" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search people"
          className="app-input-shell h-9 w-full rounded-[11px] py-2 pl-8 pr-3 text-[12px] outline-none"
        />
      </div>

      <SectionHeading>Contacts</SectionHeading>
      <div className="space-y-0.5" aria-label="Contacts available to add">
        {filteredAddOptions.length > 0 ? filteredAddOptions.map((option) => {
          const selected = selectedContactIds.includes(option.id);
          const rawIdentityLabel = contactStableId(option.contact);
          const identityLabel = visibleIdentityLabel(rawIdentityLabel);
          const detail = visibleIdentityLabel(option.detail ?? '');
          const showIdentityLabel = hasDuplicateName(option.label, duplicateNames)
            && identityLabel
            && identityLabel !== option.label;
          // As in Contacts rows, a known presence line takes the handle's place.
          const presenceLine = formatPresenceLine(option.contact.presenceStatus, option.contact.presenceLastSeenAt);
          const secondaryText = showIdentityLabel ? identityLabel : presenceLine ?? detail;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || Boolean(pendingAction)}
              aria-pressed={selected}
              onClick={() => onToggleContact(option.id)}
              className={cn('app-group-management-contact-row flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[11px] transition', selected && 'app-group-management-contact-row-selected')}
            >
              <IdentityAvatar
                kind="human"
                seed={option.avatarSeed ?? rawIdentityLabel}
                name={option.label}
                imageUrl={option.profileImageUrl}
                className="h-7 w-7 border border-white/10"
                presenceStatus={option.contact.presenceStatus}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{option.label}</span>
                {secondaryText ? (
                  <span className={cn('block truncate text-[9.5px]', !showIdentityLabel && presenceLine === 'online' ? 'app-contacts-presence-online' : 'text-[color:var(--utility-muted-text)]')}>
                    {secondaryText}
                  </span>
                ) : null}
              </span>
              <span className={cn('app-group-management-contact-check grid h-5 w-5 place-items-center rounded-full border', selected && 'app-group-management-contact-check-selected')}>
                {selected ? <Check className="h-3 w-3" /> : null}
              </span>
            </button>
          );
        }) : addOptions.length > 0 ? (
          <div className="app-group-management-empty rounded-[11px] px-2.5 py-3 text-center text-[11px]">
            No contacts match “{query.trim()}”.
          </div>
        ) : (
          <div className="app-group-management-empty rounded-[11px] px-2.5 py-3 text-center text-[11px]">
            No existing contacts are available to add.
          </div>
        )}
      </div>

      {filteredGrounding.length > 0 ? (
        <>
          <SectionHeading>From Grounding</SectionHeading>
          <div className="space-y-0.5" aria-label="People from Grounding">
            {filteredGrounding.map((person) => {
              const selected = grounding.selected.includes(person.accountId);
              return (
                <button
                  key={person.accountId}
                  type="button"
                  disabled={disabled || person.invited || Boolean(pendingAction)}
                  aria-pressed={person.invited ? undefined : selected}
                  onClick={() => grounding.toggle(person.accountId)}
                  className={cn('app-group-management-contact-row flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[11px] transition', selected && 'app-group-management-contact-row-selected')}
                >
                  <IdentityAvatar kind="human" seed={person.accountId} name={person.name} imageUrl={person.avatarUrl} className="h-7 w-7 border border-white/10" />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate font-medium', person.invited && 'text-[color:var(--utility-muted-text)]')}>{person.name}</span>
                    <span className="block truncate text-[9.5px] text-[color:var(--utility-muted-text)]">{person.source ?? 'Match'}</span>
                  </span>
                  {person.invited ? (
                    <span className="shrink-0 text-[10px] text-[color:var(--utility-muted-text)]">Invited</span>
                  ) : (
                    <span className={cn('app-group-management-contact-check grid h-5 w-5 place-items-center rounded-full border', selected && 'app-group-management-contact-check-selected')}>
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <Button
        type="button"
        className="mt-2 h-9 w-full rounded-[11px] text-[11px]"
        disabled={disabled || total === 0 || Boolean(pendingAction)}
        onClick={onSubmit}
      >
        {pendingAction === 'add-members' ? (
          <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> {selectedAddContactIds.length ? 'Adding…' : 'Inviting…'}</>
        ) : addPeopleButtonLabel(selectedAddContactIds.length, grounding.selected.length)}
      </Button>
    </>
  );
}
