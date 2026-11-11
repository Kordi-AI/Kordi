import './previewChatTheme';
import { createRoot } from 'react-dom/client';
import { __setSessionBackendForTests } from '../../src/features/cloud/session';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { DesktopChatToolSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// A reply that started a background session, the stopped notice and a second
// reply about the same session, at the full transcript width and at the width
// left when the chat panel is open. Offline sample data only.
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
__setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (command === 'desktop_chat_session_active_turn') return null;
    throw Error('Unexpected fixture command');
  },
};

const sessionTitle = 'Prepare Kordi stress testing guide';
const sessionTool = (status: string): DesktopChatToolSnapshot => ({
  id: `task-${status}`, name: 'task_operator', status: 'complete', arguments: '', liveOutput: '', isError: false,
  resultText: `Started.\nBackground session: ${JSON.stringify({ sessionId: 'stress-guide', title: sessionTitle, status })}`,
});
const reply = (id: string, seconds: number, text: string, status: string, time: string): Message => ({
  id, role: 'owned-agent', senderType: 'agent', sender: 'Atlas', text: '', time,
  turn: {
    id, sessionId: 'sample', prompt: '', status: 'done', message: '', assistantText: text, thinkingText: '',
    tools: [sessionTool(status)], completed: true, succeeded: true, startedAtMs: 0, completedAtMs: seconds * 1000,
  },
});
const messages: Message[] = [
  reply('first-reply', 54, 'I started a background session to prepare the stress testing guide and will report back here.', 'running', '12:57'),
  { id: 'stopped-notice', role: 'system', text: `Background session "${sessionTitle}" was stopped.`, time: '12:58' },
  reply('second-reply', 24, 'The stress testing guide session was stopped before it finished.', 'stopped', '12:58'),
];
const statuses = new Map([['stress-guide', 'stopped' as const]]);

function Transcript({ width, label }: { width: number; label: string }) {
  return <section data-fixture-width={label} style={{ width, padding: '12px 16px', borderRight: '1px solid var(--app-divider)' }}>
    {messages.map(message => <div key={message.id} data-fixture-message={message.id}>
      <MessageBubble msg={message} relatedAgentSessionStatusById={statuses} onOpenForkSession={() => {}} />
    </div>)}
  </section>;
}

createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'flex', alignItems: 'flex-start', minHeight: '100vh', background: 'var(--app-main-bg, var(--utility-background))', color: 'var(--utility-foreground)' }}>
    <Transcript width={880} label="wide" />
    <Transcript width={420} label="narrow" />
  </main>,
);
