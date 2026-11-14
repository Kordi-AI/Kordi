import { Check, LoaderCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoomGroupInvitation } from '@/features/commonGround/roomInvitations';
import { IdentityAvatar } from '../components/IdentityAvatar';

/** A group invitation in Contacts › Requests: inviter over "Invited you to <group>", with small Decline and Join buttons. */
export function ContactsRoomInvitationRow({
  invitation,
  active,
  busy,
  onOpen,
  onJoin,
  onDecline,
}: {
  invitation: RoomGroupInvitation;
  active: boolean;
  busy: boolean;
  /** Opens the invitation in the Contacts detail pane. */
  onOpen: () => void;
  onJoin: () => void;
  onDecline: () => void;
}) {
  return (
    <div
      className={cn(
        'app-contact-row app-contact-request-row app-contact-room-invitation-row relative flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1 transition-none',
        active && 'app-contact-row-selected',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
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
          <span className="block truncate text-[12px] font-semibold leading-4">{invitation.from.name}</span>
          <span className="app-contact-row-meta mt-0.5 block truncate text-[10.5px] leading-4">Invited you to {invitation.name}</span>
        </span>
      </button>
      <button
        type="button"
        className="app-contacts-invite-icon relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50"
        onClick={onDecline}
        disabled={busy}
        aria-label="Decline"
        title="Decline"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="app-contacts-invite-icon is-join relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50"
        onClick={onJoin}
        disabled={busy}
        aria-label="Join"
        title="Join"
      >
        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}
