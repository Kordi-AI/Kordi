import { useCallback, useEffect, useState } from 'react';
import { facilitatorCardRequest, type FacilitatorAction, type FacilitatorCard } from '@/features/cloud/facilitatorCard';
import { cachedSessionSnapshot, CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';

const labels = { decision: 'Decision poll', memory: 'Shared Memory draft', task: 'Proposed assignment' };
const taskStatus: Record<string, string> = {
  pending: 'Awaiting approval', approved: 'Approved', running: 'In progress',
  done: 'Completed', failed: 'Run failed', declined: 'Declined', expired: 'Approval expired',
};

export function FacilitatorCardContent({ snapshot }: { snapshot: FacilitatorCard }) {
  const [local, setLocal] = useState<{ card: FacilitatorCard; accountId: string } | null>(null);
  const [account, setAccount] = useState(() => cachedSessionSnapshot()?.accountId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const personal = local?.accountId === account && local.card.cardId === snapshot.cardId ? local.card : null;
  const card = personal && personal.revision >= snapshot.revision ? personal : snapshot;

  const accept = useCallback((card: FacilitatorCard, accountId: string) => {
    if (cachedSessionSnapshot()?.accountId !== accountId) return;
    setLocal(previous => {
      if (previous?.accountId === accountId && previous.card.cardId === card.cardId && previous.card.revision > card.revision) {
        return previous;
      }
      return { card, accountId };
    });
  }, []);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      setAccount(cachedSessionSnapshot()?.accountId ?? null);
      void loadSession().then(async session => {
        if (!current || (session?.accountId ?? null) !== (cachedSessionSnapshot()?.accountId ?? null)) return;
        setAccount(session?.accountId ?? null);
        if (!session) return;
        const latest = await facilitatorCardRequest(session.token, snapshot.cardId);
        if (current) accept(latest, session.accountId);
      }).catch(() => { /* The synced snapshot is usable until another refresh. */ });
    };
    refresh();
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, refresh);
    return () => {
      current = false;
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, refresh);
    };
  }, [accept, snapshot.cardId, snapshot.revision]);

  async function act(action: FacilitatorAction) {
    setBusy(true);
    setError(null);
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to update the card.');
      try {
        accept(await facilitatorCardRequest(session.token, card.cardId, action), session.accountId);
      } catch (failure) {
        void facilitatorCardRequest(session.token, card.cardId).then(latest => accept(latest, session.accountId)).catch(() => {});
        throw failure;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update the card.');
    } finally {
      setBusy(false);
    }
  }

  const topCount = Math.max(0, ...card.counts);
  const winner = topCount > 0 && card.counts.filter(count => count === topCount).length === 1 ? card.counts.indexOf(topCount) : -1;
  const status = card.kind === 'task' ? taskStatus[card.result ?? 'pending'] : card.result === null ? null
    : card.kind === 'memory' ? 'Saved to Memory' : `Confirmed · ${card.options[Number(card.result)] ?? ''}`;
  const canApprove = Boolean(account && account === card.assigneeId && card.result === 'pending');

  return (
    <section className="app-plan-card app-facilitator-card" aria-label={labels[card.kind]} aria-busy={busy}>
      <div className="app-plan-card-heading">
        <div className="app-plan-card-meta">{labels[card.kind]}</div>
        <div className="app-plan-card-title">{card.title}</div>
      </div>
      {card.detail ? <p className="app-facilitator-card-detail">{card.detail}</p> : null}
      {card.kind === 'decision' ? (
        <div className="app-plan-card-options">
          {card.options.map((option, index) => (
            <button key={option} className="app-plan-card-button app-facilitator-option" type="button"
              aria-pressed={personal?.myVote === index}
              disabled={busy || !account || card.result !== null}
              onClick={() => void act({ action: 'vote', revision: card.revision, option: index })}>
              <span>{option}</span><span>{personal?.myVote === index ? 'Your vote · ' : ''}{card.counts[index] ?? 0} {card.counts[index] === 1 ? 'vote' : 'votes'}</span>
            </button>
          ))}
        </div>
      ) : null}
      {card.kind === 'task' && card.assigneeName ? <div className="app-plan-card-meta">Assigned to {card.assigneeName}</div> : null}
      {status ? <div className="app-plan-card-state" role="status">{status}</div> : null}
      <div className="app-plan-card-actions">
        {card.kind === 'decision' && card.result === null && account && card.managerIds.includes(account) && winner >= 0
          ? <button className="app-plan-card-button" type="button" disabled={busy} onClick={() => void act({ action: 'confirm', revision: card.revision, option: winner })}>Confirm decision</button> : null}
        {card.kind === 'memory' && card.result === null && account
          ? <button className="app-plan-card-button" type="button" disabled={busy} onClick={() => void act({ action: 'save_memory', revision: card.revision })}>Save to group Memory</button> : null}
        {canApprove ? <>
          <button className="app-plan-card-button" type="button" disabled={busy} onClick={() => void act({ action: 'decline' })}>Decline assignment</button>
          <button className="app-plan-card-button" type="button" disabled={busy} onClick={() => void act({ action: 'approve' })}>Approve and run my agent</button>
        </> : null}
      </div>
      {error ? <div className="app-plan-card-meta" role="alert">{error}</div> : null}
    </section>
  );
}
