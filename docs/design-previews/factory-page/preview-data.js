// Factory page design preview: icons, helpers and synthetic sample data. No network calls.

export const ICONS = {
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

export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// ---- Sample data -----------------------------------------------------------

export const AGENT = 'System agent';
export const skill = (name, desc, source, version, enabled, usedBy, files, when) => ({ name, desc, source, version, enabled, usedBy, files, when });

export const SKILLS = [
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

export const ADAPT_MD = `---
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
export const TOOLS = TOOL_NAMES.map(([name, desc], i) => ({ name, desc, source: 'Built in', usedBy: i < 16 ? [AGENT] : [] }));
export const PLUGINS = [];

export const AGENTS = [{ id: 'system', name: AGENT, role: 'Default agent', status: 'Ready' }];
export const BUILDS = [
  { id: 'b1', name: 'Weekly digest agent', kind: 'Agent', state: 'Private draft' },
  { id: 'b2', name: 'release-notes', kind: 'Skill', state: 'Published' },
  { id: 'b3', name: 'calendar-sync', kind: 'Tool', state: 'Needs testing' },
];

const community = (name, owner, installs, desc, scan, files) => ({ name, owner, installs, desc, scan, files });
export const COMMUNITY = {
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
export const PROVIDER_LABEL = { clawhub: 'ClawHub', 'skills-sh': 'skills.sh' };
