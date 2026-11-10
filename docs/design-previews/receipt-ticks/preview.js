'use strict';
// Review controls and URL state for index.html (one state) and states.html (every state).
(() => {
  const DEFAULTS = { device: 'mac', theme: 'light', state: 'group-sent' };
  const CHOICES = { device: ['mac', 'ios'], theme: ['light', 'dark'], state: RT.STATE_IDS };
  const page = document.body.dataset.page === 'states' ? 'states' : 'index';
  const params = new URLSearchParams(location.search);
  const state = Object.fromEntries(Object.keys(DEFAULTS).map((key) => {
    const value = params.get(key);
    return [key, CHOICES[key].includes(value) ? value : DEFAULTS[key]];
  }));
  // A bare hash (index.html#seen-list) also selects a state.
  const hash = decodeURIComponent(location.hash.slice(1));
  if (page === 'index' && RT.STATE_IDS.includes(hash)) state.state = hash;

  const controls = document.querySelector('.review-controls');
  const select = controls.querySelector('select[data-param=state]');
  if (select) select.innerHTML = RT.STATES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');

  const query = (overrides, keys) => {
    const merged = { ...state, ...overrides };
    const entries = keys.map((key) => [key, merged[key]]).filter(([key, value]) => value !== DEFAULTS[key]);
    const text = new URLSearchParams(entries).toString();
    return text ? `?${text}` : '';
  };
  const surface = (id) => (state.device === 'ios' ? RT.ios : RT.mac).render(id);

  function render() {
    document.documentElement.dataset.theme = state.theme;
    if (page === 'states') {
      const grid = document.getElementById('grid');
      grid.className = `grid grid-${state.device}`;
      grid.innerHTML = RT.STATES.map(([id, label]) => `<figure class="stage-fig${id === 'before-after' ? ' wide' : ''}" id="${id}">`
        + `<figcaption><a href="index.html${query({ state: id }, ['device', 'theme', 'state'])}">${label}</a></figcaption>`
        + `<div class="stage stage-${state.device}">${surface(id)}</div></figure>`).join('');
      document.title = `All states · ${state.device === 'ios' ? 'iPhone' : 'Mac'} · Read receipts`;
    } else {
      const stage = document.getElementById('stage');
      stage.className = `stage stage-${state.device}`;
      stage.innerHTML = surface(state.state);
      stage.setAttribute('aria-label', RT.label(state.state));
      document.title = `${RT.label(state.state)} · Read receipts`;
    }
    for (const group of controls.querySelectorAll('.segmented')) {
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset.value === state[group.dataset.param]));
      }
    }
    if (select) select.value = state.state;
    const other = controls.querySelector('[data-link]');
    if (other) other.href = `${other.dataset.link}${query({}, other.dataset.link === 'states.html' ? ['device', 'theme'] : ['device', 'theme', 'state'])}`;
    const keys = page === 'states' ? ['device', 'theme'] : ['device', 'theme', 'state'];
    history.replaceState(null, '', `${location.pathname}${query({}, keys)}`);
  }

  controls.addEventListener('click', (event) => {
    const button = event.target.closest('.segmented button');
    if (!button) return;
    state[button.closest('.segmented').dataset.param] = button.dataset.value;
    render();
  });
  controls.addEventListener('change', (event) => {
    if (event.target === select) { state.state = select.value; render(); }
  });
  // Rows that open something move between states, so the flow can be clicked through.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-go]');
    if (!target || page !== 'index') return;
    state.state = target.dataset.go;
    render();
  });
  render();
})();
