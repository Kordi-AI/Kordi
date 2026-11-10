import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installCopySurfaceSelectionTracking } from '../../src/features/contentSelection';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { FoldableAssistantAnswer } from '../../src/kordi-app/components/transcriptAssistantAnswer';
import { SourceMessageQuoteRow } from '../../src/kordi-app/components/transcriptReplyAttribution';
import type { Message } from '../../src/kordi-app/types';

const reply = [
  'Here is a first plan. Alex is busy Friday 19:00–21:00, so the times below work around that.',
  '**Friday hike plan (draft)**',
  [
    '- **10:00** Meet and leave, with the drive kept under one hour.',
    '- **11:00–13:30** Hike 4–6 miles with no more than 800 feet of climbing, and rest at the viewpoints along the way.',
    '- **13:30–14:30** Picnic on the hill or at the trailhead.',
    '- **15:00** Start heading down.',
  ].join('\n'),
  '**Still missing**',
  [
    '1. Which area do you want to hike in?',
    '2. Is Sam free on Friday during the day?',
    '3. An easy walk, or a harder climb?',
  ].join('\n'),
  '> Tell someone your route and when you expect to be back.',
  [
    '| Trail | Distance | Climb |',
    '| --- | --- | --- |',
    '| Ridge loop | 4.2 miles | 620 feet |',
    '| Creek trail | 5.8 miles | 310 feet |',
  ].join('\n'),
  ['```ts', 'const miles = 4.2;', 'const climbFeet = 620;', '```'].join('\n'),
  'Once you reply with the area and the effort level, I will pick two or three trails with distance, climb and drive time.',
].join('\n\n');

const messages: Message[] = [
  {
    id: 'selection-blocks-peer', role: 'person', sender: 'Sam', senderType: 'human', time: '09:12', showSenderMeta: true,
    text: 'Short first line.\n\nA second paragraph that is long enough to wrap onto another line in a narrow column, so a selection covers lines of different lengths.\n\nLast line.',
  },
  {
    id: 'selection-blocks-agent', role: 'agent', sender: 'Assistant', time: '09:13',
    text: reply,
  },
];

function TextSelectionBlocks() {
  const [dark, setDark] = useState(false);
  useEffect(() => installCopySurfaceSelectionTracking(document), []);
  useEffect(() => {
    document.body.className = dark ? 'theme-dark' : 'theme-light';
  }, [dark]);
  return (
    <main className={`kordi-app theme-${dark ? 'dark' : 'light'} flex min-h-dvh flex-col bg-[var(--utility-background)] text-[var(--utility-foreground)]`}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-current/10 px-6 py-3">
        <h1 className="text-[15px] font-semibold">Text selection across blocks</h1>
        <button className="app-button-quiet rounded-lg border border-current/20 px-3 py-1.5 text-[13px]" onClick={() => setDark(value => !value)}>
          {dark ? 'Light appearance' : 'Dark appearance'}
        </button>
      </header>
      <section className="app-chat-theme-surface flex-1 px-7 py-6" aria-label="Sample conversation">
        <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
          <div data-selection-sample="reply" className="app-thread-turn">
            <div className="app-live-turn-card w-full max-w-[min(100%,58rem)] pb-1.5">
              <div className="app-live-turn-response-panel app-ordered-turn-surface w-full max-w-[min(100%,58rem)] space-y-2.5">
                <FoldableAssistantAnswer text={reply} />
              </div>
              <SourceMessageQuoteRow sourceMessage={{ messageId: 'selection-blocks-request', senderLabel: 'Alex', text: 'Plan a Friday hike for us.' }} side="agent" className="mt-1" />
            </div>
          </div>
          {messages.map(message => (
            <div key={message.id} data-selection-sample={message.role}><MessageBubble msg={message} /></div>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<TextSelectionBlocks />);
