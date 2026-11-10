(() => {
  const D = window.PREVIEW_DATA;
  const DEFAULTS = {
    device: 'mac',
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    state: 'auto',
    place: 'paloalto',
  };
  const ALLOWED = {
    device: ['mac', 'ios'],
    theme: ['light', 'dark'],
    state: Object.keys(D.states),
    place: Object.keys(D.places),
  };
  const params = new URLSearchParams(location.search);
  const ui = {};
  for (const key in DEFAULTS) {
    const value = params.get(key);
    ui[key] = ALLOWED[key].includes(value) ? value : DEFAULTS[key];
  }

  // A fixed instant so the contact card clock is stable: 17:41 UTC.
  const NOW = new Date(Date.UTC(2026, 10, 9, 17, 41));
  const LOCATE_MS = 700;

  let profile; // { timeZone: {mode, value}, location: {mode, value}, permission }
  let saved; // JSON snapshot of what the server holds
  let locating = false;
  let prompt = false;
  let screen = 'profile'; // iPhone only: 'profile' | 'timezone'
  let focusAfterRender = null;

  const place = () => D.places[ui.place];
  const zone = (id) => D.zones.find((item) => item.id === id) ?? { id, label: id, short: id };
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (d, size = 16, width = 1.7, fill = 'none') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ARROW = '<path d="M20.5 3.5L3.5 10.6l7.2 2.7 2.7 7.2z"/>';
  const I = {
    arrowFill: (s) => svg(ARROW, s, 1.2, 'currentColor'),
    arrowLine: (s) => svg(ARROW, s, 1.7),
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevdown: '<path d="M6 9l6 6 6-6"/>',
    chevright: '<path d="M9 6l6 6-6 6"/>',
    chevleft: '<path d="M15 5l-7 7 7 7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 015.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z"/><circle cx="12" cy="13" r="3.4"/>',
  };

  function load() {
    profile = structuredClone(D.states[ui.state]);
    if (isLiveLocation(profile) && profile.location.value == null) profile.location.value = place().city;
    saved = JSON.stringify(profile);
    locating = false;
    prompt = false;
    screen = 'profile';
  }

  const isLiveLocation = (p) => p.location.mode === 'automatic' && p.permission === 'granted';
  const effectiveZone = (p) => (p.timeZone.mode === 'automatic' ? place().zone : p.timeZone.value);
  const dirty = () => JSON.stringify({ ...profile, permission: null }) !== JSON.stringify({ ...JSON.parse(saved), permission: null });
  const clock = (zoneId) => new Intl.DateTimeFormat('en-US', { timeZone: zoneId, hour: 'numeric', minute: '2-digit' }).format(NOW);

  // Resolves the device city, as the app would after a reduced-accuracy fix and reverse geocoding.
  // `background` writes straight to the saved profile, like the launch/foreground sync.
  function locate(background) {
    locating = true;
    render();
    setTimeout(() => {
      locating = false;
      profile.location.value = place().city;
      if (background) {
        const next = JSON.parse(saved);
        if (next.location.mode === 'automatic') next.location.value = place().city;
        saved = JSON.stringify(next);
      }
      render();
    }, LOCATE_MS);
  }

  function turnOnLocation() {
    if (profile.permission === 'notDetermined') {
      prompt = true;
      return render();
    }
    profile.location.mode = 'automatic';
    if (profile.permission === 'granted') return locate(false);
    render(); // denied: the field stays as it is
  }

  function answerPrompt(allow) {
    prompt = false;
    profile.permission = allow ? 'granted' : 'denied';
    profile.location.mode = 'automatic';
    if (allow) return locate(false);
    render();
  }

  // ---------- Mac ----------
  function macLocationRow() {
    const auto = profile.location.mode === 'automatic';
    const denied = auto && profile.permission === 'denied';
    const value = locating ? 'Locating…' : (profile.location.value ?? '');
    const trailing = auto
      ? `<button class="auto" data-act="loc-off" title="Turn off automatic location" aria-label="Automatic location on">${I.arrowFill(10)}Automatic</button>`
      : `<button class="useauto" data-act="loc-on" title="Set automatically" aria-label="Set location automatically">${I.arrowLine(14)}</button>`;
    const line = denied ? '<div class="mline"><button class="link" data-act="settings">Allow location in System Settings</button></div>' : '';
    return `<div class="mr${denied ? ' withline' : ''}"><label class="mk" for="loc">Location</label><div style="min-width:0">
      <div class="mv"><input id="loc" data-field="location" value="${esc(value)}" placeholder="Add your location" maxlength="80" ${locating ? 'readonly class="pending"' : ''} autocomplete="off">${trailing}</div>${line}</div></div>`;
  }

  function macTimeZoneRow() {
    const auto = profile.timeZone.mode === 'automatic';
    const current = zone(effectiveZone(profile));
    const options = [`<option value=""${auto ? ' selected' : ''}>Automatic · ${esc(zone(place().zone).label)}</option>`]
      .concat(D.zones.map((z) => `<option value="${z.id}"${!auto && z.id === profile.timeZone.value ? ' selected' : ''}>${esc(z.label)}</option>`));
    return `<div class="mr"><label class="mk" for="tz">Time zone</label><div style="min-width:0">
      <div class="mv"><span class="val">${esc(current.label)}</span>${auto ? `<span class="auto static">${I.arrowFill(10)}Automatic</span>` : ''}<span class="chev">${svg(I.chevdown, 13, 2)}</span>
      <select id="tz" class="overlay" data-field="timeZone" aria-label="Time zone">${options.join('')}</select></div></div></div>`;
  }

  function mac() {
    const p = D.person;
    const nav = (group, items) => `<div class="ngroup"><div class="nlabel">${group}</div>${items.map(([icon, label, on]) => `<div class="nitem${on ? ' on' : ''}">${svg(I[icon])}<span>${label}</span></div>`).join('')}</div>`;
    const mr = (key, value, cls = '', extra = '') => `<div class="mr${cls}"><span class="mk">${key}</span><div style="min-width:0"><div class="mv${extra}">${value}</div></div></div>`;
    const chev = `<span class="chev" style="margin-left:auto">${svg(I.chevdown, 13, 2)}</span>`;
    const alert = prompt ? `<div class="scrim"><div class="malert" role="alertdialog" aria-label="Location permission">
        <div class="icon">${I.arrowFill(24)}</div>
        <b>“Kordi” would like to use your current location.</b>
        <p>Kordi keeps the city on your profile current when you turn that on, and finds nearby people when you ask.</p>
        <div class="acts"><button class="primary" data-act="allow">Allow</button><button data-act="deny">Don’t Allow</button></div>
      </div></div>` : '';
    return `<div><div class="cap">Account settings · Profile</div>
    <div class="dlg" role="dialog" aria-label="Account settings">
      <div class="rail">
        <div class="search">${svg(I.search, 14)}<span>Search</span></div>
        ${nav('Account', [['user', 'Profile', 1], ['laptop', 'Active sessions']])}
        ${nav('Settings', [['key', 'Authentication'], ['bell', 'Notifications'], ['plug', 'Connectors'], ['palette', 'Appearance']])}
      </div>
      <div class="mpage">
        <div class="mhead"><span class="xbtn">${svg(I.x)}</span></div>
        <div class="mbody"><div class="section">
          <h2>Profile</h2>
          <div class="mavrow"><div class="av" style="width:64px;height:64px;font-size:26px" aria-hidden="true">M</div></div>
          ${mr('Name', p.name)}
          ${mr('Kordi ID', `<span><span style="color:var(--m-300)">@</span>${p.handle}</span>`)}
          ${mr('About', p.about, ' top')}
          ${macLocationRow()}
          ${macTimeZoneRow()}
          ${mr('Website', '<span class="ph">Add your website</span>')}
          ${mr('Birthday', `${p.birthdayMac}${chev}`)}
          ${mr('Email', p.email, '', ' ro')}
          <div class="rows" style="margin-top:24px"><div class="row"><div class="rt"><b>Save changes</b></div><button class="btn" data-act="save"${dirty() ? '' : ' disabled'}>Save</button></div></div>
        </div></div>
      </div>
      ${alert}
    </div></div>
    ${contactCard()}`;
  }

  function contactCard() {
    const s = JSON.parse(saved);
    const zoneId = effectiveZone(s);
    const where = s.location.value ? `${esc(s.location.value)} · ` : '';
    return `<div><div class="cap">Contact card · saved values</div>
      <div class="card"><div class="av" style="width:44px;height:44px;font-size:18px" aria-hidden="true">M</div>
      <div><div class="n">${D.person.name}</div><div class="h">@${D.person.handle}</div><div class="p">${where}${clock(zoneId)}</div></div></div></div>`;
  }

  // ---------- iPhone ----------
  function statusBar() {
    return `<div class="sbar"><span>9:41</span><span class="gl"><svg width="18" height="11" viewBox="0 0 18 11" fill="currentColor" aria-hidden="true"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="6" rx="1"/><rect x="10" y="2.5" width="3" height="8.5" rx="1"/><rect x="15" y="0" width="3" height="11" rx="1"/></svg><svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="8" rx="1.6" fill="currentColor"/></svg></span></div>`;
  }

  function iosProfile() {
    const p = D.person;
    const row = (key, value, trail = '', cls = '') => `<div class="ir${cls}"><span class="k">${key}</span>${value}${trail}</div>`;
    const chev = `<span class="chev">${svg(I.chevright, 14, 2)}</span>`;
    const locAuto = profile.location.mode === 'automatic';
    const denied = locAuto && profile.permission === 'denied';
    const locValue = locating ? 'Locating…' : (profile.location.value ?? '');
    const locGlyph = `<span class="trail"><button class="glyph${locAuto ? ' on' : ''}" data-act="${locAuto ? 'loc-off' : 'loc-on'}" aria-pressed="${locAuto}" aria-label="Automatic location">${locAuto ? I.arrowFill(17) : I.arrowLine(17)}</button></span>`;
    const locRow = `<div class="ir${denied ? ' withcap' : ''}"><label class="k" for="loc">Location</label><input id="loc" data-field="location" value="${esc(locValue)}" placeholder="Add your location" maxlength="80" ${locating ? 'readonly class="pending"' : ''} autocomplete="off">${locGlyph}
      ${denied ? '<div class="icap"><button class="link" data-act="settings">Allow location in Settings</button></div>' : ''}</div>`;
    const tzAuto = profile.timeZone.mode === 'automatic';
    const tz = zone(effectiveZone(profile));
    const tzRow = `<button class="ir btnrow" data-act="tz-open"><span class="k">Time zone</span><span class="v">${esc(tz.short)}</span><span class="trail">${tzAuto ? `<span class="glyph static" aria-label="Automatic">${I.arrowFill(13)}</span>` : ''}${chev}</span></button>`;
    const action = `<button class="act${dirty() ? ' on' : ''}" data-act="save"${dirty() ? '' : ' aria-disabled="true"'}>Save</button>`;
    return `<div class="inav"><button class="l">Cancel</button><span class="t">Edit profile</span>${action}</div>
      <div class="iscroll"><div class="banner" aria-hidden="true"></div>
      <div class="ihead"><div class="iav"><div class="av" aria-hidden="true">M</div><span class="cam" aria-hidden="true">${svg(I.camera, 22)}</span></div></div>
      <div class="itable">
        ${row('Name', `<span class="v">${p.name}</span>`)}
        ${row('Kordi ID', `<span class="v"><span style="color:var(--i-secondary)">@</span>${p.handle}</span>`)}
        ${row('About', `<span class="v wrap">${p.about}</span>`, '', ' tall')}
        ${locRow}
        ${tzRow}
        ${row('Website', '<span class="v phd">Add your website</span>')}
        ${row('Birthday', `<span class="v">${p.birthdayIos}</span>`, `<span class="trail">${chev}</span>`)}
        ${row('Email', `<span class="v ro">${p.email}</span>`)}
      </div>
      <div class="signout">Sign out</div></div>`;
  }

  function iosTimeZones() {
    const auto = profile.timeZone.mode === 'automatic';
    const check = `<span class="check">${svg(I.check, 18, 2.2)}</span>`;
    const rows = [`<button class="zone" data-zone=""><span class="zt"><b>Automatic</b><small>${esc(zone(place().zone).short)}</small></span>${auto ? check : ''}</button>`]
      .concat(D.zones.map((z) => `<button class="zone" data-zone="${z.id}"><span class="zt"><b>${esc(z.short)}</b><small>${z.id}</small></span>${!auto && profile.timeZone.value === z.id ? check : ''}</button>`));
    return `<div class="inav"><button class="l" data-act="tz-back" style="color:var(--i-accent)">${svg(I.chevleft, 22, 2.2)}</button><span class="t">Time zone</span><span></span></div>
      <div class="isearch">${svg(I.search, 16, 2)}<span>Search</span></div>
      <div class="iscroll">${rows.join('')}</div>`;
  }

  function ios() {
    const alert = prompt ? `<div class="ialert-scrim"><div class="ialert" role="alertdialog" aria-label="Location permission">
        <div class="body"><b>Allow “Kordi” to use your location?</b><p>Kordi keeps the city on your profile current when you turn that on, and shows people near you who also turned on Nearby.</p></div>
        <button data-act="allow">Allow Once</button><button data-act="allow">Allow While Using App</button><button data-act="deny">Don’t Allow</button>
      </div></div>` : '';
    return `<div><div class="cap">Edit profile · 393pt</div>
      <div class="phone">${statusBar()}${screen === 'timezone' ? iosTimeZones() : iosProfile()}${alert}</div></div>
      ${contactCard()}`;
  }

  const NOTES = {
    auto: 'Automatic: both fields follow this device. Switch “Device is in” to see them update without Save; the contact card shows what contacts and chat members see.',
    manual: 'Manual: values the person typed or picked. Switching the device place changes nothing. The arrow button (Mac) or outline arrow (iPhone) turns automatic back on.',
    denied: 'Denied: automatic location is on, but the operating system blocks location. The last city stays; nothing falls back to the time-zone region. The link stands in for opening Settings and, in this preview, grants access.',
    empty: 'Empty (new or never-set account): the time zone is automatic by default; location stays empty until the person turns it on, which shows the system permission prompt.',
  };

  function render() {
    document.documentElement.dataset.theme = ui.theme;
    const stage = document.getElementById('stage');
    stage.innerHTML = ui.device === 'mac' ? mac() : ios();
    document.getElementById('note').textContent = NOTES[ui.state];
    document.querySelectorAll('.seg').forEach((seg) => seg.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(ui[seg.dataset.key] === button.dataset.v));
    }));
    const query = new URLSearchParams(ui).toString();
    if (location.search.slice(1) !== query) history.replaceState(null, '', `?${query}`);
    if (focusAfterRender) {
      const input = document.getElementById(focusAfterRender.id);
      if (input) {
        input.focus();
        const at = focusAfterRender.caret ?? input.value.length;
        input.setSelectionRange(at, at);
      }
      focusAfterRender = null;
    }
  }

  document.getElementById('bar').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-v]');
    if (!button) return;
    const key = button.parentElement.dataset.key;
    const previous = ui[key];
    ui[key] = button.dataset.v;
    if (key === 'state') load();
    if (key === 'place' && previous !== ui.place) {
      if (isLiveLocation(profile)) return locate(true);
    }
    render();
  });

  const stage = document.getElementById('stage');
  stage.addEventListener('click', (event) => {
    const zoneButton = event.target.closest('[data-zone]');
    if (zoneButton) {
      const id = zoneButton.dataset.zone;
      profile.timeZone = id ? { mode: 'manual', value: id } : { mode: 'automatic', value: null };
      screen = 'profile';
      return render();
    }
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'loc-on') return turnOnLocation();
    if (act === 'loc-off') {
      profile.location.mode = 'manual';
      focusAfterRender = { id: 'loc' };
      return render();
    }
    if (act === 'allow') return answerPrompt(true);
    if (act === 'deny') return answerPrompt(false);
    if (act === 'settings') {
      profile.permission = 'granted';
      return locate(false);
    }
    if (act === 'tz-open') { screen = 'timezone'; return render(); }
    if (act === 'tz-back') { screen = 'profile'; return render(); }
    if (act === 'save' && dirty()) {
      saved = JSON.stringify(profile);
      return render();
    }
  });

  stage.addEventListener('input', (event) => {
    if (event.target.dataset.field !== 'location' || locating) return;
    // Typing makes the field manual; a manual value is never overwritten.
    profile.location = { mode: 'manual', value: event.target.value };
    focusAfterRender = { id: 'loc', caret: event.target.selectionStart };
    render();
  });

  stage.addEventListener('change', (event) => {
    if (event.target.dataset.field !== 'timeZone') return;
    const id = event.target.value;
    profile.timeZone = id ? { mode: 'manual', value: id } : { mode: 'automatic', value: null };
    render();
  });

  load();
  render();
})();
