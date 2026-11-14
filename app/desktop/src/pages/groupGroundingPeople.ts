// Group › Add people's "From Grounding" state and its button label, beside `GroupAddPeopleList`.

import { useRef, useState } from 'react';

import type { GroupGroundingPerson } from '@/features/commonGround/groupPeople';

const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

/** "Add 2 people", "Invite 1 person", or "Add 2, invite 1" for contacts and Grounding people together. */
export function addPeopleButtonLabel(contacts: number, grounding: number): string {
  if (contacts && grounding) return `Add ${contacts}, invite ${grounding}`;
  if (grounding) return `Invite ${people(grounding)}`;
  if (contacts) return `Add ${people(contacts)}`;
  return 'Select people to add';
}

/**
 * The "From Grounding" people for a group, loaded when Add people opens. Any failure (an older
 * server, Grounding unavailable, not an admin) lists nobody, which hides the section.
 */
export function useGroupGroundingPeople(list?: (groupSpaceId: string) => Promise<GroupGroundingPerson[]>) {
  const [rows, setRows] = useState<GroupGroundingPerson[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const ticket = useRef(0);
  const reset = () => {
    ticket.current += 1;
    setRows([]);
    setPicked([]);
  };
  const load = (groupSpaceId: string | null) => {
    reset();
    if (!list || !groupSpaceId) return;
    const current = ticket.current;
    void list(groupSpaceId)
      .then((next) => { if (current === ticket.current) setRows(next); })
      .catch(() => undefined);
  };
  const toggle = (accountId: string) => setPicked((ids) => (ids.includes(accountId) ? ids.filter((id) => id !== accountId) : [...ids, accountId]));
  const selected = rows.filter((row) => !row.invited && picked.includes(row.accountId)).map((row) => row.accountId);
  return { people: rows, selected, load, reset, toggle };
}

export type GroupGroundingPeople = ReturnType<typeof useGroupGroundingPeople>;
