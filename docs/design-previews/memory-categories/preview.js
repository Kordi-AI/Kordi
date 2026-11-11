// Synthetic memories for the memory categories preview. Nothing here connects to an API.
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const icon = (path) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const CHEVRON = icon('<path d="M6 9l6 6 6-6"/>');
const CHECK = icon('<path d="M5 12l5 5 9-10"/>');
const TAG = icon('<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1"/>');
const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Same order and labels as memoryCategory.ts.
const CATEGORIES = [
  ['general_preferences', 'Preference'],
  ['goals_and_constraints', 'Goal'],
  ['health_context', 'Health'],
  ['education_learner_profile', 'Learning'],
  ['work_context', 'Work'],
  ['purchase_history_preferences', 'Shopping'],
  ['values_and_ethics', 'Values'],
  ['location_context', 'Location'],
  ['coordination_context', 'Schedule'],
  ['hcp-custom:task_lessons', 'Task note'],
];
const LABEL = Object.fromEntries(CATEGORIES.map(([id, label]) => [id, label]));
const GROUP_REFUSED = new Set(['health_context', 'location_context', 'purchase_history_preferences', 'values_and_ethics']);
const MAX = 3;

const memories = [
  { text: "Won't take on projects for tobacco companies.", meta: 'Saved by your agent · high confidence · Yesterday', from: 'Job search', categories: ['values_and_ethics', 'work_context'] },
  { text: 'Answer in British English and keep replies short unless I ask for more.', meta: 'From a correction · Today', from: 'Settings', categories: ['general_preferences'] },
  { text: 'Hay fever in spring, so avoid suggesting outdoor meetings in April and May.', meta: 'Added by you · 3 Nov', from: 'Settings', categories: ['health_context', 'coordination_context'] },
  { text: 'The group ships the poster on Friday and reviews it on Thursday.', meta: 'Added by Priya · 18 Oct', from: 'Poster group', categories: ['coordination_context'], group: true },
];

let openMenu = 0;

const choices = (memory) => CATEGORIES.filter(([id]) => !(memory.group && GROUP_REFUSED.has(id)));

// Cards follow every category: Work, Health or Daily tasks, and Schedule reaches every card.
function cards(memory) {
  if (memory.group) return [];
  const set = new Set(memory.categories);
  if (set.has('coordination_context')) return ['Every card'];
  const out = [];
  if (set.has('work_context') || set.has('education_learner_profile')) out.push('Work');
  if (set.has('health_context')) out.push('Health');
  if (set.has('location_context') || set.has('purchase_history_preferences')) out.push('Daily tasks');
  return out;
}

function toggle(memory, id) {
  const has = memory.categories.includes(id);
  if (has && memory.categories.length === 1) return;
  if (!has && memory.categories.length >= MAX) return;
  memory.categories = has ? memory.categories.filter((c) => c !== id) : [...memory.categories, id];
  render();
}

function menuItems(memory, kind) {
  const item = ([id, label]) => {
    const on = memory.categories.includes(id);
    const disabled = (on && memory.categories.length === 1) || (!on && memory.categories.length >= MAX);
    return kind === 'mac'
      ? `<button type="button" role="menuitemcheckbox" aria-checked="${on}" data-toggle="${id}" ${disabled ? 'disabled' : ''}><span class="mo-check">${on ? CHECK : ''}</span>${label}</button>`
      : `<button type="button" data-toggle="${id}" ${disabled ? 'disabled' : ''}><span class="ck">${on ? CHECK : ''}</span><span class="txt">${label}</span></button>`;
  };
  return choices(memory).map(item).join('');
}

function macRow(memory, index) {
  const cats = memory.categories.map((id, i) => {
    const last = i === memory.categories.length - 1;
    const chip = `<span class="mo-chip"><button class="mo-part" type="button">${LABEL[id]}</button>${last ? `<button class="mo-icon" type="button" aria-label="Change categories" aria-expanded="${openMenu === index}" data-open="${index}">${CHEVRON}</button>` : ''}</span>`;
    return last ? `<span class="mo-wrap">${chip}${openMenu === index ? `<span class="mo-menu" role="menu" data-menu="${index}">${menuItems(memory, 'mac')}</span>` : ''}</span>` : chip;
  }).join('');
  const cardChips = cards(memory).map((name) => `<span class="mo-chip is-card"><span class="mo-part">${name}</span></span>`).join('');
  const add = memory.group ? '' : '<span class="mo-chip is-add">+ Card</span>';
  return `
    <div class="m-mem">
      <div class="m-mem-text">
        <div class="m-mem-title">${esc(memory.text)}</div>
        <div class="m-mem-meta">${memory.meta}</div>
        <div class="mo-labels" data-row="${index}">${cats}${cardChips}${add}<span class="mo-chip is-from">${memory.from}</span></div>
      </div>
      <div class="m-mem-acts"><button class="qbtn">Edit</button><button class="qbtn">Delete</button></div>
    </div>`;
}

function iosRow(memory) {
  const chips = [
    ...memory.categories.map((id) => `<span class="i-chip">${LABEL[id]}</span>`),
    ...cards(memory).map((name) => `<span class="i-chip is-card">${name}</span>`),
    `<span class="i-chip is-from">${memory.from}</span>`,
  ].join('');
  return `<div class="i-row"><div class="i-row-title">${esc(memory.text)}</div><div class="i-row-sub">${memory.meta}</div><div class="i-chips">${chips}</div></div>`;
}

function render() {
  document.getElementById('mac').innerHTML = `<div class="m-list">${memories.map(macRow).join('')}</div>`;
  const first = memories[0];
  document.getElementById('ios').innerHTML = `
    <div class="i-title">Memory</div>
    <div class="i-list">${memories.map(iosRow).join('')}</div>
    <div class="i-menu" data-ios-menu="0"><div class="head">${TAG}Categories</div>${menuItems(first, 'ios')}</div>`;
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, .mo-menu, .i-menu');
  const opener = event.target.closest('[data-open]');
  if (opener) { const i = Number(opener.dataset.open); openMenu = openMenu === i ? null : i; render(); return; }
  const tog = event.target.closest('[data-toggle]');
  if (tog) {
    const menu = tog.closest('[data-menu], [data-ios-menu]');
    const index = Number(menu.dataset.menu ?? menu.dataset.iosMenu);
    toggle(memories[index], tog.dataset.toggle);
    return;
  }
  if (!target && openMenu !== null) { openMenu = null; render(); }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && openMenu !== null) { openMenu = null; render(); } });

render();
