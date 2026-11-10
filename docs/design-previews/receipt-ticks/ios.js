'use strict';
// iPhone surfaces: MessageBubble (chat layout), the floating MessageActionOverlay with its
// reaction pill and action menu, and a flat Settings-style sheet for the full readers list.
RT.ios = (() => {
  const S = RT.sf;
  const P = RT.PEOPLE;

  // MessageDeliveryGlyph inside the bubble's bottom-trailing corner, tinted by state.
  function ticks(kind, label) {
    return `<span class="i-ticks i-ticks-${kind}" role="img" aria-label="${label || (kind === 'read' ? 'Seen' : 'Sent')}">${RT.iosTicks(kind)}</span>`;
  }

  function bubble(message, { group, ticks: kind, showAuthor, tickLabel }) {
    if (message.from === 'you') {
      return `<div class="i-bubble i-own"><span class="i-text">${RT.esc(message.text)}</span>${ticks(message.ticks || kind, tickLabel)}${RT.tail('own')}</div>`;
    }
    const author = group && showAuthor ? `<div class="i-author">${RT.esc(P[message.from].name)}</div>` : '';
    return `<div class="i-bubble i-peer">${author}<span class="i-text">${RT.esc(message.text)}</span>${RT.tail('peer')}</div>`;
  }

  function row(message, options) {
    if (message.from === 'you') return `<div class="i-row i-row-own">${bubble(message, options)}</div>`;
    return `<div class="i-row i-row-peer"><span class="i-av-slot">${RT.avatar(message.from, 28)}</span>${bubble(message, options)}</div>`;
  }

  function rows(conv, kind) {
    return conv.messages.map((message, index) => {
      const previous = conv.messages[index - 1];
      return row(message, { group: !conv.dm, ticks: kind, showAuthor: !previous || previous.from !== message.from });
    }).join('');
  }

  // ---------- Action overlay ----------
  function action(icon, label, danger = false) {
    return `<div class="i-action${danger ? ' i-danger' : ''}" role="menuitem">${S(icon)}<span>${label}</span></div>`;
  }
  const divider = '<div class="i-divider" role="separator"></div>';

  function faces(keys) {
    return `<span class="i-faces" aria-hidden="true">${keys.map((key) => RT.avatar(key, 18, 'i-face')).join('')}</span>`;
  }

  // MessageActionReadReceiptRow in its four states.
  function seenRow(seen) {
    const glyph = `<span class="i-seen-glyph">${RT.iosTicks('read')}</span>`;
    let body;
    if (seen === 'loading') {
      body = `<div class="i-seen" role="status" aria-label="Loading who has seen this">${glyph}<span class="i-skel i-skel-text"></span><span class="i-faces"><span class="i-skel i-skel-face"></span><span class="i-skel i-skel-face"></span></span></div>`;
    } else if (seen === 'none') {
      body = `<div class="i-seen i-seen-empty">${glyph}<span class="i-seen-label">Not seen yet</span></div>`;
    } else if (seen === 'one') {
      body = `<button type="button" class="i-seen i-seen-link" data-go="seen-list">${glyph}<span class="i-seen-label">Maya Patel</span>${faces(['maya'])}</button>`;
    } else {
      const keys = RT.READERS.map(([key]) => key);
      body = `<button type="button" class="i-seen i-seen-link" data-go="seen-list">${glyph}<span class="i-seen-label">${keys.length} Seen</span>${faces(keys.slice(0, 4))}</button>`;
    }
    return divider + body;
  }

  function actionMenu(kind, seen) {
    return `<div class="i-menu" role="menu">`
      + action('textQuote', 'Quote') + action('bubbles', 'Open discussion') + divider
      + action('docOnDoc', 'Copy') + action('share', 'Share')
      + (kind === 'own' ? action('pencil', 'Edit') : '')
      + action('arrowshape', 'Forward') + action('pin', 'Pin') + divider
      + action('checkCircle', 'Select')
      + (kind === 'peer' ? action('flag', 'Report') : '')
      + action('trash', 'Delete', true)
      + (kind === 'own' && seen ? seenRow(seen) : '')
      + '</div>';
  }

  function reactionPill() {
    return `<div class="i-pill" aria-label="Reactions">${RT.EMOJI.map((e) => `<span class="i-pill-q">${e}</span>`).join('')}<span class="i-pill-x">${S('chevronDown')}</span></div>`;
  }

  function overlay(conv, kind, seen, tickKind) {
    const target = kind === 'own'
      ? conv.messages.filter((m) => m.from === 'you').at(-1)
      : conv.messages.filter((m) => m.from !== 'you').at(-1);
    const index = conv.messages.lastIndexOf(target);
    const previous = conv.messages[index - 1];
    const lifted = bubble(target, { group: !conv.dm, ticks: tickKind, showAuthor: !previous || previous.from !== target.from });
    return `<div class="i-backdrop" aria-hidden="true"></div>`
      + `<div class="i-actions i-actions-${kind}">${actionMenu(kind, seen)}${reactionPill()}<div class="i-lifted">${lifted}</div></div>`;
  }

  // ---------- Readers sheet (flat Settings-sheet style) ----------
  function readersSheet() {
    const list = RT.READERS.map(([key, time]) => `<div class="i-reader">${RT.avatar(key, 32)}<span class="i-reader-name">${RT.esc(P[key].name)}</span><span class="i-reader-time">${time}</span></div>`).join('');
    return `<div class="i-dim" aria-hidden="true"></div><div class="i-sheet" role="dialog" aria-label="Seen by"><span class="i-grabber" aria-hidden="true"></span>`
      + `<div class="i-sheet-nav"><span></span><strong>Seen by</strong><button type="button" class="i-done" data-go="seen-several">Done</button></div>`
      + `<div class="i-sheet-body">${list}</div></div>`;
  }

  // ---------- Phone ----------
  const statusBar = `<div class="i-status" aria-hidden="true"><span>9:41</span><span class="i-status-icons"><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg><svg viewBox="0 0 27 12"><rect x="0.5" y="0.5" width="23" height="11" rx="3.5" class="i-batt-shell"/><rect x="2" y="2" width="18" height="8" rx="2"/><rect x="25" y="4" width="1.6" height="4" rx="0.8"/></svg></span></div>`;

  function phone(state) {
    const { conv, ticks: tickKind, menu, seen } = RT.scene(state);
    const sheet = seen === 'list';
    return `<div class="phone"><div class="screen">${statusBar}
      <div class="i-transcript">${rows(conv, tickKind)}</div>
      <div class="i-nav"><span class="i-glass i-circle">${S('chevronLeft')}</span><span class="i-glass i-title"><b>${RT.esc(conv.title)}</b><small>${conv.iosMeta}</small></span><span class="i-glass i-circle">${S('ellipsis')}</span></div>
      <div class="i-composer"><span class="i-glass i-circle">${S('plus')}</span><span class="i-glass i-field"><span>Message</span>${S('mic', 'i-mic')}</span></div>
      <div class="i-home" aria-hidden="true"></div>
      ${menu && !sheet ? overlay(conv, menu, seen, tickKind) : ''}${sheet ? readersSheet() : ''}
    </div></div>`;
  }

  // ---------- Now and proposed ----------
  const NOW = {
    group: [['sent', 'Sent'], ['sent', 'Delivered', 'Same tick as Sent'], ['read', 'Read', 'Count only in VoiceOver: “Seen by 3”']],
    dm: [['sent', 'Sent'], ['sent', 'Delivered', 'Same tick as Sent'], ['read', 'Read']],
  };
  const PROPOSED = {
    group: [['sent', 'Sent', 'The server has it'], ['read', 'Read', 'At least one other member']],
    dm: [['sent', 'Sent', 'The server has it'], ['read', 'Read']],
  };
  const BA_TEXT = { group: 'I moved the demo to Thursday at 3.', dm: 'Yes, 10:30. I’ll bring the draft.' };

  function baSection(kind, when, spec) {
    const cells = spec.map(([tickKind, title, note]) => `<div class="ba-cap"><b>${title}</b>${note ? `<span>${note}</span>` : ''}</div>`
      + `<div class="ba-cell i-surface">${row({ from: 'you', text: BA_TEXT[kind] }, { group: true, ticks: tickKind, tickLabel: title === 'Read' && kind === 'group' && spec === NOW.group ? 'Seen by 3' : title })}</div>`).join('');
    return `<section class="ba-section"><div class="ba-section-title"><span class="ba-when">${when} · </span>${kind === 'group' ? 'Group' : 'Direct'}</div><div class="ba-grid">${cells}</div></section>`;
  }

  // Rows line up across the two columns: Group beside Group, Direct beside Direct.
  function beforeAfter() {
    return `<div class="ba ba-ios"><h2 class="ba-col-title">Now</h2><h2 class="ba-col-title">Proposed</h2>`
      + baSection('group', 'Now', NOW.group) + baSection('group', 'Proposed', PROPOSED.group)
      + baSection('dm', 'Now', NOW.dm) + baSection('dm', 'Proposed', PROPOSED.dm) + '</div>';
  }

  return { render: (state) => (state === 'before-after' ? beforeAfter() : phone(state)) };
})();
