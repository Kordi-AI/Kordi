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
