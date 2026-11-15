// Inviting a person from their Grounding page into one of the viewer's groups (owner or admin).
// Contacts are added right away; anyone else gets an invitation to accept. The picker's groups
// load each time it opens, so a group's Member or Invited state is the server's.

import { CommonGroundError, commonGroundErrorMessage, isRouteMissing, type CommonGroundClient } from './client';
import type { CgState } from './store';
import type { CgGroupInviteResult, CgInviteGroup, CgPerson } from './types';

/** The parts of the store these operations use. */
export type CgGroupInviteHost = {
  readonly client: CommonGroundClient;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
};

export const inviteGroupsKey = (accountId: string) => `invite-groups:${accountId}`;
export const groupInviteKey = (accountId: string) => `group-invite:${accountId}`;

/** "Chen" from "Chen Wei", for the picker title and the confirmation. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Loads the groups a person can be invited to. A person who cannot be invited lists none
 * (null); an older server without the route turns Invite off.
 */
export async function loadInviteGroups(host: CgGroupInviteHost, accountId: string): Promise<void> {
  const key = inviteGroupsKey(accountId);
  const { [accountId]: _stale, ...rest } = host.getSnapshot().inviteGroups;
  host.set({ busy: key, notice: null, inviteGroups: rest });
  try {
    const groups = await host.client.personGroups(accountId);
    host.set({ inviteGroups: { ...host.getSnapshot().inviteGroups, [accountId]: groups } });
  } catch (error) {
    const state = host.getSnapshot();
    if (isRouteMissing(error)) {
      host.set({ support: { ...state.support, groupInvite: false } });
    } else {
      // Not invitable (404) is an empty picker; anything else also says why.
      const gone = error instanceof CommonGroundError && error.status === 404;
      host.set({ inviteGroups: { ...state.inviteGroups, [accountId]: null }, ...(gone ? {} : { notice: commonGroundErrorMessage(error) }) });
    }
  } finally {
    if (host.getSnapshot().busy === key) host.set({ busy: null });
  }
}

/** The confirmation for a sent invitation, or null when the server skipped the person. */
export function groupInviteConfirmation(result: CgGroupInviteResult, person: CgPerson, group: CgInviteGroup): string | null {
  const name = firstName(person.name);
  if (result.added.some((entry) => entry.accountId === person.accountId)) return `Added ${name} to ${group.name}`;
  if (result.invited.some((entry) => entry.accountId === person.accountId)) return `Invited ${name} to ${group.name}`;
  return null;
}

const SKIPPED: Record<string, (name: string, group: string) => string> = {
  member: (name, group) => `${name} is already in ${group}.`,
  invited: (name, group) => `${name} is already invited to ${group}.`,
  limit: () => 'You have too many pending invitations. Try again later.',
};

/** Sends the pick; returns the confirmation line on success, or null with the reason as the notice. */
export async function inviteToGroup(host: CgGroupInviteHost, person: CgPerson, group: CgInviteGroup): Promise<string | null> {
  const key = groupInviteKey(person.accountId);
  host.set({ busy: key, notice: null });
  try {
    const result = await host.client.inviteToGroup(group.groupSpaceId, [person.accountId]);
    const confirmation = groupInviteConfirmation(result, person, group);
    const state = host.getSnapshot();
    const picker = state.inviteGroups[person.accountId];
    if (confirmation && picker) {
      const joined = result.added.some((entry) => entry.accountId === person.accountId);
      const groups = picker.groups.map((entry) => (entry.groupSpaceId === group.groupSpaceId ? { ...entry, state: joined ? 'member' as const : 'invited' as const } : entry));
      host.set({ inviteGroups: { ...state.inviteGroups, [person.accountId]: { ...picker, groups } } });
    }
    if (!confirmation) {
      const reason = result.skipped.find((entry) => entry.accountId === person.accountId)?.reason ?? 'unavailable';
      const line = SKIPPED[reason]?.(firstName(person.name), group.name) ?? `${firstName(person.name)} can't be invited to ${group.name}.`;
      host.set({ notice: line });
    }
    return confirmation;
  } catch (error) {
    host.set({ notice: commonGroundErrorMessage(error) });
    return null;
  } finally {
    if (host.getSnapshot().busy === key) host.set({ busy: null });
  }
}
