import { useEffect, useState } from 'react';
import { fetchPlanCard, planCardAction } from '@/features/cloud/planCardClient';
import { normalizePlanCardSnapshot } from '@/features/cloud/planCardSnapshot';
import { loadSession } from '@/features/cloud/session';
import type { MessagePlanCard, MessagePlanCardParticipant } from '@/kordi-app/types/message';
import type { CalendarEvent } from './types';

const PLAN_EVENT_PREFIX = 'plan:';

/** The plan card behind a calendar event the System agent wrote, or null for any other event. */
export function planEventCardId(event: Pick<CalendarEvent, 'id'>): string | null {
  return event.id.startsWith(PLAN_EVENT_PREFIX) && event.id.length > PLAN_EVENT_PREFIX.length
    ? event.id.slice(PLAN_EVENT_PREFIX.length) : null;
}

/** Network seams for the dialog; tests replace them like `digestClient`. */
export const planEventClient = {
  session: loadSession,
  load: fetchPlanCard,
  answer: planCardAction,
};

export type PlanEventCard = { card: MessagePlanCard; accountId: string };

/** Sends one RSVP as the signed-in member and returns the updated card. */
export async function answerPlanEvent(eventId: string, rsvp: 'yes' | 'no'): Promise<PlanEventCard> {
  const session = await planEventClient.session();
  if (!session?.token || !session.accountId) throw new Error('Sign in to respond.');
  const card = await planEventClient.answer(session.token, { action: 'rsvp', eventId, participantId: session.accountId, rsvp });
  // Read the reply like a card block, so built-in accounts never count as people.
  return { card: normalizePlanCardSnapshot(card) ?? card, accountId: session.accountId };
}

/** Reads the plan as the signed-in member; any failure reads as no plan. */
async function loadPlanEvent(eventId: string): Promise<PlanEventCard | null> {
  try {
    const session = await planEventClient.session();
    if (!session?.token || !session.accountId) return null;
    return { card: await planEventClient.load(session.token, eventId), accountId: session.accountId };
  } catch {
    return null;
  }
}

/**
 * The live plan for a card event, read when the dialog opens and again whenever the window
 * regains focus. Any failure (signed out, no longer in the chat, offline) leaves it null, so
 * the dialog shows no people rather than stale ones.
 */
export function usePlanEventCard(eventId: string | null) {
  const [plan, setPlan] = useState<PlanEventCard | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    void loadPlanEvent(eventId).then(next => { if (!cancelled) setPlan(next); });
    return () => { cancelled = true; };
  }, [eventId, reads]);
  useEffect(() => {
    if (!eventId) return;
    const onFocus = () => setReads(count => count + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [eventId]);
  return { plan, setPlan };
}

/** The signed-in member's own entry, when they are on the plan. */
export function planEventSelf(plan: PlanEventCard | null): MessagePlanCardParticipant | null {
  return plan?.card.participants.find(participant => participant.participantId === plan.accountId) ?? null;
}
