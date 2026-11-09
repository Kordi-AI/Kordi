import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import { planEventCardId, planEventClient } from '../src/features/digest/planEventCard';
import type { CalendarEvent, DigestResponse } from '../src/features/digest/types';
import type { MessagePlanCard, MessagePlanCardParticipant } from '../src/kordi-app/types/message';
import type { PlanCardActionRequest } from '../src/features/cloud/planCardClient';

const response: DigestResponse = { accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-07T00:00:00Z', partial: false, feedback: [], sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } };

function person(participantId: string, displayName: string, rsvp: MessagePlanCardParticipant['rsvp'], organizer = false): MessagePlanCardParticipant {
  return { participantId, displayName, rsvp, organizer, avatarUrl: null };
}
function card(participants: MessagePlanCardParticipant[]): MessagePlanCard {
  return { eventId: 'evt-1', revision: 3, state: 'confirmed', title: 'Friday dinner', unresolvedFields: [], participants, managerIds: [], options: [], view: 'event' };
}
const MIXED = card([person('viewer', 'Sam Lee', 'yes'), person('mira', 'Mira Chen', 'yes', true), person('theo', 'Theo Park', 'no'), person('jun', 'Jun Ito', 'pending')]);

type Setup = { eventId: string; load: () => Promise<MessagePlanCard> };

async function withDigest({ eventId, load }: Setup, run: (page: {
  host: HTMLElement;
  click: (label: string) => Promise<void>;
  buttons: (label: string) => HTMLButtonElement[];
  answers: PlanCardActionRequest[];
  removals: string[];
  loads: () => number;
  editor: () => HTMLDialogElement;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const originalPlan = { ...planEventClient };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const event: CalendarEvent = { id: eventId, title: 'Friday dinner', startAt: today.toISOString(), endAt: new Date(today.getTime() + 7_200_000).toISOString(), reminderAt: new Date(today.getTime() - 3_600_000).toISOString(), allDay: false, sourceIds: [], description: 'Planned with the System agent in Friday crew.', revision: 2 };
  const answers: PlanCardActionRequest[] = [];
  const removals: string[] = [];
  let loadCount = 0;
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: removals.length ? [] : [event] });
  digestClient.removeEvent = async (_account, target) => { removals.push(target.id); };
  planEventClient.session = async () => ({ token: 'token', accountId: 'viewer', expiresAt: '2099-01-01T00:00:00Z' });
  planEventClient.load = async (_token, id) => { loadCount++; assert.equal(id, 'evt-1'); return load(); };
  planEventClient.answer = async (_token, request) => {
    answers.push(request);
    const base = await load();
    return request.action === 'rsvp'
      ? { ...base, participants: base.participants.map(p => p.participantId === request.participantId ? { ...p, rsvp: request.rsvp } : p) }
      : base;
  };
  const host = dom.window.document.getElementById('root')!, root = createRoot(host);
  const buttons = (label: string) => [...host.querySelectorAll('button')].filter(button => button.textContent === label);
  async function click(label: string) { const [button] = buttons(label); assert.ok(button, label); await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    const open = host.querySelector<HTMLButtonElement>('.digest-agenda-event');
    assert.ok(open, 'today\'s event is listed');
    await act(async () => { open.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    await run({ host, click, buttons, answers, removals, loads: () => loadCount, editor: () => host.querySelector<HTMLDialogElement>('dialog.digest-sheet')! });
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(planEventClient, originalPlan);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('only events written from a plan card name their card', () => {
  assert.equal(planEventCardId({ id: 'plan:evt-1' }), 'evt-1');
  assert.equal(planEventCardId({ id: 'plan:' }), null);
  assert.equal(planEventCardId({ id: 'calendar-zoom' }), null);
});

test('an ordinary event shows no people and keeps every field editable', async () => {
  await withDigest({ eventId: 'calendar-dentist', load: async () => MIXED }, async ({ editor, loads }) => {
    assert.equal(editor().querySelector('.digest-plan-people'), null);
    assert.equal(loads(), 0, 'no plan is read for an ordinary event');
    for (const input of editor().querySelectorAll('input')) assert.equal(input.readOnly, false);
  });
});

test('a card event groups the plan\'s people with the card\'s counts and follows the card\'s time', async () => {
  await withDigest({ eventId: 'plan:evt-1', load: async () => MIXED }, async ({ editor, buttons }) => {
    const section = editor().querySelector('.digest-plan-people');
    assert.ok(section, 'the People section shows');
    assert.equal(section.querySelector('.digest-plan-head span')!.textContent, 'People');
    assert.equal(section.querySelector('.digest-plan-counts')!.textContent, "2 going · 1 can't · 1 no reply");
    const groups = [...section.querySelectorAll('.digest-plan-group')].map(group => [
      group.querySelector('.digest-plan-group-title')!.textContent,
      [...group.querySelectorAll('.digest-plan-person-name')].map(name => name.textContent),
    ]);
    assert.deepEqual(groups, [['Going', ['Sam Lee (you)', 'Mira Chen']], ["Can't make it", ['Theo Park']], ['No reply', ['Jun Ito']]]);
    assert.equal(section.querySelectorAll('.digest-plan-person-role').length, 1);
    assert.equal(buttons("I'm in")[0].getAttribute('aria-pressed'), 'true');
    assert.equal(buttons("Can't make it")[0].getAttribute('aria-pressed'), 'false');
    const [title, start, end] = [...editor().querySelectorAll('input')];
    assert.ok(title.readOnly && start.readOnly && end.readOnly, 'title and time follow the card');
    assert.equal(editor().querySelector('select')!.disabled, false, 'the reminder stays editable');
  });
});

test('the organizer sees the people without answer buttons', async () => {
  const organized = card([person('viewer', 'Sam Lee', 'yes', true), person('jun', 'Jun Ito', 'pending')]);
  await withDigest({ eventId: 'plan:evt-1', load: async () => organized }, async ({ editor, buttons }) => {
    assert.equal(editor().querySelector('.digest-plan-counts')!.textContent, '1 going · 1 no reply');
    assert.equal(buttons("I'm in").length, 0);
    assert.equal(buttons("Can't make it").length, 0);
  });
});

test('"I\'m in" sends the existing RSVP and shows the updated answer', async () => {
  const current = card([person('viewer', 'Sam Lee', 'no'), person('mira', 'Mira Chen', 'yes', true)]);
  await withDigest({ eventId: 'plan:evt-1', load: async () => current }, async ({ editor, click, answers, buttons }) => {
    await click("I'm in");
    assert.deepEqual(answers, [{ action: 'rsvp', eventId: 'evt-1', participantId: 'viewer', rsvp: 'yes' }]);
    assert.equal(editor().querySelector('.digest-plan-counts')!.textContent, '2 going');
    assert.equal(buttons("I'm in")[0].getAttribute('aria-pressed'), 'true');
  });
});

test('Remove event on a card event answers "Can\'t make it" after one confirmation', async () => {
  await withDigest({ eventId: 'plan:evt-1', load: async () => MIXED }, async ({ host, click, answers, removals }) => {
    await click('Remove event');
    const confirm = host.querySelector('dialog.digest-confirm');
    assert.ok(confirm);
    assert.equal(confirm.getAttribute('aria-label'), "Can't make it?");
    assert.equal(answers.length, 0, 'nothing is sent before confirming');
    const [confirmButton] = [...confirm.querySelectorAll('button')].filter(button => button.textContent === "Can't make it");
    await act(async () => { confirmButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(answers, [{ action: 'rsvp', eventId: 'evt-1', participantId: 'viewer', rsvp: 'no' }]);
    assert.deepEqual(removals, ['plan:evt-1'], 'the row leaves the calendar at once');
    assert.equal(host.querySelector('dialog'), null, 'the dialogs close');
  });
});

test('the People button "Can\'t make it" uses the same confirmation', async () => {
  await withDigest({ eventId: 'plan:evt-1', load: async () => MIXED }, async ({ host, click, answers }) => {
    await click("Can't make it");
    assert.equal(host.querySelector('dialog.digest-confirm')!.getAttribute('aria-label'), "Can't make it?");
    await click('Keep event');
    assert.equal(host.querySelector('dialog.digest-confirm'), null);
    assert.equal(answers.length, 0);
  });
});

test('a plan that cannot be read hides the section and Remove event deletes only the row', async () => {
  await withDigest({ eventId: 'plan:evt-1', load: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } }, async ({ host, editor, click, answers, removals }) => {
    assert.equal(editor().querySelector('.digest-plan-people'), null);
    await click('Remove event');
    assert.equal(host.querySelector('dialog.digest-confirm')!.getAttribute('aria-label'), 'Remove this event?');
    await click('Remove');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(answers.length, 0);
    assert.deepEqual(removals, ['plan:evt-1']);
  });
});
