'use strict';
// Sample data only. Names, the chat, the place and the time are illustrative.
const DEFAULTS = { device: 'mac', theme: 'light', variant: 'both', rsvp: 'mixed', role: 'member', load: 'ready' };
const CHOICES = {
  device: ['mac', 'ios'], theme: ['light', 'dark'], variant: ['both', 'a', 'b'],
  rsvp: ['mixed', 'all-going', 'no-replies', 'not-from-card'], role: ['member', 'organizer'], load: ['ready', 'loading'],
};
const NAMES = { you: 'You', mira: 'Mira Chen', theo: 'Theo Park', jun: 'Jun Ito', priya: 'Priya Rao' };
const HUES = { you: 250, mira: 20, theo: 160, jun: 300, priya: 80 };
const ANSWERS = {
  mixed: { you: 'yes', mira: 'yes', theo: 'no', jun: 'pending' },
  'all-going': { you: 'yes', mira: 'yes', theo: 'yes', jun: 'yes', priya: 'yes' },
  'no-replies': { you: 'yes', mira: 'yes', theo: 'pending', jun: 'pending', priya: 'pending' },
};
const GROUPS = [['yes', 'Going'], ['no', "Can't make it"], ['pending', 'No reply']];
const CHAT = 'Friday crew';

const params = new URLSearchParams(location.search);
const state = Object.fromEntries(Object.keys(DEFAULTS).map(key => {
  const value = params.get(key);
  return [key, CHOICES[key].includes(value) ? value : DEFAULTS[key]];
}));
// Per-variant transient UI: the "Can't make it" confirmation and the removed event.
const ui = { a: { confirm: false, removed: false }, b: { confirm: false, removed: false } };

const icon = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  dots: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12" cy="8" r="1.1"/></svg>',
  updown: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>',
};

function fromCard() { return state.rsvp !== 'not-from-card'; }
function organizerId() { return state.role === 'organizer' ? 'you' : 'mira'; }
function people() {
  if (!fromCard()) return [];
  const answers = { ...ANSWERS[state.rsvp] };
  // The organizer starts at "yes"; when you organize, the others keep their sample answers.
  if (state.role === 'organizer' && state.rsvp === 'no-replies') { answers.mira = 'pending'; delete answers.priya; }
  // The event is on your calendar only while you are going.
  answers.you = 'yes';
  return Object.entries(answers).map(([id, rsvp]) => ({ id, name: NAMES[id], rsvp, organizer: id === organizerId() }));
}
function counts(list) {
  const n = rsvp => list.filter(person => person.rsvp === rsvp).length;
  return [`${n('yes')} going`, ...(n('no') ? [`${n('no')} can't`] : []), ...(n('pending') ? [`${n('pending')} no reply`] : [])].join(' · ');
}
function initials(name) { return name === 'You' ? 'Y' : name.split(' ').map(part => part[0]).join('').slice(0, 2); }
function statusLabel(rsvp) { return GROUPS.find(([key]) => key === rsvp)[1]; }

function avatar(person, badge = false) {
  const glyph = { yes: icon.check, no: icon.x, pending: icon.dots }[person.rsvp];
  return `<span class="avatar avatar-${person.rsvp}" style="--h:${HUES[person.id]}">${initials(person.name)}${badge ? `<i class="badge badge-${person.rsvp}">${glyph}</i>` : ''}</span>`;
}
function grouped(list) {
  return `<div class="rsvp-groups">${GROUPS.map(([rsvp, title]) => {
    const members = list.filter(person => person.rsvp === rsvp);
    if (!members.length) return '';
    return `<div class="rsvp-group"><div class="rsvp-sub">${title}</div><ul>${members.map(person => `<li class="person person-${person.rsvp}">${avatar(person)}<span class="person-name">${person.name}</span>${person.organizer ? '<span class="tag">Organizer</span>' : ''}</li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}
function faces(list) {
  const order = { yes: 0, pending: 1, no: 2 };
  const sorted = [...list].sort((a, b) => order[a.rsvp] - order[b.rsvp]);
  return `<ul class="faces">${sorted.map(person => `<li class="face face-${person.rsvp}" title="${person.name} · ${statusLabel(person.rsvp)}${person.organizer ? ' · Organizer' : ''}">${avatar(person, true)}<span class="face-name">${person.name.split(' ')[0]}</span><span class="sr-only">${statusLabel(person.rsvp)}${person.organizer ? ', organizer' : ''}</span></li>`).join('')}</ul>`;
}
function actions(variant) {
  if (state.role === 'organizer') return '';
  const busy = state.load === 'loading' ? ' disabled' : '';
  return `<div class="rsvp-actions" role="group" aria-label="Your answer"><button type="button" class="rsvp-button" data-act="no" data-variant="${variant}" aria-pressed="false"${busy}>${icon.x}Can't make it</button><button type="button" class="rsvp-button active" aria-pressed="true"${busy}>${icon.check}I'm in</button></div>`;
}
function rsvpSection(variant, ios) {
  if (!fromCard()) return '';
  const list = people();
  const loading = state.load === 'loading';
  const body = loading ? '<p class="meta">Loading…</p>' : variant === 'a' ? grouped(list) : faces(list);
  const head = `<div class="rsvp-head"><span class="rsvp-title">People</span><span class="rsvp-counts">${loading ? '' : counts(list)}</span>${ios ? '' : actions(variant)}</div>`;
  return `<section class="rsvp rsvp-${variant}" aria-label="People">${head}${body}${ios ? actions(variant) : ''}</section>`;
}
function event() {
  return fromCard()
    ? { title: 'Friday dinner', start: '2026-11-13T19:00', end: '2026-11-13T21:00', day: 'Nov 13, 2026', from: '7:00 PM', to: '9:00 PM', context: `Planned with the System agent in ${CHAT}.` }
    : { title: 'Dentist', start: '2026-11-13T09:30', end: '2026-11-13T10:30', day: 'Nov 13, 2026', from: '9:30 AM', to: '10:30 AM', context: '' };
}

// ---------- Mac ----------
const REMINDERS = ['No reminder', 'At start', '5 minutes before', '10 minutes before', '15 minutes before', '1 hour before'];
function macSheet(variant) {
  const e = event();
  return `<div class="mac-sheet" role="dialog" aria-label="Edit event">
    <header><h2>Edit event</h2><button type="button">Close</button></header>
    <label>Title<input value="${e.title}" maxlength="500"></label>
    <label>Start time<input type="datetime-local" value="${e.start}"></label>
    <label>End time (optional)<input type="datetime-local" value="${e.end}"></label>
    <label>Remind me<select>${REMINDERS.map(r => `<option${r === '1 hour before' ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
    <p class="meta">Shown in America/Los_Angeles · Personal calendar. No invitations are sent.</p>
    ${rsvpSection(variant, false)}
    ${e.context ? `<p class="meta context">${e.context}</p>` : ''}
    <footer><button type="button" class="remove">Remove event</button><button type="button">Cancel</button><button type="button">Save event</button></footer>
  </div>`;
}
function macConfirm(variant) {
  return `<div class="mac-confirm" role="alertdialog" aria-label="Can't make it?"><h2>Can't make it?</h2><p class="meta">${event().title} leaves your calendar.</p><footer><button type="button" data-keep="${variant}">Keep</button><button type="button" class="danger" data-decline="${variant}">Can't make it</button></footer></div>`;
}
function macStage(variant) {
  const s = ui[variant];
  const page = '<div class="mac-page" aria-hidden="true"><div class="mac-page-title">Digest</div><div class="mac-line w60"></div><div class="mac-line w80"></div><div class="mac-line w40"></div><div class="mac-line w70"></div></div>';
  const body = s.removed
    ? `<div class="toast" role="status">Removed from your calendar<button type="button" data-undo="${variant}">Undo</button></div>`
    : `<div class="mac-scrim"></div>${macSheet(variant)}${s.confirm ? `<div class="mac-scrim top"></div>${macConfirm(variant)}` : ''}`;
  return `<div class="mac-window">${page}${body}</div>`;
}

// ---------- iPhone ----------
function iosSheet(variant) {
  const e = event();
  return `<div class="ios-sheet" role="dialog" aria-label="Edit event">
    <div class="ios-nav"><button type="button" class="ios-link">Cancel</button><strong>Edit event</strong><span></span></div>
    <div class="ios-scroll">
      <div class="ios-rows">
        <div class="ios-row"><input class="ios-input" value="${e.title}" aria-label="Event title"></div>
        <div class="ios-row"><span>Starts</span><span class="ios-chips"><span class="chip">${e.day}</span><span class="chip">${e.from}</span></span></div>
        <div class="ios-row"><span>Set an end</span><span class="toggle on" aria-hidden="true"></span></div>
        <div class="ios-row"><span>Ends</span><span class="ios-chips"><span class="chip">${e.day}</span><span class="chip">${e.to}</span></span></div>
        <div class="ios-row"><span>Remind me</span><span class="ios-value">1 hour before ${icon.updown}</span></div>
      </div>
      <p class="ios-foot">Shown in America/Los_Angeles · Personal calendar. No invitations are sent.</p>
      ${rsvpSection(variant, true)}
      ${e.context ? `<p class="ios-context">${e.context}</p>` : ''}
      <div class="ios-rows ios-buttons"><button type="button" class="ios-row ios-link">Save event</button><button type="button" class="ios-row ios-danger">Remove event</button></div>
    </div>
  </div>`;
}
function iosConfirm(variant) {
  return `<div class="ios-dim"></div><div class="ios-action" role="alertdialog" aria-label="Can't make it?"><div class="ios-action-group"><p>Can't make it to ${event().title}?</p><button type="button" class="ios-danger" data-decline="${variant}">Can't make it</button></div><button type="button" class="ios-action-cancel" data-keep="${variant}">Keep</button></div>`;
}
function iosStage(variant) {
  const s = ui[variant];
  const body = s.removed
    ? `<div class="ios-under plain" aria-hidden="true"></div><div class="toast ios-toast" role="status">Removed from your calendar<button type="button" data-undo="${variant}">Undo</button></div>`
    : `<div class="ios-under" aria-hidden="true"></div>${iosSheet(variant)}${s.confirm ? iosConfirm(variant) : ''}`;
  return `<div class="phone"><div class="ios-status" aria-hidden="true"><span>9:41</span><span>●●●</span></div>${body}</div>`;
}

// ---------- Page ----------
function render() {
  document.documentElement.dataset.theme = state.theme;
  const variants = !fromCard() ? ['a'] : state.variant === 'both' ? ['a', 'b'] : [state.variant];
  const label = { a: 'A · Grouped list', b: 'B · Avatar row' };
  document.getElementById('stages').className = `stages ${state.device}`;
  document.getElementById('stages').innerHTML = variants.map(variant => `<figure class="stage"><figcaption>${fromCard() ? label[variant] : 'Not from a card'}</figcaption>${state.device === 'ios' ? iosStage(variant) : macStage(variant)}</figure>`).join('');
  for (const group of document.querySelectorAll('.segmented')) {
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === state[group.dataset.param]));
  }
  for (const select of document.querySelectorAll('select[data-param]')) select.value = state[select.dataset.param];
  document.querySelector('select[data-param=role]').disabled = !fromCard();
  const query = new URLSearchParams(Object.entries(state).filter(([key, value]) => value !== DEFAULTS[key]));
  history.replaceState(null, '', query.toString() ? `?${query}` : location.pathname);
}
function resetUI() { for (const s of Object.values(ui)) { s.confirm = false; s.removed = false; } }

document.querySelector('.review-controls').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'reset') { resetUI(); return render(); }
  const group = button.closest('.segmented');
  if (group) { state[group.dataset.param] = button.dataset.value; resetUI(); render(); }
});
document.querySelector('.review-controls').addEventListener('change', event => {
  const select = event.target.closest('select[data-param]');
  if (select) { state[select.dataset.param] = select.value; resetUI(); render(); }
});
document.getElementById('stages').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { act, variant, keep, decline, undo } = button.dataset;
  if (act === 'no') ui[variant].confirm = true;
  else if (keep) ui[keep].confirm = false;
  else if (decline) { ui[decline].confirm = false; ui[decline].removed = true; }
  else if (undo) ui[undo].removed = false;
  else return;
  render();
  document.querySelector(`[data-keep="${variant}"], [data-undo="${decline}"], [data-act="no"][data-variant="${keep ?? undo}"]`)?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = Object.entries(ui).find(([, s]) => s.confirm);
  if (open) { open[1].confirm = false; render(); }
});
render();
