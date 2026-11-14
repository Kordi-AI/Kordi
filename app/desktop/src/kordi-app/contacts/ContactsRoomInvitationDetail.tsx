import { Check, X } from 'lucide-react';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { RoomGroupInvitation, RoomInvitationsState, RoomInvitationsStore } from '@/features/commonGround/roomInvitations';
import { GroupAvatar } from '../components/GroupAvatar';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { DetailHeader, DetailTile, DetailTiles, InfoCard } from './ContactDetailParts';

/** A group invitation in the Contacts main pane: the group, who invited you and how, its members, and Join or Decline. */
export function ContactsRoomInvitationDetail({
  invitation,
  state,
  store,
}: {
  invitation: RoomGroupInvitation;
  state: Pick<RoomInvitationsState, 'busyRef' | 'error' | 'outcome'>;
  store: Pick<RoomInvitationsStore, 'join' | 'decline' | 'select'>;
}) {
  const busy = state.busyRef === invitation.invitationRef;
  const line = invitation.roomName ? `${invitation.from.name} · from ${invitation.roomName}` : invitation.from.name;
  return (
    <section aria-label={`Invitation to ${invitation.name}`} className="app-contacts-detail-pane relative min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="app-contacts-detail-content relative mx-auto w-full max-w-[420px] px-6 pb-10 pt-10">
        <button
          type="button"
          onClick={() => store.select(null)}
          aria-label="Close"
          title="Close"
          className="app-contacts-icon-button app-contacts-detail-close absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[8px]"
        >
          <X className="h-4 w-4" />
        </button>
        <DetailHeader
          avatar={(
            <span className="app-contacts-detail-avatar inline-flex h-24 w-24 shrink-0" aria-hidden="true">
              <GroupAvatar
                name={invitation.name}
                avatars={invitation.members.map((member) => ({ kind: 'human', seed: member.accountId, imageUrl: member.avatarUrl }))}
                className="h-full w-full"
              />
            </span>
          )}
          name={invitation.name}
          line={line}
        />
        {state.outcome ? (
          <div className="app-contacts-muted mt-6 text-center text-[13px]" role="status">
            {state.outcome === 'joined' ? `You joined ${invitation.name}.` : 'Declined'}
          </div>
        ) : (
          <DetailTiles>
            <DetailTile icon={<X className="h-[18px] w-[18px]" aria-hidden="true" />} label="Decline" disabled={busy} onClick={() => { void store.decline(invitation); }} />
            <DetailTile icon={<Check className="h-[18px] w-[18px]" aria-hidden="true" />} label="Join" tone="primary" disabled={busy} onClick={() => { void store.join(invitation); }} />
          </DetailTiles>
        )}
        {state.error && !state.outcome ? <ErrorLine className="mt-3 text-center">{state.error}</ErrorLine> : null}
        {invitation.members.length ? (
          <>
            <div className="app-contacts-muted mt-6 px-1 text-[12px] font-semibold">Members</div>
            <InfoCard
              rows={invitation.members.map((member) => ({
                key: member.accountId,
                lead: <IdentityAvatar kind="human" seed={member.accountId} name={member.name} imageUrl={member.avatarUrl} cornerRadius="50%" className="app-contacts-avatar h-7 w-7 shrink-0" />,
                value: member.name,
                caption: '',
              }))}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
