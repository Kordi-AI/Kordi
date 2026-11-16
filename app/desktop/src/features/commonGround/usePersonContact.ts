import { useState } from 'react';

import type { CgHost } from './host';
import { contactActionFor } from './relationship';
import type { CgState, CommonGroundStore } from './store';
import type { CgPerson } from './types';

/**
 * A person's contact action (Add, Requested, Accept or Message) from the newest relationship the
 * store knows, and the calls behind it. `openChat` opens the direct chat once the server agrees,
 * with `draft` in the composer when given.
 */
export function usePersonContact(person: CgPerson, state: CgState, store: CommonGroundStore, host: CgHost) {
  const [busy, setBusy] = useState(false);
  // `state` keeps this in step with the store; the lookup reads the newest relationship.
  const relationship = state.relationships[person.accountId] ?? store.relationshipFor(person.accountId) ?? person.relationship;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };
  const openChat = (draft?: string) => void act(async () => { if (await store.chat(person.accountId)) host.openChat(person, draft); });
  const accept = () => void act(async () => {
    const requestId = relationship?.requestId;
    if (!requestId || !relationship) return;
    await host.acceptRequest(requestId);
    store.setRelationship(person.accountId, { ...relationship, contact: true, request: null, requestId: null });
    host.contactsChanged();
  });
  const add = () => void act(async () => { await store.addContact(person.accountId); host.contactsChanged(); });
  return { relationship, action: contactActionFor(relationship, state.support.contact), busy, act, openChat, accept, add };
}
