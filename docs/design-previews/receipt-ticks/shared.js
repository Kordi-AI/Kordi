'use strict';
// Sample data only: synthetic people, a synthetic group and synthetic times. Nothing here
// is real data, and the preview makes no network requests.
const RT = {};

RT.STATES = [
  ['group-sent', 'Group · sent'],
  ['group-read', 'Group · read'],
  ['dm-sent', 'Direct · sent'],
  ['dm-read', 'Direct · read'],
  ['before-after', 'Now and proposed'],
  ['seen-loading', 'Seen by · loading'],
  ['seen-none', 'Seen by · nobody yet'],
  ['seen-one', 'Seen by · one reader'],
  ['seen-several', 'Seen by · several'],
  ['seen-list', 'Seen by · full list'],
  ['large-group', 'Group over 100'],
  ['incoming', 'Someone else’s message'],
];
RT.STATE_IDS = RT.STATES.map(([id]) => id);
RT.label = (id) => (RT.STATES.find(([key]) => key === id) || [id, id])[1];

RT.PEOPLE = {
  you: { name: 'You', seed: 'preview-self-you' },
  alex: { name: 'Alex Chen', seed: 'preview-alex-chen' },
  maya: { name: 'Maya Patel', seed: 'preview-maya-patel' },
  hana: { name: 'Hana Kim', seed: 'preview-hana-kim' },
  priya: { name: 'Priya Nair', seed: 'preview-priya-nair' },
  omar: { name: 'Omar Haddad', seed: 'preview-omar-haddad' },
  lena: { name: 'Lena Fischer', seed: 'preview-lena-fischer' },
  diego: { name: 'Diego Alvarez', seed: 'preview-diego-alvarez' },
  sofia: { name: 'Sofia Rossi', seed: 'preview-sofia-rossi' },
};

// The own message was sent at 10:40 AM; readers in the order they read it.
RT.READERS = [
  ['maya', '10:41 AM'], ['omar', '10:41 AM'], ['hana', '10:43 AM'], ['alex', '10:44 AM'],
  ['priya', '10:46 AM'], ['lena', '10:52 AM'], ['diego', '11:05 AM'], ['sofia', '11:20 AM'],
];

RT.OWN_GROUP_TEXT = 'I moved the demo to Thursday at 3 so design can join.';
const GROUP_MESSAGES = [
  { from: 'alex', text: 'Is the demo still on Wednesday?' },
  { from: 'maya', text: 'Slides are in the shared folder. The timeline is on page 4.' },
  { from: 'omar', text: 'Thanks, reading now.' },
  { from: 'you', text: RT.OWN_GROUP_TEXT },
];
// An own message with `ticks` keeps that state; the latest own message follows the state.
RT.CONVERSATIONS = {
  group: { title: 'Launch prep', macMeta: '9 members', iosMeta: '9 participants', messages: GROUP_MESSAGES },
  large: { title: 'Launch prep', macMeta: '140 members', iosMeta: '140 participants', messages: GROUP_MESSAGES },
  incoming: {
    title: 'Launch prep', macMeta: '9 members', iosMeta: '9 participants',
    messages: [
      { from: 'alex', text: 'Is the demo still on Wednesday?' },
      { from: 'omar', text: 'Thanks, reading now.' },
      { from: 'you', text: RT.OWN_GROUP_TEXT },
      { from: 'maya', text: 'Works for me. I’ll book the room.' },
    ],
  },
  dm: {
    title: 'Hana Kim', macMeta: '', iosMeta: 'online', dm: true,
    messages: [
      { from: 'you', text: 'Notes from today are in the doc.', ticks: 'read' },
      { from: 'hana', text: 'Are we still on for the review tomorrow?' },
      { from: 'you', text: 'Yes, 10:30. I’ll bring the draft.' },
    ],
  },
};

// What each state shows: which conversation, the own message's ticks, and the open surface.
RT.scene = function scene(state) {
  const seen = { 'seen-loading': 'loading', 'seen-none': 'none', 'seen-one': 'one', 'seen-several': 'several', 'seen-list': 'list' }[state] || null;
  const conv = state.startsWith('dm-') ? 'dm' : state === 'large-group' ? 'large' : state === 'incoming' ? 'incoming' : 'group';
  const ticks = ['group-sent', 'dm-sent', 'seen-none'].includes(state) ? 'sent' : 'read';
  const menu = seen || state === 'large-group' ? 'own' : state === 'incoming' ? 'peer' : null;
  return { conv: RT.CONVERSATIONS[conv], ticks, menu, seen };
};

RT.esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Avatars ----------
// Boring Avatars "Marble", ported from bridges/cloud-server/src/avatars/boring_marble.rs
// (MIT, boringdesigners/boring-avatars) so people look like the app's generated avatars.
const MARBLE = ['#DCE4E8', '#526779', '#9CB7B3', '#C9B8A8', '#79879C'];
let marbleId = 0;
function marbleHash(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
function marbleUnit(number, range, digit) {
  const value = number % range;
  return Math.floor(number / 10 ** digit) % 10 % 2 === 0 ? -value : value;
}
function marbleSvg(seed) {
  const hash = marbleHash(seed);
  const color = (i) => MARBLE[(hash + i) % MARBLE.length];
  const scale = (1.2 + (hash * 3 % 4) / 10).toFixed(1);
  const transform = (i) => {
    const n = hash * (i + 1);
    return `translate(${marbleUnit(n, 8, 1)} ${marbleUnit(n, 8, 2)}) rotate(${marbleUnit(n, 360, 1)} 40 40) scale(${scale})`;
  };
  const id = `marble-blur-${marbleId += 1}`;
  return `<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><rect width="80" height="80" fill="${color(0)}"/>`
    + `<path filter="url(#${id})" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="${color(1)}" transform="${transform(1)}"/>`
    + `<path filter="url(#${id})" style="mix-blend-mode:overlay" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="${color(2)}" transform="${transform(2)}"/>`
    + `<defs><filter id="${id}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="b"/><feBlend in="SourceGraphic" in2="b" result="s"/><feGaussianBlur stdDeviation="7"/></filter></defs></svg>`;
}
// Rounded square with a 17% corner, as IdentityAvatar (Mac) and IdentityAvatar (iPhone) draw it.
RT.avatar = function avatar(key, size, extraClass = '') {
  const person = RT.PEOPLE[key];
  return `<span class="avatar ${extraClass}" style="width:${size}px;height:${size}px" role="img" aria-label="${RT.esc(person.name)}">${marbleSvg(person.seed)}</span>`;
};

// ---------- Icons ----------
// Mac: lucide paths as the app imports them (24 grid, stroke 2).
const LUCIDE = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCheck: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  textQuote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  messages: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
};
RT.lucide = (name, cls = '') => `<svg class="lucide ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${LUCIDE[name]}</svg>`;

// iPhone: SF Symbol stand-ins drawn on the same 24 grid with a lighter stroke.
const SF = {
  chevronLeft: '<path d="M15 4.5 7.5 12l7.5 7.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  ellipsis: '<circle cx="5.5" cy="12" r="1.6" class="fill"/><circle cx="12" cy="12" r="1.6" class="fill"/><circle cx="18.5" cy="12" r="1.6" class="fill"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  textQuote: '<path d="M10 6h11M10 12h11M3 18h18"/><path d="M3.5 6.5h3v3h-3zM5 9.5c0 1.6-.6 2.4-1.8 2.9"/>',
  bubbles: '<path d="M15.5 9.5a5.5 4.6 0 1 0-9.2 3.4L5.5 16l3.4-1.6a6.4 6.4 0 0 0 1.1.1 5.5 4.6 0 0 0 5.5-5Z"/><path d="M17.6 9.2a5 4.3 0 0 1 1.6 7.4l.8 2.9-3.1-1.4a6 6 0 0 1-4.6-.9"/>',
  docOnDoc: '<rect x="8.5" y="8" width="11" height="13" rx="2"/><path d="M15.5 5.5V5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h.5"/>',
  share: '<path d="M12 15V3.5M8 7l4-4 4 4"/><path d="M8.5 10H6.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/>',
  pencil: '<path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4Z"/><path d="m14.5 6.5 3 3"/>',
  arrowshape: '<path d="M13 5.5 20 12l-7 6.5V15c-5 0-8 1.6-10 5 .6-6 3.6-9.5 10-10Z"/>',
  pin: '<path d="M9 3.5h6l-1 6 3.5 3.5v1.5h-11V13L10 9.5Z"/><path d="M12 14.5V21"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.7 2.7L16.2 9"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2"/><path d="M6 6.5 7 20h10l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5c4-2.4 7 2.4 13 0v9c-6 2.4-9-2.4-13 0"/>',
  waveform: '<path d="M6 10v4M10 7v10M14 9v6M18 11v2"/>',
};
RT.sf = (name, cls = '') => `<svg class="sf ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SF[name]}</svg>`;

// iPhone delivery glyph: SF "checkmark" at caption2 semibold; read draws two, 4pt apart.
RT.iosTicks = function iosTicks(ticks) {
  const mark = (dx) => `<path d="M${2.6 + dx} 7.4 L${5.6 + dx} 10.4 L${11.4 + dx} 3.6"/>`;
  const paths = ticks === 'read' ? mark(-2) + mark(2) : mark(0);
  return `<svg class="i-tick-glyph" viewBox="-1 0 16 14" aria-hidden="true" focusable="false">${paths}</svg>`;
};

// Telegram Web K tail, as both apps draw it (MessageBubbleTail / messageBubbleShapePath):
// rides the bubble edge 17px up, reaches 6.675px out, tip rounded by a 1px arc.
// The path runs 1.6px under the bubble edge so no hairline seam shows between the two.
RT.tail = (side) => `<svg class="tail tail-${side}" viewBox="-0.4 0 9 17" aria-hidden="true" focusable="false"><path d="M8.6 17 L1.001 17 C0.084 17.001 -0.351 15.88 0.326 15.262 C2.505 13.267 4.047 11.107 5.951 8.782 C6.125 5.767 6.808 2.84 7.001 0 L8.6 0 Z"/></svg>`;

RT.EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];
