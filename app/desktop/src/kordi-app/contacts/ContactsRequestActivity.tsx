import { ErrorLine } from '@/components/ui/ErrorLine';
import { useRoomInvitations } from '@/features/commonGround/roomInvitations';
import { ContactRequestRow } from '../components';
import type { ContactRequest } from '../types';
import { ContactsListSection } from './ContactsListSection';
import { ContactsRoomInvitationRow } from './ContactsRoomInvitationRow';
import type { ContactRequestActions } from './useContactsPageState';

/** Incoming requests, room group invitations and outgoing requests as one "Requests" section of compact rows. */
export function ContactsRequestActivity({
  incomingContactRequests,
  outgoingContactRequests,
  activeContactRequestId,
  isContactRequestsOpen,
  onToggleRequests,
  onSelectRequest,
  onCloseOverlay,
  requestActions,
}: {
  incomingContactRequests: ContactRequest[];
  outgoingContactRequests: ContactRequest[];
  activeContactRequestId: string;
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  onSelectRequest?: (request: ContactRequest) => void;
  /** Closes an open contact or request, so an invitation can take the detail pane. */
  onCloseOverlay?: () => void;
  requestActions: ContactRequestActions;
}) {
  const rooms = useRoomInvitations();
  const requestCount = incomingContactRequests.length + rooms.invitations.length + outgoingContactRequests.length;
  if (requestCount === 0) return null;

  return (
    <ContactsListSection
      label="Requests"
      count={requestCount}
      expanded={isContactRequestsOpen}
      onToggle={onToggleRequests}
      className="app-contacts-request-activity"
    >
      {incomingContactRequests.map((request) => (
        <ContactRequestRow
          key={request.id}
          request={request}
          active={activeContactRequestId === request.id}
          onSelect={onSelectRequest ? () => onSelectRequest(request) : undefined}
          onAccept={requestActions.canAccept ? () => { void requestActions.submit(request, 'accept'); } : undefined}
          actionState={requestActions.stateFor(request)}
        />
      ))}
      {rooms.invitations.map((invitation) => (
        <ContactsRoomInvitationRow
          key={invitation.invitationRef}
          invitation={invitation}
          active={rooms.selected?.invitationRef === invitation.invitationRef}
          busy={rooms.busyRef === invitation.invitationRef}
          onOpen={() => {
            // The invitation takes the detail pane from any open contact or request.
            onCloseOverlay?.();
            rooms.store.select(invitation);
          }}
          onJoin={() => { void rooms.store.join(invitation); }}
          onDecline={() => { void rooms.store.decline(invitation); }}
        />
      ))}
      {outgoingContactRequests.map((request) => (
        <ContactRequestRow
          key={request.id}
          request={request}
          active={activeContactRequestId === request.id}
          onSelect={onSelectRequest ? () => onSelectRequest(request) : undefined}
          onAccept={requestActions.canAccept ? () => { void requestActions.submit(request, 'accept'); } : undefined}
          actionState={requestActions.stateFor(request)}
        />
      ))}
      {requestActions.error || rooms.error ? (
        <ErrorLine className="mx-2 mt-0 py-1">{requestActions.error ?? rooms.error}</ErrorLine>
      ) : null}
    </ContactsListSection>
  );
}
