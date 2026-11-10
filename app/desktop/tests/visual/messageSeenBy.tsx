import './previewChatTheme';
import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSeenByProvider } from '../../src/features/chat/MessageSeenByProvider';
import type { MessageReadersPage, MessageSeenBySource } from '../../src/features/chat/messageSeenBy';
import { MessageContextMenuContent } from '../../src/kordi-app/components/messageContextMenuContent';
import type { ConversationParticipant, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Synthetic people and group only; readers come from local promises, never the network.
// The message menu on your own group message in every Seen by state. ?theme=light|dark
const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

const PEOPLE = ['Maya Patel', 'Omar Haddad', 'Hana Sato', 'Alex Kim', 'Priya Nair', 'Lena Fischer', 'Diego Alvarez', 'Sofia Rossi'];
const accountId = (name: string) => `preview-${name.split(' ')[0]!.toLowerCase()}`;
const participants: ConversationParticipant[] = PEOPLE.map((name) => ({
  id: `human:${accountId(name)}`, name, kind: 'human', role: 'person', avatarKey: `preview-${name}`,
}));
const largeGroup: ConversationParticipant[] = Array.from({ length: 140 }, (_, index) => ({
  id: `human:preview-member-${index}`, name: `Member ${index}`, kind: 'human', role: 'person',
}));
const today = new Date();
const at = (hour: number, minute: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute).toISOString();
const READERS: MessageReadersPage = {
  total: 8,
  readers: [[10, 41], [10, 41], [10, 43], [10, 44], [10, 46], [10, 52], [11, 5], [11, 20]].map(([hour, minute], index) => ({
    accountId: accountId(PEOPLE[index]!), readAt: index === 7 ? null : at(hour!, minute!),
  })),
};
const ownMessage = {
  id: 'preview-own', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
  text: 'I moved the demo to Thursday at 3 so design can join.', time: '10:40', statusChips: ['read'],
  reactionConversationId: 'preview-conversation', reactionTargetMessageId: 'preview-message', cloudMessageVersion: 1,
} as Message;
const noop = () => {};

const pages: Record<string, MessageSeenBySource['fetchReaders'] | null> = {
  loading: () => new Promise(() => undefined),
  none: async () => ({ total: 0, readers: [] }),
  one: async () => ({ total: 1, readers: READERS.readers.slice(0, 1) }),
  several: async (_target, limit) => ({ total: READERS.total, readers: READERS.readers.slice(0, limit) }),
};

function Slot({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return <section data-seen-state={name} style={{ display: 'grid', alignContent: 'start', gap: 6 }}>
    <h3 style={{ margin: 0, fontSize: 11, fontWeight: 500, opacity: 0.55 }}>{label}</h3>
    {children}
  </section>;
}

function Menu({ fetchReaders, people = participants, msg = ownMessage, openList = false }: {
  fetchReaders: MessageSeenBySource['fetchReaders']; people?: ConversationParticipant[]; msg?: Message; openList?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openList) return;
    const timer = window.setInterval(() => {
      const row = ref.current?.querySelector<HTMLButtonElement>('button[data-message-context-menu-seen-row]');
      if (row) { row.click(); window.clearInterval(timer); }
    }, 20);
    return () => window.clearInterval(timer);
  }, [openList]);
  return <div ref={ref} className="app-message-context-menu">
    <MessageSeenByProvider isGroup participants={people} fetchReaders={fetchReaders}>
      <MessageContextMenuContent msg={msg} onClose={noop} onReplyMessage={noop} onOpenMessageThread={noop} onForwardMessage={noop}
        onEditMessage={noop} onDeleteMessage={noop} onSelectMessage={noop} onRequestPinMessage={noop} onReactMessage={noop} />
    </MessageSeenByProvider>
  </div>;
}

createRoot(document.getElementById('root')!).render(
  <main className={`kordi-app theme-${theme} app-cloud-workspace-surface`}
    style={{ minHeight: '100dvh', padding: 24, display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'start', background: 'var(--app-page-bg)', color: 'var(--utility-foreground)', fontSize: 13 }}>
    <Slot name="loading" label="Loading"><Menu fetchReaders={pages.loading!} /></Slot>
    <Slot name="none" label="Not seen yet"><Menu fetchReaders={pages.none!} msg={{ ...ownMessage, statusChips: ['sent'] }} /></Slot>
    <Slot name="one" label="One reader"><Menu fetchReaders={pages.one!} /></Slot>
    <Slot name="several" label="Several readers"><Menu fetchReaders={pages.several!} /></Slot>
    <Slot name="list" label="Full list"><Menu fetchReaders={pages.several!} openList /></Slot>
    <Slot name="large-group" label="Group of 140: no row"><Menu fetchReaders={pages.several!} people={largeGroup} /></Slot>
    <Slot name="incoming" label="Incoming: no row">
      <Menu fetchReaders={pages.several!} msg={{ ...ownMessage, id: 'preview-incoming', role: 'person', isOwnMessage: false, sender: 'Maya Patel' }} />
    </Slot>
  </main>,
);
