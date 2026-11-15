import { useId, useState } from 'react';
import { Check } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CgAvatarGrid, CgButton, CgNotice, CgProgress } from './parts';
import { firstName } from './storeGroupInvites';
import type { CgInviteGroup, CgPerson, CgPersonGroups } from './types';

const STATE_LABELS = { member: 'Member', invited: 'Invited' } as const;

/**
 * "Invite Chen to a group": the groups the viewer runs, one pick, then Invite (or Add for a
 * contact). Groups the person is in or already invited to are shown but cannot be picked.
 * `picker` is undefined while the groups load and null when the person cannot be invited.
 */
export function InviteToGroupDialog({ person, picker, loading, busy, notice, onCancel, onInvite }: {
  person: CgPerson;
  picker: CgPersonGroups | null | undefined;
  loading: boolean;
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onInvite: (group: CgInviteGroup) => void;
}) {
  const titleId = useId();
  const [groupSpaceId, setGroupSpaceId] = useState<string | null>(null);
  const groups = picker?.groups ?? [];
  const chosen = groups.find((group) => group.groupSpaceId === groupSpaceId && !group.state) ?? null;
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>{`Invite ${firstName(person.name)} to a group`}</AppDialogTitle>
      <form className="cg-form" onSubmit={(event) => { event.preventDefault(); if (chosen) onInvite(chosen); }}>
        {loading && picker === undefined ? <CgProgress line="Loading groups" inline /> : groups.length ? (
          <div className="cg-pick-list" role="radiogroup" aria-label="Groups">
            {groups.map((group) => {
              const on = group.groupSpaceId === chosen?.groupSpaceId;
              return (
                <button
                  key={group.groupSpaceId}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={Boolean(group.state) || busy}
                  className={cn('cg-pick', on && 'is-on')}
                  onClick={() => setGroupSpaceId(group.groupSpaceId)}
                >
                  <CgAvatarGrid people={group.members} size={30} />
                  <span className="cg-row-text">
                    <span className="cg-row-title">{group.name}</span>
                    <span className="cg-row-sub">{`${group.memberCount} ${group.memberCount === 1 ? 'member' : 'members'}`}</span>
                  </span>
                  {group.state
                    ? <span className="cg-pick-state">{STATE_LABELS[group.state]}</span>
                    : <span className="cg-check" aria-hidden="true">{on ? <Check className="h-3.5 w-3.5" /> : null}</span>}
                </button>
              );
            })}
          </div>
        ) : <div className="cg-pick-empty cg-muted">No groups you can invite to</div>}
        <CgNotice text={notice} />
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !chosen}>{picker?.contact ? 'Add' : 'Invite'}</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
