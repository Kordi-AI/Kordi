// Factory page design preview. Synthetic data only; no network calls.

const ICONS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  puzzle: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  agentChat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 9h.01"/><path d="M15 9h.01"/><path d="M9 13c1.5 1 4.5 1 6 0"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  notebook: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
};

const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// ---- Sample data -----------------------------------------------------------

const AGENT = 'System agent';
const skill = (name, desc, source, version, enabled, usedBy, files, when) => ({ name, desc, source, version, enabled, usedBy, files, when });

const SKILLS = [
  skill('adapt', 'Rewrite a draft, design or document for a new audience, format or length while keeping its structure and voice.', 'Local library', '1.3.0', true, [AGENT], ['SKILL.md', 'references/tone-presets.md', 'examples/before-after.md']),
  skill('arxiv-digest', 'Summarize new arXiv papers in chosen categories into a short daily digest with links.', 'ClawHub', '0.4.2', true, [AGENT], ['SKILL.md', 'scripts/fetch.py']),
  skill('brand-voice', 'Apply a written brand voice guide to copy, with before and after examples.', 'ClawHub', '2.0.1', true, [], ['SKILL.md', 'references/voice-guide.md']),
  skill('chatcut-app-promo-guide', 'Make software, app or website promo videos with motion graphics or generated video in a ChatCut project.', 'Kordi Factory', '1.8.0', true, [AGENT], ['SKILL.md', 'references/storyboard.md']),
  skill('chatcut-audio-processing-gen', 'Create EQ, filters, saturation, delay and reverb as reusable audio sources in a ChatCut project.', 'Kordi Factory', '1.2.0', true, [AGENT], ['SKILL.md']),
  skill('chatcut-caption-template-impl', 'Design animated captions and kinetic typography bound to real speech in a ChatCut project.', 'Kordi Factory', '1.4.3', true, [AGENT], ['SKILL.md', 'references/presets.md']),
  skill('chatcut-create-motion-graphics', 'Create, revise and place editable motion graphics, overlays and title cards in a ChatCut project.', 'Kordi Factory', '2.1.0', true, [AGENT], ['SKILL.md', 'references/layouts.md', 'references/easing.md']),
  skill('chatcut-digital-human', 'Turn a portrait and a script or audio track into a talking presenter video.', 'Kordi Factory', '1.0.4', true, [AGENT], ['SKILL.md']),
  skill('chatcut-image-gen', 'Generate and edit images, covers and posters, and add them to a ChatCut project.', 'Kordi Factory', '1.6.0', true, [AGENT], ['SKILL.md', 'references/models.md']),
  skill('chatcut-lipsync', 'Synchronize mouth movement in existing video to final speech audio.', 'Kordi Factory', '1.1.2', true, [AGENT], ['SKILL.md']),
  skill('chatcut-music', 'Generate instrumental or vocal background music sized to a timeline.', 'Kordi Factory', '1.3.1', true, [AGENT], ['SKILL.md']),
  skill('chatcut-transcription', 'Transcribe speech into word-timed transcripts and editable subtitles.', 'Kordi Factory', '2.0.0', true, [AGENT], ['SKILL.md', 'references/languages.md']),
  skill('chatcut-video-gen', 'Generate and extend video from text, images or reference frames.', 'Kordi Factory', '1.9.2', true, [AGENT], ['SKILL.md', 'references/models.md']),
  skill('chatcut-voice', 'Create speech, consented voice clones and sound effects, and align voiceover.', 'Kordi Factory', '1.5.0', true, [AGENT], ['SKILL.md']),
  skill('chatcut-voice-isolation', 'Remove background noise, hum and room echo from speech.', 'Kordi Factory', '1.0.1', false, [], ['SKILL.md']),
  skill('code-review', 'Review a diff or pull request for correctness bugs and report findings by severity.', 'Local library', '0.9.0', true, [AGENT], ['SKILL.md', 'references/checklist.md']),
  skill('data-visualization', 'Choose the right chart for a dataset and build it with accessible colors.', 'skills.sh', '1.1.0', true, [AGENT], ['SKILL.md', 'references/palette.md']),
  skill('docx', 'Create, read and edit Word documents with tracked changes and comments.', 'Local library', '3.2.0', true, [AGENT], ['SKILL.md', 'scripts/unpack.py', 'scripts/pack.py']),
  skill('experimental-design', 'Plan experiments before data collection: randomization, blocking and factorial layouts.', 'skills.sh', '0.6.0', false, [], ['SKILL.md']),
  skill('latex-paper-en', 'Repair compiles, format for a venue and polish sections of an English LaTeX paper.', 'Local library', '1.7.0', true, [], ['SKILL.md', 'references/venues.md']),
  skill('meeting-notes', 'Turn a transcript into decisions, owners and follow-ups.', 'ClawHub', '1.2.0', true, [AGENT], ['SKILL.md']),
  skill('pdf', 'Read, fill, merge, split and annotate PDF files.', 'Local library', '2.4.1', true, [AGENT], ['SKILL.md', 'scripts/fill_form.py']),
  skill('pptx', 'Create and edit PowerPoint decks from outlines or existing slides.', 'Local library', '2.2.0', true, [AGENT], ['SKILL.md', 'scripts/thumbnail.py']),
  skill('release-notes', 'Draft release notes from merged pull requests, grouped by area.', 'This project', '0.3.0', true, [AGENT], ['SKILL.md']),
  skill('research-paper-writing', 'Improve structure, flow and claim support in ML paper sections.', 'Local library', '1.0.0', true, [], ['SKILL.md']),
  skill('scientific-visualization', 'Build truthful, publication-ready figures with uncertainty shown.', 'skills.sh', '1.3.0', true, [], ['SKILL.md']),
  skill('swift-concurrency', 'Diagnose Swift concurrency warnings and migrate callbacks to async and await.', 'Local library', '1.1.0', true, [AGENT], ['SKILL.md']),
  skill('swiftui-expert-skill', 'Write and review SwiftUI views, state and performance.', 'Local library', '2.0.0', true, [AGENT], ['SKILL.md', 'references/observable.md']),
  skill('tikz-diagrams', 'Create and render TikZ diagrams for papers and slides.', 'Local library', '0.8.0', false, [], ['SKILL.md']),
  skill('xlsx', 'Create and edit spreadsheets with formulas, formatting and charts.', 'Local library', '2.3.0', true, [AGENT], ['SKILL.md', 'scripts/recalc.py']),
];

const ADAPT_MD = `---
name: adapt
description: Rewrite a draft, design or document for a new audience, format or length while keeping its structure and voice.
---

# Adapt

Use this skill when the user wants an existing piece reshaped rather than written from scratch.

## When to use

- A document needs a shorter, longer or differently structured version.
- The same content must reach a different audience, such as executives, engineers or customers.
- A design or deck must fit a new format, such as a one-pager or a single slide.

## Steps

1. Read the source in full and list its sections, claims and tone.
2. Ask for the target audience and format only when neither is clear.
3. Keep every claim that survives the new format; cut the rest instead of compressing it.
4. Match the original voice unless the user asks for a different one.
5. Return the adapted piece, then a short list of what was removed.

## Output

- The adapted piece in the requested format.
- \`Removed:\` followed by the dropped sections, one per line.

## References

- \`references/tone-presets.md\` for audience presets.
- \`examples/before-after.md\` for paired examples.
`;

const TOOL_NAMES = [
  ['bash', 'Run a shell command in the agent workspace with a bounded timeout.'],
  ['read_file', 'Read a text file from the workspace.'],
  ['write_file', 'Create or replace a file in the workspace.'],
  ['edit_file', 'Replace an exact span of text in a file.'],
  ['list_dir', 'List the entries of a workspace folder.'],
  ['search_files', 'Search file contents with a regular expression.'],
  ['apply_patch', 'Apply a unified diff to the workspace.'],
  ['web_fetch', 'Fetch a URL and return readable text.'],
  ['web_search', 'Search the web and return ranked results.'],
  ['search_sessions', 'Search the owner’s sessions by text and date.'],
  ['read_session', 'Read messages from one session.'],
  ['search_memory', 'Search saved memories by topic and category.'],
  ['send_message', 'Send a message into a chat the agent belongs to.'],
  ['create_document', 'Create a shared document in a chat.'],
  ['calendar', 'Read and create calendar events on the Mac.'],
  ['reminders', 'Read and create reminders on the Mac.'],
  ['local_app', 'Read the frontmost app window on the owner’s Mac.'],
  ['browser', 'Open and read pages in the owner’s browser.'],
  ['screenshot', 'Capture the current screen for the agent.'],
  ['image_view', 'Open an image file for the model to inspect.'],
];
const TOOLS = TOOL_NAMES.map(([name, desc], i) => ({ name, desc, source: 'Built in', usedBy: i < 16 ? [AGENT] : [] }));
const PLUGINS = [];

const AGENTS = [{ id: 'system', name: AGENT, role: 'Default agent', status: 'Ready' }];
const BUILDS = [
  { id: 'b1', name: 'Weekly digest agent', kind: 'Agent', state: 'Private draft' },
  { id: 'b2', name: 'release-notes', kind: 'Skill', state: 'Published' },
  { id: 'b3', name: 'calendar-sync', kind: 'Tool', state: 'Needs testing' },
];

const community = (name, owner, installs, desc, scan, files) => ({ name, owner, installs, desc, scan, files });
const COMMUNITY = {
  clawhub: [
    community('figma-to-code', 'pixel-forge', 21500, 'Turn a Figma frame link into React components that follow the project’s existing tokens.', 'clean', ['SKILL.md', 'references/tokens.md']),
    community('remotion-video', 'studio-labs', 18200, 'Build programmatic videos with Remotion compositions, props and render settings.', 'clean', ['SKILL.md', 'templates/composition.md']),
    community('playwright-e2e', 'qa-guild', 14100, 'Write and stabilize Playwright end-to-end tests with role-based locators.', 'clean', ['SKILL.md']),
    community('meeting-notes', 'notetakers', 11000, 'Turn a transcript into decisions, owners and follow-ups.', 'clean', ['SKILL.md']),
    community('notion-sync', 'workspace-tools', 9800, 'Mirror selected Notion pages into Markdown and push edits back.', 'Sends page content to api.notion.com and stores a token in the skill folder.', ['SKILL.md', 'scripts/sync.py']),
    community('supabase-migrations', 'db-crew', 7700, 'Write, review and apply Supabase SQL migrations safely.', 'Runs shell commands in the project folder.', ['SKILL.md', 'scripts/apply.sh']),
    community('linear-triage', 'ops-kit', 6300, 'Triage new Linear issues by area, priority and duplicate risk.', 'clean', ['SKILL.md']),
    community('brand-voice', 'writers-room', 4900, 'Apply a written brand voice guide to copy, with before and after examples.', 'clean', ['SKILL.md', 'references/voice-guide.md']),
    community('arxiv-digest', 'paper-trail', 3200, 'Summarize new arXiv papers in chosen categories into a short daily digest with links.', 'clean', ['SKILL.md', 'scripts/fetch.py']),
    community('stripe-billing-docs', 'fin-docs', 2800, 'Answer billing questions from Stripe documentation with citations.', 'clean', ['SKILL.md']),
  ],
  'skills-sh': [
    community('frontend-design', 'skills-sh', 32400, 'Build distinctive, production-grade interfaces that avoid generic layouts.', 'clean', ['SKILL.md']),
    community('mcp-builder', 'skills-sh', 12900, 'Design and implement MCP servers with clear tool schemas.', 'clean', ['SKILL.md', 'references/schema.md']),
    community('webapp-testing', 'skills-sh', 8100, 'Test local web apps with a headless browser and screenshots.', 'clean', ['SKILL.md']),
    community('canvas-design', 'skills-sh', 6600, 'Create posters and visual art as PNG or PDF from a short brief.', 'clean', ['SKILL.md']),
    community('api-docs', 'skills-sh', 5200, 'Write reference docs for an HTTP API from its routes and types.', 'clean', ['SKILL.md']),
    community('changelog-writer', 'skills-sh', 3900, 'Write a changelog entry from commits since the last tag.', 'clean', ['SKILL.md']),
  ],
};
const PROVIDER_LABEL = { clawhub: 'ClawHub', 'skills-sh': 'skills.sh' };

// ---- State -----------------------------------------------------------------

const params = new URLSearchParams(location.search);
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const state = {
  variant: ['a', 'b', 'c'].includes(params.get('v')) ? params.get('v') : 'a',
  theme: ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : (systemDark ? 'dark' : 'light'),
  section: 'library',
  scope: 'mine',
  kind: 'skill',
  provider: 'clawhub',
  sel: { skill: 'adapt', tool: 'bash', plugin: null },
  csel: { clawhub: 'figma-to-code', 'skills-sh': 'frontend-design' },
  build: null,
  q: {},
  file: {},
  docMode: 'rendered',
  tab: 'overview',
  menu: null,
  collapsed: { skill: false, tool: true, plugin: true },
};

const app = document.getElementById('app');
const isCommunity = () => state.section === 'library' && state.scope === 'community';
const libraryCount = () => SKILLS.length + TOOLS.length + PLUGINS.length;
const itemsOf = (kind) => (kind === 'skill' ? SKILLS : kind === 'tool' ? TOOLS : PLUGINS);
const kindLabel = (kind) => ({ skill: 'Skills', tool: 'Tools', plugin: 'Plugins' })[kind];
const kindIcon = (kind) => ({ skill: 'puzzle', tool: 'wrench', plugin: 'blocks' })[kind];
const installedSkill = (name) => SKILLS.find((s) => s.name === name);

function queryKey() {
  if (state.section !== 'library') return state.section;
  if (isCommunity()) return `community:${state.provider}`;
  return state.variant === 'b' ? 'library:all' : `library:${state.kind}`;
}
const currentQuery = () => (state.q[queryKey()] ?? '').trim().toLowerCase();
const matches = (q, ...fields) => !q || fields.some((f) => String(f).toLowerCase().includes(q));

function placeholder() {
  if (state.section === 'build') return 'Search builds';
  if (state.section === 'agents') return 'Search agents';
  if (isCommunity()) return `Search ${PROVIDER_LABEL[state.provider]}`;
  if (state.variant === 'b') return 'Search library';
  return `Search ${kindLabel(state.kind).toLowerCase()}`;
}

// ---- Markdown --------------------------------------------------------------

function inline(text) {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMd(source) {
  let body = source;
  let html = '';
  const fm = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = source.slice(fm[0].length);
    html += '<dl class="fm">' + fm[1].split('\n').map((line) => {
      const i = line.indexOf(':');
      return `<dt>${esc(line.slice(0, i))}</dt><dd>${inline(line.slice(i + 1).trim())}</dd>`;
    }).join('') + '</dl>';
  }
  const lines = body.split('\n');
  let list = null;
  let para = [];
  let code = null;
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`; list = null; } };
  for (const line of lines) {
    if (code !== null) {
      if (line.startsWith('```')) { html += `<pre>${esc(code.join('\n'))}</pre>`; code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) { flushPara(); flushList(); code = []; continue; }
    const h = line.match(/^(#{1,3}) (.*)$/);
    const ul = line.match(/^- (.*)$/);
    const ol = line.match(/^\d+\. (.*)$/);
    if (h) { flushPara(); flushList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; }
    else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return html;
}

const titleCase = (name) => name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function skillMd(item) {
  if (item.name === 'adapt') return ADAPT_MD;
  return `---
name: ${item.name}
description: ${item.desc}
---

# ${titleCase(item.name)}

${item.desc}

## When to use

- The request matches the description above.
- The user names \`${item.name}\` directly.

## Steps

1. Read the request and any attached files.
2. Confirm the target format and constraints only when they are unclear.
3. Produce the output and check it against the request before replying.
`;
}

function fileText(item, path) {
  if (path === 'SKILL.md') return skillMd(item);
  if (path === 'definition.json') {
    return JSON.stringify({ name: item.name, description: item.desc, input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }, null, 2);
  }
  if (path.endsWith('.py')) return `"""${path} for ${item.name}."""\n\nimport sys\n\n\ndef main(argv: list[str]) -> int:\n    print("${item.name}", argv[1:])\n    return 0\n\n\nif __name__ == "__main__":\n    raise SystemExit(main(sys.argv))\n`;
  if (path.endsWith('.sh')) return `#!/usr/bin/env bash\nset -euo pipefail\n\n# ${path} for ${item.name}\necho "applying"\n`;
  return `# ${titleCase(path.split('/').pop().replace(/\.md$/, ''))}\n\nReference material for \`${item.name}\`.\n\n- Keep examples short.\n- Prefer one example per case.\n`;
}

// ---- Item models -----------------------------------------------------------

function switchControl(name, on) {
  return `<label class="sw-wrap">Enabled<button type="button" class="sw" role="switch" aria-checked="${on}" aria-label="Enabled" data-act="toggle" data-id="${esc(name)}"></button></label>`;
}

function moreMenu(kind) {
  const open = state.menu === 'more';
  return `<button type="button" class="icon-btn ${open ? 'is-open' : ''}" data-act="menu" data-id="more" aria-label="More" aria-expanded="${open}">${icon('more')}</button>
    ${open ? `<div class="pop">
      ${kind === 'skill' ? `<button type="button">${icon('folder', 'sm')}Show in Finder</button><button type="button">${icon('copy', 'sm')}Copy path</button><hr><button type="button" class="danger">${icon('trash', 'sm')}Remove</button>` : `<button type="button">${icon('copy', 'sm')}Copy identifier</button>`}
    </div>` : ''}`;
}

function skillModel(s) {
  return {
    key: `skill:${s.name}`, kind: 'skill', icon: 'puzzle', name: s.name,
    meta: ['Skill', s.source, s.version ? `v${s.version}` : 'Unversioned'].join(' · '),
    about: s.desc,
    details: [['Used by', s.usedBy.join(', ') || 'Not used by an agent'], ['Source', s.source], ['Version', s.version || 'Unversioned'], ['Files', String(s.files.length)]],
    files: s.files, item: s,
    actions: `${switchControl(s.name, s.enabled)}<span class="vsep"></span><button type="button" class="btn">${icon('pencil', 'sm')}Edit in Build</button>${moreMenu('skill')}`,
  };
}

function toolModel(t) {
  return {
    key: `tool:${t.name}`, kind: 'tool', icon: 'wrench', name: t.name,
    meta: `Tool · ${t.source}`,
    about: t.desc,
    details: [['Used by', t.usedBy.join(', ') || 'Not used by an agent'], ['Source', t.source], ['Identifier', `<code>${esc(t.name)}</code>`]],
    files: ['definition.json'], item: t,
    actions: `<button type="button" class="btn">${icon('pencil', 'sm')}Edit in Build</button>${moreMenu('tool')}`,
  };
}

function communityModel(c) {
  const mine = installedSkill(c.name);
  const clean = c.scan === 'clean';
  const label = PROVIDER_LABEL[state.provider];
  return {
    key: `community:${state.provider}:${c.name}`, kind: 'skill', icon: 'globe', name: c.name,
    meta: `${label} · ${c.owner} · ${fmt(c.installs)} installs`,
    about: c.desc,
    notice: clean ? '' : `<div class="notice">${icon('shieldAlert', 'sm')}<span>${esc(c.scan)}</span></div>`,
    details: [['Publisher', c.owner], ['Installs', fmt(c.installs)], ['Scan', clean ? `${icon('shield', 'xs ok')}Clean` : 'Review'], ['Files', String(c.files.length)]],
    files: c.files, item: c,
    actions: mine
      ? `<button type="button" class="icon-btn" aria-label="Open on ${label}">${icon('external')}</button><span class="pill ok">${icon('check', 'xs')}Installed</span>${switchControl(mine.name, mine.enabled)}`
      : `<button type="button" class="icon-btn" aria-label="Open on ${label}">${icon('external')}</button><button type="button" class="btn primary" data-act="install" data-id="${esc(c.name)}">${icon('download', 'sm')}Install</button>`,
  };
}

// ---- Sidebar ---------------------------------------------------------------

function seg(items, cls = '') {
  return `<div class="seg ${cls}" role="tablist">${items.map((it) => `<button type="button" role="tab" aria-selected="${it.active}" class="${it.active ? 'is-active' : ''}" data-act="${it.act}" data-id="${it.id}">${it.label}${it.count !== undefined ? `<span>${it.count}</span>` : ''}</button>`).join('')}</div>`;
}

function navSeg(withCommunity) {
  const lib = state.section === 'library' && (!withCommunity || state.scope === 'mine');
  const items = [
    { act: 'section', id: 'build', label: 'Build', active: state.section === 'build' },
    { act: 'section', id: 'agents', label: 'Agents', count: withCommunity ? undefined : AGENTS.length, active: state.section === 'agents' },
    { act: withCommunity ? 'scopeTop' : 'section', id: withCommunity ? 'mine' : 'library', label: 'Library', count: withCommunity ? undefined : libraryCount(), active: lib },
  ];
  if (withCommunity) items.push({ act: 'scopeTop', id: 'community', label: 'Community', active: isCommunity() });
  return seg(items, withCommunity ? 'fit' : '');
}

function createMenu() {
  const open = state.menu === 'create';
  return `<button type="button" class="icon-btn ${open ? 'is-open' : ''}" data-act="menu" data-id="create" aria-label="New" aria-expanded="${open}">${icon('plus')}</button>
    ${open ? `<div class="pop">
      <button type="button">${icon('bot', 'sm')}New agent</button>
      <button type="button">${icon('puzzle', 'sm')}New skill</button>
      <button type="button">${icon('wrench', 'sm')}New tool</button>
      <button type="button">${icon('blocks', 'sm')}New plugin</button>
    </div>` : ''}`;
}

function searchField(trailing = '') {
  return `<label class="search">${icon('search', 'sm')}<input type="search" data-search value="${esc(state.q[queryKey()] ?? '')}" placeholder="${placeholder()}" aria-label="${placeholder()}">${trailing}</label>`;
}

function filterMenuButton() {
  const open = state.menu === 'filter';
  const label = isCommunity() ? PROVIDER_LABEL[state.provider] : kindLabel(state.kind);
  const check = (on) => (on ? icon('check', 'xs chk') : '<span class="chk"></span>');
  return `<span style="position:relative"><button type="button" class="search-menu ${open ? 'is-open' : ''}" data-act="menu" data-id="filter" aria-expanded="${open}">${label}${icon('down', 'xs')}</button>
    ${open ? `<div class="pop" style="min-width:210px">
      <div class="pop-label">My library</div>
      ${['skill', 'tool', 'plugin'].map((k) => `<button type="button" data-act="filter" data-scope="mine" data-id="${k}">${icon(kindIcon(k), 'sm')}${kindLabel(k)}<span class="count">${itemsOf(k).length}</span>${check(!isCommunity() && state.kind === k)}</button>`).join('')}
      <hr>
      <div class="pop-label">Community</div>
      ${Object.keys(PROVIDER_LABEL).map((p) => `<button type="button" data-act="filter" data-scope="community" data-id="${p}">${icon('globe', 'sm')}${PROVIDER_LABEL[p]}<span class="count"></span>${check(isCommunity() && state.provider === p)}</button>`).join('')}
    </div>` : ''}</span>`;
}

function providerMenuButton() {
  const open = state.menu === 'provider';
  return `<span style="position:relative"><button type="button" class="search-menu ${open ? 'is-open' : ''}" data-act="menu" data-id="provider" aria-expanded="${open}">${PROVIDER_LABEL[state.provider]}${icon('down', 'xs')}</button>
    ${open ? `<div class="pop" style="min-width:170px">${Object.keys(PROVIDER_LABEL).map((p) => `<button type="button" data-act="provider" data-id="${p}">${icon('globe', 'sm')}${PROVIDER_LABEL[p]}${p === state.provider ? icon('check', 'xs chk') : '<span class="chk"></span>'}</button>`).join('')}</div>` : ''}</span>`;
}

function sideHead() {
  const title = `<div class="side-title"><h2>Factory</h2>${createMenu()}</div>`;
  if (state.variant === 'a') {
    let rows = navSeg(false);
    if (state.section === 'library') {
      rows += `<div class="scope" role="tablist" aria-label="Library scope">
        <button type="button" role="tab" class="${!isCommunity() ? 'is-active' : ''}" data-act="scope" data-id="mine">My library<span>${libraryCount()}</span></button>
        <button type="button" role="tab" class="${isCommunity() ? 'is-active' : ''}" data-act="scope" data-id="community">Community</button>
      </div>`;
      rows += isCommunity()
        ? `<div class="chips">${Object.keys(PROVIDER_LABEL).map((p) => `<button type="button" class="${state.provider === p ? 'is-active' : ''}" data-act="provider" data-id="${p}">${PROVIDER_LABEL[p]}</button>`).join('')}</div>`
        : `<div class="chips">${['skill', 'tool', 'plugin'].map((k) => `<button type="button" class="${state.kind === k ? 'is-active' : ''}" data-act="kind" data-id="${k}">${kindLabel(k)}<span>${itemsOf(k).length}</span></button>`).join('')}</div>`;
    }
    return title + rows + searchField();
  }
  if (state.variant === 'b') {
    return title + navSeg(true) + searchField(isCommunity() ? providerMenuButton() : '');
  }
  return title + navSeg(false) + searchField(state.section === 'library' ? filterMenuButton() : '');
}

function libraryRow(kind, item) {
  const active = state.section === 'library' && !isCommunity() && state.kind === kind && state.sel[kind] === item.name;
  const off = kind === 'skill' && !item.enabled;
  return `<button type="button" class="row ${active ? 'is-active' : ''} ${off ? 'is-off' : ''}" data-act="pick" data-kind="${kind}" data-id="${esc(item.name)}"><span class="row-name">${esc(item.name)}</span>${off ? '<span class="row-state">Disabled</span>' : ''}</button>`;
}

function renderList() {
  const q = currentQuery();
  if (state.section === 'build') {
    const rows = BUILDS.filter((b) => matches(q, b.name, b.kind, b.state));
    return rows.map((b) => `<button type="button" class="row ${state.build === b.id ? 'is-active' : ''}" data-act="build" data-id="${b.id}"><span class="row-name">${esc(b.name)}</span><span class="row-state">${b.kind}</span></button>`).join('') || '<div class="list-empty">No builds match</div>';
  }
  if (state.section === 'agents') {
    const rows = AGENTS.filter((a) => matches(q, a.name, a.role));
    return rows.map((a) => `<button type="button" class="row agent is-active"><span class="avatar">S</span><span class="row-text" style="display:flex;flex-direction:column;min-width:0"><span class="row-name">${esc(a.name)}</span><span class="row-sub">${a.role} · ${SKILLS.filter((s) => s.usedBy.includes(a.name)).length + TOOLS.filter((t) => t.usedBy.includes(a.name)).length} capabilities</span></span><span class="row-state">${a.status}</span></button>`).join('') || '<div class="list-empty">No agents match</div>';
  }
  if (isCommunity()) {
    const rows = COMMUNITY[state.provider].filter((c) => matches(q, c.name, c.desc, c.owner));
    const label = q ? '' : '<div class="list-label">Popular</div>';
    return label + (rows.map((c) => {
      const active = state.csel[state.provider] === c.name;
      return `<button type="button" class="row two ${active ? 'is-active' : ''}" data-act="cpick" data-id="${esc(c.name)}"><span class="row-text"><span class="row-name">${esc(c.name)}</span><span class="row-sub">${esc(c.owner)} · ${fmt(c.installs)} installs</span></span>${installedSkill(c.name) ? icon('check', 'xs ok') : ''}</button>`;
    }).join('') || '<div class="list-empty">No matching skills</div>');
  }
  if (state.variant === 'b') {
    return ['skill', 'tool', 'plugin'].map((kind) => {
      const rows = itemsOf(kind).filter((it) => matches(q, it.name, it.desc));
      const collapsed = state.collapsed[kind] && !q;
      return `<button type="button" class="group ${collapsed ? 'is-collapsed' : ''}" data-act="collapse" data-id="${kind}">${icon('down', 'xs')}${kindLabel(kind)} <span>${q ? rows.length : itemsOf(kind).length}</span></button>`
        + (collapsed ? '' : rows.map((it) => libraryRow(kind, it)).join(''));
    }).join('');
  }
  const items = itemsOf(state.kind);
  if (!items.length) return `<div class="list-empty">No ${kindLabel(state.kind).toLowerCase()}<button type="button" class="btn outline">${icon('plus', 'sm')}New ${state.kind}</button></div>`;
  const rows = items.filter((it) => matches(q, it.name, it.desc));
  return rows.map((it) => libraryRow(state.kind, it)).join('') || `<div class="list-empty">No ${kindLabel(state.kind).toLowerCase()} match</div>`;
}

// ---- Main ------------------------------------------------------------------

function header(model) {
  return `<header class="d-head"><span class="mark">${icon(model.icon)}</span><div class="d-title"><h2>${esc(model.name)}</h2><p>${esc(model.meta)}</p></div><div class="d-actions">${model.actions}</div></header>`;
}

function currentFile(model) {
  const path = state.file[model.key];
  return model.files.includes(path) ? path : model.files[0];
}

function docToggle(path) {
  if (!path.endsWith('.md')) return '';
  return `<div class="seg sm" role="tablist" aria-label="View">${['rendered', 'source'].map((m) => `<button type="button" class="${state.docMode === m ? 'is-active' : ''}" data-act="docmode" data-id="${m}">${m === 'rendered' ? 'Rendered' : 'Source'}</button>`).join('')}</div>`;
}

function docView(model, path) {
  const text = fileText(model.item, path);
  if (path.endsWith('.md') && state.docMode === 'rendered') return `<article class="md">${renderMd(text)}</article>`;
  return `<pre class="src">${esc(text)}</pre>`;
}

function docPanel(model) {
  const path = currentFile(model);
  const tabs = model.files.map((f) => `<button type="button" class="${f === path ? 'is-active' : ''}" data-act="file" data-key="${esc(model.key)}" data-id="${esc(f)}">${icon('file', 'xs')}${esc(f)}</button>`).join('');
  return `<div class="doc-bar"><nav class="files" aria-label="Files">${tabs}</nav>${docToggle(path)}</div><div class="doc-view">${docView(model, path)}</div>`;
}

function dl(details) {
  return `<dl class="dl">${details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v.includes('<') ? v : esc(v)}</dd></div>`).join('')}</dl>`;
}

function bodyA(model) {
  return `<div class="a-body">
    <aside class="a-over scroll">
      <section><h3>About</h3><p class="about">${esc(model.about)}</p>${model.notice ?? ''}</section>
      <section><h3>Details</h3>${dl(model.details)}</section>
    </aside>
    <section class="a-doc">${docPanel(model)}</section>
  </div>`;
}

function bodyB(model) {
  return `<div class="b-body scroll"><div class="b-col">
    <p class="about">${esc(model.about)}</p>${model.notice ?? ''}
    <dl class="b-meta">${model.details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v.includes('<') ? v : esc(v)}</dd></div>`).join('')}</dl>
    <div class="b-doc">${docPanel(model)}</div>
  </div></div>`;
}

function bodyC(model) {
  const tab = state.tab === 'overview' || model.files.includes(state.tab) ? state.tab : 'overview';
  const tabs = [['overview', 'Overview'], ...model.files.map((f) => [f, f])];
  const bar = `<nav class="c-tabs" aria-label="Sections">${tabs.map(([id, label]) => `<button type="button" class="${tab === id ? 'is-active' : ''}" data-act="tab" data-id="${esc(id)}">${esc(label)}</button>`).join('')}${tab !== 'overview' ? `<span class="c-tool">${docToggle(tab)}</span>` : ''}</nav>`;
  const content = tab === 'overview'
    ? `<div class="scroll" style="flex:1;min-height:0"><div class="c-over"><section><h3>About</h3><p class="about">${esc(model.about)}</p>${model.notice ?? ''}</section><section><h3>Details</h3>${dl(model.details)}</section></div></div>`
    : `<div class="doc-view">${docView(model, tab)}</div>`;
  return bar + `<div class="c-body">${content}</div>`;
}

function renderMain() {
  if (state.section === 'build') {
    const build = BUILDS.find((b) => b.id === state.build);
    if (!build) return `<div class="empty">${icon('hammer')}<strong>No build selected</strong></div>`;
    return `<header class="d-head"><span class="mark">${icon('hammer')}</span><div class="d-title"><h2>${esc(build.name)}</h2><p>${build.kind} · ${build.state}</p></div><div class="d-actions"><button type="button" class="btn primary">Open build</button></div></header><div class="empty">${icon('hammer')}<strong>Build conversation</strong></div>`;
  }
  if (state.section === 'agents') {
    const a = AGENTS[0];
    const model = {
      about: 'Answers in your chats and runs background work on this Mac.',
      details: [['Skills', String(SKILLS.filter((s) => s.usedBy.includes(a.name)).length)], ['Tools', String(TOOLS.filter((t) => t.usedBy.includes(a.name)).length)], ['Plugins', '0'], ['Status', a.status]],
    };
    return `<header class="d-head"><span class="avatar lg">S</span><div class="d-title"><h2>${a.name}</h2><p>${a.role} · ${a.status}</p></div><div class="d-actions"><button type="button" class="btn">${icon('pencil', 'sm')}Edit in Build</button></div></header>
      <div class="b-body scroll"><div class="b-col"><p class="about">${model.about}</p><dl class="b-meta">${model.details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div></div>`;
  }
  let model = null;
  if (isCommunity()) {
    const c = COMMUNITY[state.provider].find((x) => x.name === state.csel[state.provider]) ?? COMMUNITY[state.provider][0];
    model = communityModel(c);
  } else {
    const list = itemsOf(state.kind);
    const item = list.find((x) => x.name === state.sel[state.kind]) ?? list[0];
    if (!item) return `<div class="empty">${icon(kindIcon(state.kind))}<strong>No ${kindLabel(state.kind).toLowerCase()}</strong><button type="button" class="btn outline">${icon('plus', 'sm')}New ${state.kind}</button></div>`;
    model = state.kind === 'skill' ? skillModel(item) : toolModel(item);
  }
  const body = state.variant === 'a' ? bodyA(model) : state.variant === 'b' ? bodyB(model) : bodyC(model);
  return header(model) + body;
}

// ---- Render ----------------------------------------------------------------

function render() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelectorAll('[data-variant]').forEach((b) => b.classList.toggle('is-active', b.dataset.variant === state.variant));
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('is-active', b.dataset.themeSet === state.theme));
  const nav = [['users', 'Contacts'], ['chat', 'Chats'], ['agentChat', 'Agent Chats'], ['bot', 'Factory'], ['notebook', 'Digest']]
    .map(([ic, label]) => `<button type="button" class="${label === 'Factory' ? 'is-active' : ''}" aria-label="${label}" title="${label}">${icon(ic)}</button>`).join('');
  app.innerHTML = `<nav class="nav" aria-label="Pages">${nav}</nav>
    <aside class="side"><header class="side-head">${sideHead()}</header><div class="list" id="list">${renderList()}</div></aside>
    <main class="main">${renderMain()}</main>`;
  const url = new URL(location.href);
  url.searchParams.set('v', state.variant);
  url.searchParams.set('theme', state.theme);
  history.replaceState(null, '', url);
}

// ---- Events ----------------------------------------------------------------

document.addEventListener('click', (event) => {
  const variant = event.target.closest('[data-variant]');
  if (variant) { state.variant = variant.dataset.variant; state.menu = null; render(); return; }
  const theme = event.target.closest('[data-theme-set]');
  if (theme) { state.theme = theme.dataset.themeSet; render(); return; }

  const el = event.target.closest('[data-act]');
  const insidePop = event.target.closest('.pop');
  if (!el) { if (state.menu && !insidePop) { state.menu = null; render(); } return; }
  const { act, id } = el.dataset;
  if (act !== 'menu' && !insidePop) state.menu = null;

  switch (act) {
    case 'menu': state.menu = state.menu === id ? null : id; break;
    case 'section': state.section = id; if (id === 'library') state.scope = state.scope ?? 'mine'; break;
    case 'scopeTop': state.section = 'library'; state.scope = id; break;
    case 'scope': state.scope = id; break;
    case 'kind': state.kind = id; break;
    case 'provider': state.provider = id; state.menu = null; break;
    case 'filter':
      state.scope = el.dataset.scope;
      if (el.dataset.scope === 'mine') state.kind = id; else state.provider = id;
      state.menu = null;
      break;
    case 'pick': state.kind = el.dataset.kind; state.sel[state.kind] = id; state.tab = 'overview'; break;
    case 'cpick': state.csel[state.provider] = id; state.tab = 'overview'; break;
    case 'build': state.build = id; break;
    case 'collapse': state.collapsed[id] = !state.collapsed[id]; break;
    case 'file': state.file[el.dataset.key] = id; break;
    case 'docmode': state.docMode = id; break;
    case 'tab': state.tab = id; break;
    case 'toggle': { const s = installedSkill(id); if (s) s.enabled = !s.enabled; break; }
    case 'install': {
      const c = COMMUNITY[state.provider].find((x) => x.name === id);
      if (c && !installedSkill(c.name)) {
        SKILLS.push(skill(c.name, c.desc, PROVIDER_LABEL[state.provider], '1.0.0', false, [], c.files));
        SKILLS.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    default: break;
  }
  render();
});

document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-search]')) return;
  state.q[queryKey()] = event.target.value;
  document.getElementById('list').innerHTML = renderList();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.menu) { state.menu = null; render(); }
});

render();
