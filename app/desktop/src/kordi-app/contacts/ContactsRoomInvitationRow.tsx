import { LoaderCircle } from 'lucide-react';
import type { RoomGroupInvitation } from '@/features/commonGround/roomInvitations';
import { IdentityAvatar } from '../components/IdentityAvatar';

/** A Grounding room group invitation in Contacts › Requests, shaped like a contact request row. */
export function ContactsRoomInvitationRow({
  invitation,
  busy,
  onOpen,
  onJoin,
  onDecline,
}: {
  invitation: RoomGroupInvitation;
  busy: boolean;
  /** Opens the room with this group in view. */
  onOpen?: () => void;
  onJoin: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="app-contact-row app-contact-request-row app-contact-room-invitation-row relative flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1 transition-none">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        aria-label={`Open ${invitation.name}`}
        className="app-contact-request-select flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <IdentityAvatar
          kind="human"
          seed={invitation.from.accountId}
          name={invitation.from.name}
          imageUrl={invitation.from.avatarUrl}
          cornerRadius="50%"
          className="app-contacts-avatar h-9 w-9"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold leading-4">{invitation.from.name} invited you</span>
          <span className="app-contact-row-meta mt-0.5 block truncate text-[10.5px] leading-4">{invitation.name}</span>
        </span>
      </button>
      <button
        type="button"
        className="app-contact-row-meta relative inline-flex h-6 shrink-0 items-center self-start rounded-full px-2 text-[11.5px] font-medium disabled:pointer-events-none disabled:opacity-50"
        onClick={onDecline}
        disabled={busy}
      >
        Decline
      </button>
      <button
        type="button"
        className="app-contacts-accept-pill relative inline-flex h-6 shrink-0 items-center gap-1 self-start rounded-full px-2.5 text-[11.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
        onClick={onJoin}
        disabled={busy}
      >
        {busy ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
        Join
      </button>
    </div>
  );
}
