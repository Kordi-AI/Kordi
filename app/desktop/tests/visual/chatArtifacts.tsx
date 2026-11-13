// Login-free synthetic preview of a chat's Artifacts tab beside its Memory tab:
// the real destination tabs, detail page, Artifacts panel, and memory list.
// `?tab=memory` opens the Memory tab, `?empty=1` previews a chat without
// artifacts or memories, and `?layout=list` or `?layout=cards` saves that
// layout first (otherwise the saved choice applies, cards by default). It makes no network calls and needs no session.
import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DocumentReaderHostContext, type DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import { publishMemoryVersion } from '../../src/features/memory/memoryAvailability';
import { PREVIEW_CONVERSATION_MEMORY_SCOPE_ID, createPreviewMemoryClient } from '../../src/features/memory/memoryClient';
import type { DocumentResponse } from '../../src/features/documents/documentShareTypes';
import type { Conversation, SessionArtifact } from '../../src/kordi-app/types';
import { ARTIFACT_LAYOUT_STORAGE_KEY } from '../../src/pages/artifactLayoutPreference';
import { setArtifactDocumentApiForPreview } from '../../src/pages/artifactDocumentApi';
import { isNativeDesktopShell } from '../../src/lib/desktop';
import { ChatDetailPanel } from '../../src/pages/ChatDetailPanel';
import { ChatMemoryTab } from '../../src/pages/ChatMemoryTab';
import { RightDetailRail } from '../../src/pages/RightDetailRail';
import { SessionDestinationTabs } from '../../src/pages/chatsPage.destinations';
import { CHAT_DETAIL_TABS } from '../../src/pages/chatsPage.destinationModel';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const empty = params.has('empty');
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';

document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const requestedLayout = params.get('layout');
if (requestedLayout === 'list' || requestedLayout === 'cards') {
  try {
    window.localStorage.setItem(ARTIFACT_LAYOUT_STORAGE_KEY, requestedLayout);
  } catch {
    // The saved choice, or cards, applies.
  }
}

// Cloud copies of the synthetic documents, so the cards draw thumbnails without a server.
const CLOUD_MARKDOWN: Record<string, { title: string; blocks: string[] }> = {
  att_brief: { title: 'Launch brief', blocks: ['# Launch brief', '## Goal', 'Introduce shared documents to existing teams in one week, with a short demo and a pricing update.', '## Audience', '- Team leads who already use group chats\n- Writers who draft with the agent', '## Timeline', 'Draft on Monday, review on Wednesday, publish on Friday.'] },
  att_faq: { title: 'FAQ', blocks: ['# FAQ', '## Who can read a shared document?', 'Everyone in the chat, plus anyone with a share link you create.', '## Can the agent edit it?', 'Yes. Ask in a comment and it edits the paragraph you selected.', '## Does it work on the phone?', 'Reading and comments work on iPhone; editing comes later.'] },
  att_email: { title: 'Announcement email', blocks: ['**Subject:** Shared documents are here', 'Hi team,', 'Starting today, anything the agent writes in a chat lands in Artifacts, where everyone can read, comment, and edit.', 'Reply to this email with questions.', 'Taylor'] },
  att_notes: { title: 'Interview notes', blocks: ['# Interview notes', 'Five teams asked for one place to keep what the agent writes.', '> “We lose drafts in the chat scroll.”', 'Most read on a laptop; two read on the phone.'] },
};
const PRICING_PAGE = `<!doctype html><html><body style="margin:0;font-family:system-ui;color:#1d1d1f">
<header style="display:flex;justify-content:space-between;padding:18px 40px;border-bottom:1px solid #eee"><b>Kordi</b><span>Pricing</span></header>
<section style="padding:56px 40px;background:linear-gradient(135deg,#f6d6bd,#f2a66d)"><h1 style="margin:0;font-size:44px">Plans for every team</h1><p style="font-size:20px">Start free, upgrade when the group grows.</p></section>
<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:32px 40px">${['Free', 'Team', 'Business'].map((plan) => `<div style="border:1px solid #e5e5e5;border-radius:14px;padding:22px"><h3 style="margin:0 0 8px">${plan}</h3><p style="color:#666">Shared documents and agents.</p></div>`).join('')}</section>
</body></html>`;
const SIGNUP_PAGE = `<!doctype html><html><body style="margin:0;font-family:system-ui;background:#f4f6fb;color:#1d1d1f;display:grid;place-items:center;height:100vh">
<form style="width:380px;background:#fff;border-radius:16px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.08)"><h2 style="margin:0 0 18px">Create your team</h2>
${['Team name', 'Work email'].map((label) => `<label style="display:block;margin-bottom:14px;font-size:14px">${label}<div style="margin-top:6px;height:38px;border:1px solid #ddd;border-radius:8px"></div></label>`).join('')}
<div style="height:40px;border-radius:8px;background:#2d6cdf"></div></form></body></html>`;
setArtifactDocumentApiForPreview({
  getDocument: async (attachmentId) => {
    const document = CLOUD_MARKDOWN[attachmentId];
    if (!document) throw new Error('Not in the preview');
    return { attachmentId, title: document.title, blocks: document.blocks.map((source, index) => ({ id: `b${index}`, source, html: '' })) } as unknown as DocumentResponse;
  },
  getDocumentRaw: async (attachmentId) => (attachmentId === 'att_signup' ? SIGNUP_PAGE : PRICING_PAGE),
});

// The preview stands in for a server that reports memory routes.
publishMemoryVersion(1);

const sampleAvatar = (initials: string, color: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="${color}"/><text x="48" y="60" text-anchor="middle" font-family="system-ui" font-size="32" fill="#fff">${initials}</text></svg>`);

const memoryClient = createPreviewMemoryClient();
if (empty) memoryClient.listLessons = async () => [];

const conversation: Conversation = {
  id: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  canonicalSessionId: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  name: 'Launch copy with Priya',
  type: 'person',
  subtitle: '',
  unread: 0,
  collaborationSources: ['Cloud'],
  trust: 'Cloud',
  directness: 'Direct chat',
  participants: ['Me', 'Priya Nair'],
  messages: [],
  canonicalParticipants: [
    { id: 'acct_taylor', name: 'Me', publicName: 'Taylor Reed', kind: 'human', role: 'owner', profileImageUrl: sampleAvatar('TR', '#53776b') },
    { id: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'member', profileImageUrl: sampleAvatar('PN', '#98705b') },
  ],
} as Conversation;

const artifacts: SessionArtifact[] = empty ? [] : [
  { id: 'launch-brief', path: 'notes/launch-brief.md', name: 'launch-brief.md', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: '10:24', createdByAccountId: 'acct_priya', attachmentId: 'att_brief', live: true },
  { id: 'pricing-page', path: 'site/pricing.html', name: 'pricing.html', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: '09:58', attachmentId: 'att_pricing' },
  { id: 'interview-notes', path: 'notes/interviews.md', name: 'interviews.md', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: 'Yesterday', createdByAccountId: 'acct_taylor', attachmentId: 'att_notes' },
  { id: 'faq', path: 'notes/faq.md', name: 'faq.md', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: 'Yesterday', createdByAccountId: 'acct_priya', attachmentId: 'att_faq' },
  { id: 'email-draft', path: 'notes/announcement-email.md', name: 'announcement-email.md', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: 'Mon', attachmentId: 'att_email' },
  { id: 'signup-page', path: 'site/signup.html', name: 'signup.html', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: 'Mon', createdByAccountId: 'acct_taylor', attachmentId: 'att_signup' },
  { id: 'headline-test', path: 'src/headlines.ts', name: 'headlines.ts', kind: 'code', category: 'related', summary: 'Modified', timeLabel: '09:41' },
  { id: 'pricing-data', path: 'data/pricing.csv', name: 'pricing.csv', kind: 'file', category: 'related', summary: 'Created', timeLabel: '09:30' },
];

// A chat that can take an attachment, so the Artifacts tab offers New document and Add file.
const readerHost: DocumentReaderHost = {
  viewer: null,
  sessionId: conversation.id,
  agentName: null,
  people: [],
  addDocument: () => undefined,
  opensDocumentsInCompanion: true,
};

function Preview() {
  const [tab, setTab] = useState<'info' | 'artifacts' | 'tasks' | 'memory'>(params.get('tab') === 'memory' ? 'memory' : 'artifacts');
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  return (
    <div
      className={`kordi-app theme-${theme}`}
      style={{ height: '100vh', background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}
    >
      <div className="app-chat-main-workspace flex h-full min-h-0 min-w-0 overflow-hidden">
        <section className="app-chat-pane-layout min-h-0 min-w-0 flex-1 overflow-hidden" data-has-header="true">
          <div className="app-page-header app-chat-pane-header relative flex shrink-0 flex-col items-start gap-2" style={{ padding: '14px 20px 0' }}>
            <div className="text-[17px] font-semibold">{conversation.name}</div>
            <div style={{ position: 'relative', height: 34 }}>
              <SessionDestinationTabs
                scope="main"
                activeDestination={tab}
                onSelect={(destination) => setTab(destination === 'messages' ? 'artifacts' : destination)}
              />
            </div>
          </div>
          {/* The split workspace class supplies the page padding the app gives detail tabs. */}
          <div className="app-chat-split-workspace min-h-0 min-w-0 flex-1 overflow-hidden">
            <RightDetailRail
              variant="page"
              detailTabs={CHAT_DETAIL_TABS}
              activeDetailTab={tab}
              onSelectDetailTab={(next) => setTab(next === 'context' ? 'info' : next)}
              activeSourcePreview={null}
              onCloseSourcePreview={() => undefined}
            >
              {tab === 'memory' ? <ChatMemoryTab conversation={conversation} client={memoryClient} /> : null}
              {tab === 'artifacts' ? (
                <DocumentReaderHostContext.Provider value={readerHost}>
                  <ChatDetailPanel
                    // In the desktop preview window, the open arrows reach the real app.
                    isNativeShell={isNativeDesktopShell()}
                    activeDetailTab="artifacts"
                    activeConv={conversation}
                    activeConvHasSubtitle={false}
                    activeConversationUsesCollaboration
                    activeCollaborationAwaitingReply={false}
                    isCollaborationSyncing={false}
                    artifacts={artifacts}
                    activeArtifactId={activeArtifactId}
                    onSelectArtifact={setActiveArtifactId}
                  />
                </DocumentReaderHostContext.Provider>
              ) : null}
            </RightDetailRail>
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
