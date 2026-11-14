// Join requests for groups started from a room: a room member asks to join, cancels, and the
// group's owner or admins approve or decline. Each action refreshes the room's results, so every
// row shows the server's state.

import { commonGroundErrorMessage, type CommonGroundClient } from './client';
import type { CgScreen, CgState } from './store';

/** The parts of the store these operations use. */
export type CgJoinRequestHost = {
  readonly client: CommonGroundClient;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
  loadScreen: (screen?: CgScreen) => Promise<void>;
};

async function act(host: CgJoinRequestHost, code: string, key: string, work: () => Promise<unknown>): Promise<boolean> {
  host.set({ busy: key, notice: null });
  try {
    await work();
    return true;
  } catch (error) {
    host.set({ notice: commonGroundErrorMessage(error) });
    return false;
  } finally {
    if (host.getSnapshot().busy === key) host.set({ busy: null });
    // A refused request is often stale state (already a member, room closed), so refresh either way.
    await host.loadScreen({ name: 'results', code });
  }
}

export const askToJoin = (host: CgJoinRequestHost, code: string, groupSpaceId: string) =>
  act(host, code, `join-request:${groupSpaceId}`, () => host.client.askToJoin(code, groupSpaceId));

export const cancelJoinRequest = (host: CgJoinRequestHost, code: string, requestId: string) =>
  act(host, code, `join-request:${requestId}`, () => host.client.cancelJoinRequest(code, requestId));

export const decideJoinRequest = (host: CgJoinRequestHost, code: string, requestId: string, action: 'approve' | 'decline') =>
  act(host, code, `join-request:${requestId}`, () => host.client.decideJoinRequest(requestId, action));
