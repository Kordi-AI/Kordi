import { useCallback, useEffect, useState } from 'react';
import { groupJoinRequestRequest, type GroupJoinRequestCard } from '@/features/cloud/groupJoinRequest';
import { cachedSessionSnapshot, CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { IdentityAvatar } from './IdentityAvatar';

function firstName(name: string | null) {
  return name?.trim().split(/\s+/)[0] ?? '';
}

/** A room member's request to join this group. Owners and admins approve or decline it here. */
export function GroupJoinRequestCardContent({ snapshot }: { snapshot: GroupJoinRequestCard }) {
  const [local, setLocal] = useState<GroupJoinRequestCard | null>(null);
  const [account, setAccount] = useState(() => cachedSessionSnapshot()?.accountId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fresh = local && local.requestId === snapshot.requestId && local.revision >= snapshot.revision ? local : null;
  const card = fresh ?? snapshot;

  const accept = useCallback((next: GroupJoinRequestCard) => {
    setLocal((previous) => (previous && previous.requestId === next.requestId && previous.revision > next.revision ? previous : next));
  }, []);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      setAccount(cachedSessionSnapshot()?.accountId ?? null);
      // Only an open request can change; a decided one is final.
      if (snapshot.status !== 'pending') return;
      void loadSession().then(async (session) => {
        if (!current || !session) return;
        setAccount(session.accountId);
        const latest = await groupJoinRequestRequest(session.token, snapshot.requestId);
        if (current) accept(latest);
      }).catch(() => { /* The synced snapshot is usable until another refresh. */ });
    };
    refresh();
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, refresh);
    return () => {
      current = false;
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, refresh);
    };
  }, [accept, snapshot.requestId, snapshot.revision, snapshot.status]);

  async function act(action: 'approve' | 'decline') {
    setBusy(true);
    setError(null);
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to answer the request.');
      try {
        accept(await groupJoinRequestRequest(session.token, card.requestId, action));
      } catch (failure) {
        void groupJoinRequestRequest(session.token, card.requestId).then(accept).catch(() => {});
        throw failure;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not answer the request.');
    } finally {
      setBusy(false);
    }
  }

  const canDecide = card.status === 'pending' && Boolean(account && card.approverIds.includes(account));
  const decidedBy = firstName(card.decidedByName);
  const state = card.status === 'approved' ? (decidedBy ? `Approved by ${decidedBy}` : 'Approved')
    : card.status === 'declined' ? 'Declined'
      : card.status === 'cancelled' ? 'Withdrawn'
        : canDecide ? null : 'Waiting for approval';
  const { requester } = card;

  return (
    <section className="app-plan-card app-join-request-card" aria-label={`${requester.name} asked to join`} aria-busy={busy}>
      <div className="app-plan-card-head">
        {/* The shared avatar resolves kordi-avatar:// markers and remote pictures, and falls back to the generated avatar. */}
        <span className="app-join-request-avatar" aria-hidden="true">
          <IdentityAvatar kind="human" seed={requester.accountId} name={requester.name} imageUrl={requester.avatarUrl} cornerRadius="50%" className="h-full w-full" />
        </span>
        <div className="app-plan-card-heading">
          <div className="app-plan-card-title">{requester.name} asked to join</div>
          {card.roomName ? <div className="app-plan-card-meta">From {card.roomName}</div> : null}
        </div>
      </div>
      {canDecide ? (
        <div className="app-plan-card-actions">
          <button className="app-plan-card-button" type="button" disabled={busy} onClick={() => void act('decline')}>Decline</button>
          <button className="app-plan-card-button app-plan-card-button-primary" type="button" disabled={busy} onClick={() => void act('approve')}>Approve</button>
        </div>
      ) : null}
      {state ? (
        <div className={`app-plan-card-state app-join-request-state${card.status === 'approved' ? ' app-plan-card-state-confirmed' : ''}`} role="status">{state}</div>
      ) : null}
      {error ? <div className="app-plan-card-meta" role="alert">{error}</div> : null}
    </section>
  );
}
