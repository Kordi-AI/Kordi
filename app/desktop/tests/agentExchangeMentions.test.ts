import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudAgentResponseMentions } from '../src/features/cloud/cloudDirectMessages';
import { parseMessageInlineParts } from '../src/kordi-app/components/messageLinks';

// The server addresses an exchange question with the agent's friendly name
// and one mention by id whose range covers the whole name.
test("an agent's question highlights the whole friendly name, apostrophe and space included", () => {
  const text = "@Robin's Kordi Alex Kim would like to know which day works.";
  const display = "@Robin's Kordi";
  const body = `kordi-cloud-agent-response:${Buffer.from(JSON.stringify({
    kind: 'agent-response', requestId: 'agent-exchange:x:sent', text, deliveryState: 'complete',
    mentions: [{ label: 'RobinsKordiRobin', targetKind: 'agent', targetIdentityId: 'agent:cloud-agent:acct_robin', agentId: 'cloud-agent:acct_robin',
      humanId: 'acct_robin', displayText: display, displayLabel: "Robin's Kordi", startUtf16: 0, lengthUtf16: display.length }],
  })).toString('base64url')}`;
  const mentions = cloudAgentResponseMentions(body);
  assert.equal(mentions?.length, 1);
  const parts = parseMessageInlineParts(text, mentions);
  const mention = parts.find((part) => part.type === 'mention') as { label: string; targetKind: string } | undefined;
  assert.equal(mention?.label, display);
  assert.equal(mention?.targetKind, 'agent');
  assert.equal(parts.filter((part) => part.type === 'mention').length, 1, 'no second highlight');
  assert.equal(cloudAgentResponseMentions('kordi-cloud-agent-response:not-json'), undefined);
});

test("a direct chat shows the whole friendly agent name as one mention on the asking agent's request", async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { conversation, host } = await import('./helpers/collaborationTranscriptFixtures');
  const { mapCollaborationConversationToViewModel } = await import('../src/features/collaboration/transcript');
  const { cloudMessageToCollaborationMessage } = await import('../src/features/cloud/cloudCollaborationState');
  const { MessageBubble } = await import('../src/kordi-app/components/transcript');
  const display = "@Robin's Kordi";
  const text = `${display} Alex would like to know which day works.`;
  const body = `kordi-cloud-agent-response:${Buffer.from(JSON.stringify({
    kind: 'agent-response', requestId: 'agent-exchange:e:sent', text, deliveryState: 'complete',
    mentions: [{ label: 'RobinsKordiRobin', targetKind: 'agent', targetIdentityId: 'agent:cloud-agent:acct_robin', agentId: 'cloud-agent:acct_robin',
      humanId: 'acct_robin', displayText: display, displayLabel: "Robin's Kordi", startUtf16: 0, lengthUtf16: display.length }],
  })).toString('base64url')}`;
  const account = { accountId: 'acct_alex', displayName: 'Alex' } as never;
  const message = { messageId: 'm1', fromAccountId: 'acct_alex', toAccountId: 'acct_robin', body, createdAt: '2026-11-10T10:00:00Z', sessionId: 'session:direct-person:acct_alex:acct_robin' } as never;
  const mapped = cloudMessageToCollaborationMessage(account, message);
  assert.equal(mapped.mentions?.[0]?.displayText, display);
  const view = mapCollaborationConversationToViewModel(conversation({ messages: [mapped] }), host(), 'My Kordi');
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: view.messages[0]!, onOpenSenderProfile: () => {} }));
  const highlighted = [...markup.matchAll(/class="[^"]*mention[^"]*"[^>]*>([^<]*)</g)].map((match) => match[1].replace(/&#x27;|&#39;/g, "'"));
  assert.ok(highlighted.includes(display), `whole name highlighted: ${JSON.stringify(highlighted)}`);
});
