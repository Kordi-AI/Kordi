import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { installDialogDom } from './helpers/dialogDom';
import { digestClient } from '../src/features/digest/client';
import { dateKey, newCalendarEvent } from '../src/features/digest/calendar';
import DigestPage from '../src/features/digest/DigestPage';
import { CompanionCalendar } from '../src/pages/chatsPage.companionOverview';
import type { CalendarEvent, DigestResponse } from '../src/features/digest/types';

const response: DigestResponse = { accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-07T00:00:00Z', partial: false, feedback: [], sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } };
const localInput = (date: Date) => `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

async function withPage(run: (page: {
  host: HTMLElement; window: JSDOM['window']; saved: CalendarEvent[];
  click: (button: Element | null | undefined, label: string) => Promise<void>;
  type: (input: HTMLInputElement, value: string) => Promise<void>;
}) => Promise<void>, initial: CalendarEvent[] = []) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  installDialogDom(dom.window);
  // react-dom loads before this DOM exists, so it falls back to the legacy input event polyfill.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const saved: CalendarEvent[] = [...initial];
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: structuredClone(saved) });
  digestClient.saveEvent = async (account, event) => {
    assert.equal(account, 'viewer');
    const stored = { ...event, revision: 1 };
    saved.push(stored);
    return stored;
  };
  const host = dom.window.document.getElementById('root')!, root = createRoot(host);
  const click = async (button: Element | null | undefined, label: string) => {
    assert.ok(button, label);
    await act(async () => (button as HTMLElement).click());
  };
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      input.focus();
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    const calendarTab = [...host.querySelectorAll('nav[aria-label="Digest views"] button')].find(button => button.textContent === 'Calendar');
    await click(calendarTab, 'Calendar view');
    await run({ host, window: dom.window, saved, click, type });
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

function editorInputs(host: HTMLElement) {
  const dialog = host.querySelector<HTMLDialogElement>('dialog.digest-sheet');
  assert.ok(dialog?.open, 'the event editor is open');
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>('label > input')];
  return { dialog, title: inputs[0], start: inputs[1], end: inputs[2] };
}

test('a new event starts at the next full hour and lasts one hour', () => {
  const now = new Date(2099, 2, 4, 10, 25);
  const today = newCalendarEvent(null, null, now);
  assert.match(today.id, /^manual-/);
  assert.equal(today.revision, 0);
  assert.equal(today.startAt, new Date(2099, 2, 4, 11, 0).toISOString());
  assert.equal(today.endAt, new Date(2099, 2, 4, 12, 0).toISOString());
  assert.equal(newCalendarEvent('2099-03-09', null, now).startAt, new Date(2099, 2, 9, 11, 0).toISOString(), 'another day keeps the next full hour');
  const slot = newCalendarEvent('2099-03-09', 14 * 60 + 30, now);
  assert.equal(slot.startAt, new Date(2099, 2, 9, 14, 30).toISOString(), 'a chosen time slot is used as is');
  assert.equal(slot.endAt, new Date(2099, 2, 9, 15, 30).toISOString());
  assert.notEqual(newCalendarEvent(null, null, now).id, today.id, 'each new event has its own identity');
});

test('+ opens the editor for a new event and saving adds it to the calendar', async () => {
  await withPage(async ({ host, saved, click, type }) => {
    await click(host.querySelector('.digest-month-controls button[aria-label="New event"]'), 'New event');
    const { dialog, title, start, end } = editorInputs(host);
    assert.equal(dialog.querySelector('h2')?.textContent, 'New event');
    const expected = new Date(); expected.setMinutes(0, 0, 0); expected.setHours(expected.getHours() + 1);
    assert.equal(start.value, localInput(expected), 'starts at the next full hour');
    assert.equal(end.value, localInput(new Date(expected.getTime() + 3_600_000)), 'lasts one hour');
    assert.equal(title.value, '');
    assert.ok(!title.readOnly && !start.readOnly, 'a new event is editable');

    await type(title, 'Dentist');
    const submit = [...dialog.querySelectorAll('footer button')].find(button => button.textContent === 'Add to calendar');
    await click(submit, 'Add to calendar');
    assert.equal(saved.length, 1, 'the event is saved on the server');
    assert.equal(saved[0].title, 'Dentist');
    assert.match(saved[0].id, /^manual-/);
    assert.equal(saved[0].startAt, expected.toISOString());
    assert.equal(host.querySelector('dialog.digest-sheet'), null, 'the editor closes after saving');
    const listed = [...host.querySelectorAll('.digest-calendar-event strong, .digest-agenda-event strong')].map(node => node.textContent);
    assert.ok(listed.includes('Dentist'), 'the new event shows in the calendar right away');
  });
});

test('clicking an empty day opens the new event editor on that date', async () => {
  await withPage(async ({ host, click }) => {
    const cells = [...host.querySelectorAll('.digest-month-days > div')];
    const target = cells.find(cell => !cell.classList.contains('outside') && !cell.classList.contains('selected'))!;
    const day = target.querySelector('.digest-day-number')!.getAttribute('aria-label')!;
    await click(target.querySelector('.digest-day-hitbox'), 'day cell');
    const { dialog, start } = editorInputs(host);
    assert.equal(dialog.querySelector('h2')?.textContent, 'New event');
    assert.equal(new Date(`${start.value}:00`).toLocaleDateString(undefined, { dateStyle: 'full' }), day, 'prefilled with the clicked date');
    assert.equal(start.value.slice(11), `${String((new Date().getHours() + 1) % 24).padStart(2, '0')}:00`);
  });
});

test('clicking an empty time slot in the week opens the editor at that time, and events still open', async () => {
  const nine = new Date(); nine.setHours(9, 0, 0, 0);
  const existing: CalendarEvent = { id: 'calendar-standup', title: 'Standup', startAt: nine.toISOString(), endAt: new Date(nine.getTime() + 1_800_000).toISOString(), allDay: false, sourceIds: [], description: '', revision: 1 };
  await withPage(async ({ host, window, saved, click }) => {
    await click(host.querySelector('.digest-day-number[aria-pressed="true"]'), 'open week');
    const columns = [...host.querySelectorAll<HTMLElement>('.digest-week-day')];
    assert.equal(columns.length, 7, 'the week view is open');
    const column = columns[3];
    await act(async () => { column.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientY: 64 * 14 + 40 })); });
    const { start, end } = editorInputs(host);
    assert.equal(start.value.slice(11), '14:30', 'snaps to the half hour that was clicked');
    assert.equal(end.value.slice(11), '15:30');
    assert.equal(new Date(`${start.value}:00`).toLocaleDateString(undefined, { dateStyle: 'full' }), column.getAttribute('aria-label'), 'on the clicked day');
    await click([...host.querySelectorAll('dialog footer button')].find(button => button.textContent === 'Cancel'), 'Cancel');
    assert.equal(host.querySelector('dialog.digest-sheet'), null);

    await click(host.querySelector('.digest-week-event'), 'existing event');
    const { dialog, title } = editorInputs(host);
    assert.equal(dialog.querySelector('h2')?.textContent, 'Edit event', 'an existing event opens itself, not a new one');
    assert.equal(title.value, 'Standup');
    assert.deepEqual(saved.map(event => event.id), ['calendar-standup']);
  }, [existing]);
});

test('the companion calendar + opens a new event on the selected day', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById('root')!, root = createRoot(host);
  const requested: string[] = [];
  try {
    await act(async () => root.render(createElement(CompanionCalendar, { events: [], loaded: true, error: null, onRetry: () => {}, onNewEvent: day => requested.push(day) })));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New event"]')!.click());
    assert.deepEqual(requested, [dateKey(new Date())]);
    const other = [...host.querySelectorAll<HTMLButtonElement>('.app-companion-date-grid button')].find(button => button.getAttribute('aria-pressed') === 'false')!;
    await act(async () => { other.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
    assert.equal(requested.length, 2, 'double-clicking a date starts an event on it');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
