import { useState } from 'react';
import { CalendarPlus, Check, Clock, MessageCircle, UserPlus, Users } from 'lucide-react';

import { DetailTile, DetailTiles } from '@/kordi-app/contacts/ContactDetailParts';
import type { CgHost } from './host';
import { InviteToGroupDialog } from './InviteToGroupDialog';
import { MeetDialog } from './MeetDialog';
import { canMeet, contactActionFor, CONTACT_ACTION_LABELS } from './relationship';
import type { CgState, CommonGroundStore } from './store';
import { groupInviteKey, inviteGroupsKey } from './storeGroupInvites';
import type { CgPerson } from './types';

const ICON = 'h-5 w-5';

/**
 * The tile row under a person's hero: Add (or Requested, Accept), Meet, Chat and Invite (to
 * one of your groups), driven by the relationship the server sent. Hidden only when the server
 * has no action routes.
 */
export function PersonActions({ person, state, store, host }: {
  person: CgPerson;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
}) {
  const [meeting, setMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  // `state` keeps this in step with the store; the lookup reads the newest relationship.
  const relationship = state.relationships[person.accountId] ?? store.relationshipFor(person.accountId) ?? person.relationship;
  const action = contactActionFor(relationship, state.support.contact);
  const contact = canMeet(relationship);
  const showMeet = state.support.meet && Boolean(relationship);
  const showChat = state.support.chat && Boolean(relationship);
  const showInvite = state.support.groupInvite && Boolean(relationship);
  const openInvite = () => {
    setConfirmation(null);
    setInviting(true);
    void store.loadInviteGroups(person.accountId);
  };
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };
  const openChat = () => void act(async () => { if (await store.chat(person.accountId)) host.openChat(person); });
  const accept = () => void act(async () => {
    const requestId = relationship?.requestId;
    if (!requestId || !relationship) return;
    await host.acceptRequest(requestId);
    store.setRelationship(person.accountId, { ...relationship, contact: true, request: null, requestId: null });
    host.contactsChanged();
  });
  const add = () => void act(async () => { await store.addContact(person.accountId); host.contactsChanged(); });

  // A contact's Message is the Chat tile, so the contact slot only shows before that.
  const contactTile = () => {
    if (action === 'hidden') return null;
    const label = CONTACT_ACTION_LABELS[action];
    if (action === 'message') return showChat ? null : <DetailTile key="contact" icon={<MessageCircle className={ICON} aria-hidden="true" />} label={label} tone="primary" disabled={busy} onClick={openChat} />;
    if (action === 'requested') return <DetailTile key="contact" icon={<Clock className={ICON} aria-hidden="true" />} label={label} disabled onClick={() => undefined} />;
    if (action === 'accept') return <DetailTile key="contact" icon={<Check className={ICON} aria-hidden="true" />} label={label} tone="primary" disabled={busy} onClick={accept} />;
    return <DetailTile key="contact" icon={<UserPlus className={ICON} aria-hidden="true" />} label={label} tone="primary" disabled={busy} onClick={add} />;
  };

  const tiles = [
    contactTile(),
    showMeet ? <DetailTile key="meet" icon={<CalendarPlus className={ICON} aria-hidden="true" />} label="Meet" disabled={!contact || busy} onClick={() => setMeeting(true)} /> : null,
    showChat ? <DetailTile key="chat" icon={<MessageCircle className={ICON} aria-hidden="true" />} label="Chat" disabled={!contact || busy} onClick={openChat} /> : null,
    showInvite ? <DetailTile key="invite" icon={<Users className={ICON} aria-hidden="true" />} label="Invite" ariaHasPopup="dialog" disabled={busy} onClick={openInvite} /> : null,
  ].filter(Boolean);
  if (!tiles.length) return null;

  return (
    <>
      <DetailTiles>{tiles}</DetailTiles>
      {(showMeet || showChat) && !contact ? <div className="cg-hint">Add each other to meet or chat</div> : null}
      {confirmation ? <div className="cg-hint" role="status">{confirmation}</div> : null}
      {inviting && showInvite ? (
        <InviteToGroupDialog
          person={person}
          picker={state.inviteGroups[person.accountId]}
          loading={state.busy === inviteGroupsKey(person.accountId)}
          busy={state.busy === groupInviteKey(person.accountId)}
          notice={state.notice}
          onCancel={() => setInviting(false)}
          onInvite={(group) => void store.inviteToGroup(person, group).then((line) => {
            if (!line) return;
            setInviting(false);
            setConfirmation(line);
          })}
        />
      ) : null}
      {meeting ? (
        <MeetDialog
          self={host.self}
          person={person}
          busy={busy}
          onCancel={() => setMeeting(false)}
          onSubmit={(input) => void act(async () => {
            if (await store.meet(person.accountId, input)) {
              setMeeting(false);
              host.openChat(person);
            }
          })}
        />
      ) : null}
    </>
  );
}
