'use strict';
// Mac surfaces: transcript bubbles (transcript.tsx, group/contact compact density) and the
// message context menu (messageContextMenuContent.tsx on the dense-menu surface).
RT.mac = (() => {
  const L = RT.lucide;
  const P = RT.PEOPLE;

  // MessageDeliveryGlyph: lucide Check (sent) or CheckCheck (read), 14px in a 16px slot.
  function tick(kind, label) {
    const name = kind === 'read' ? 'checkCheck' : 'check';
    return `<span class="m-tick m-tick-${kind}" role="img" aria-label="${label || (kind === 'read' ? 'Read' : 'Sent')}">${L(name)}</span>`;
  }

  function bubble(message, { group, ticks, tickLabel }) {
    if (message.from === 'you') {
      return `<div class="m-bubble m-own"><span class="m-text">${RT.esc(message.text)}</span>`
        + `<span class="m-foot">${tick(message.ticks || ticks, tickLabel)}</span>${RT.tail('own')}</div>`;
    }
    const sender = group ? `<div class="m-sender">${RT.esc(P[message.from].name)}</div>` : '';
    return `<div class="m-bubble m-peer">${sender}<span class="m-text">${RT.esc(message.text)}</span>${RT.tail('peer')}</div>`;
  }

  function row(message, options) {
    const own = message.from === 'you';
    return `<div class="m-row ${own ? 'm-row-own' : 'm-row-peer'}">${RT.avatar(message.from, 28)}${bubble(message, options)}</div>`;
  }

  // ---------- Context menu ----------
  function item(icon, label, danger = false) {
    return `<div class="m-item${danger ? ' m-danger' : ''}" role="menuitem"><span class="m-item-icon">${L(icon)}</span><span class="m-item-label">${label}</span></div>`;
  }
  const divider = '<div class="m-divider" role="separator"></div>';

  function faces(keys, size) {
    return `<span class="m-faces" aria-hidden="true">${keys.map((key) => RT.avatar(key, size, 'm-face')).join('')}</span>`;
  }

  // The "Seen by" row in its four states. Loaded when the menu opens; groups up to 100.
  function seenRow(seen) {
    const icon = L('checkCheck', 'm-seen-icon');
    if (seen === 'loading') {
      return `<div class="m-seen" role="status" aria-label="Loading who has seen this">${icon}<span class="m-skel m-skel-text"></span><span class="m-faces"><span class="m-skel m-skel-face"></span><span class="m-skel m-skel-face"></span></span></div>`;
    }
    if (seen === 'none') return `<div class="m-seen m-seen-empty">${icon}<span class="m-seen-label">Not seen yet</span></div>`;
    if (seen === 'one') {
      return `<button type="button" class="m-seen m-seen-link" data-go="seen-list" title="Seen by Maya Patel">${icon}<span class="m-seen-label">Maya Patel</span>${faces(['maya'], 18)}</button>`;
    }
    const keys = RT.READERS.map(([key]) => key);
    return `<button type="button" class="m-seen m-seen-link" data-go="seen-list" title="Seen by ${keys.slice(0, 4).map((k) => P[k].name).join(', ')}">${icon}<span class="m-seen-label">${keys.length} Seen</span>${faces(keys.slice(0, 4), 18)}</button>`;
  }

  // Full list, in the order people read it, as a detail view of the same menu surface.
  function readersView() {
    const rows = RT.READERS.map(([key, time]) => `<div class="m-item m-reader" role="menuitem">${RT.avatar(key, 20)}<span class="m-item-label">${RT.esc(P[key].name)}</span><span class="m-meta">${time}</span></div>`).join('');
    return `<header class="m-menu-head"><button type="button" data-go="seen-several" aria-label="Back to message actions">${L('arrowLeft')}</button><strong>Seen by</strong></header><div class="m-readers">${rows}</div>`;
  }

  function reactions() {
    return `<div class="m-react" aria-label="Reactions">${RT.EMOJI.map((e) => `<span class="m-react-q">${e}</span>`).join('')}<span class="m-react-x">${L('chevronDown')}</span></div>`;
  }

  function menu(kind, seen) {
    let list;
    if (seen === 'list') {
      list = readersView();
    } else {
      list = item('textQuote', 'Quote') + item('messages', 'Open discussion') + divider
        + (kind === 'own' ? item('pencil', 'Edit') : '')
        + item('copy', 'Copy') + item('forward', 'Forward') + item('pin', 'Pin') + divider
        + item('circleCheck', 'Select')
        + (kind === 'peer' ? item('flag', 'Report') : '')
        + item('trash', 'Delete', true)
        + (kind === 'own' && seen ? seenRow(seen) : '');
    }
    return `<div class="m-menu-anchor m-menu-${kind}"><div class="m-menu-content">${reactions()}<div class="m-menu${seen === 'list' ? ' m-menu-detail' : ''}" role="menu">${list}</div></div></div>`;
  }

  // ---------- Window ----------
  function windowFor(state) {
    const { conv, ticks, menu: menuKind, seen } = RT.scene(state);
    const group = !conv.dm;
    const rows = conv.messages.map((message) => row(message, { group, ticks })).join('');
    const meta = conv.macMeta ? `<span class="m-head-meta">${conv.macMeta}</span>` : '';
    return `<div class="mac-window${menuKind ? ' has-menu' : ''}">
      <header class="m-head"><strong>${RT.esc(conv.title)}</strong>${meta}</header>
      <div class="m-canvas"><div class="m-transcript">${rows}</div>${menuKind ? menu(menuKind, seen) : ''}</div>
      <div class="m-composer"><span class="m-composer-plus">${L('plus')}</span><span class="m-composer-ph">Message ${RT.esc(conv.title)}…</span><span class="m-composer-send">${L('arrowUp')}</span></div>
    </div>`;
  }

  // ---------- Now and proposed ----------
  const NOW = {
    group: [['sent', 'Sent'], ['sent', 'Delivered', 'Same tick as Sent'], ['read', 'Read', 'At least one member']],
    dm: [['sent', 'Sent'], ['sent', 'Delivered', 'Same tick as Sent'], ['read', 'Read']],
  };
  const PROPOSED = {
    group: [['sent', 'Sent', 'The server has it'], ['read', 'Read', 'At least one other member']],
    dm: [['sent', 'Sent', 'The server has it'], ['read', 'Read']],
  };
  const BA_TEXT = { group: 'I moved the demo to Thursday at 3.', dm: 'Yes, 10:30. I’ll bring the draft.' };

  function baSection(kind, when, rowsSpec) {
    const cells = rowsSpec.map(([ticks, title, note]) => `<div class="ba-cap"><b>${title}</b>${note ? `<span>${note}</span>` : ''}</div>`
      + `<div class="ba-cell m-surface">${row({ from: 'you', text: BA_TEXT[kind] }, { group: true, ticks, tickLabel: title })}</div>`).join('');
    return `<section class="ba-section"><div class="ba-section-title"><span class="ba-when">${when} · </span>${kind === 'group' ? 'Group' : 'Direct'}</div><div class="ba-grid">${cells}</div></section>`;
  }

  // Rows line up across the two columns: Group beside Group, Direct beside Direct.
  function beforeAfter() {
    return `<div class="ba ba-mac"><h2 class="ba-col-title">Now</h2><h2 class="ba-col-title">Proposed</h2>`
      + baSection('group', 'Now', NOW.group) + baSection('group', 'Proposed', PROPOSED.group)
      + baSection('dm', 'Now', NOW.dm) + baSection('dm', 'Proposed', PROPOSED.dm) + '</div>';
  }

  return { render: (state) => (state === 'before-after' ? beforeAfter() : windowFor(state)) };
})();
