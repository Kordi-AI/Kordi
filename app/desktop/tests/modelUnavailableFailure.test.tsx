import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudAgentLocalFailureMessage } from '../src/features/cloud/cloudAgentLocalExecution';
import {
  cloudAgentFailureCodeForError,
  cloudAgentProviderFailureActionLabel,
  cloudAgentSharedFailure,
} from '../src/features/cloud/cloudAgentFailureNotices';
import { cloudAgentFallbackErrorNotice } from '../src/features/cloud/cloudAgentMessages';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const NOTICE = "This model isn't available with your AI provider account. Choose another model.";
// The OMP runtime's fixed wording for `provider_model_unavailable`, then the provider's own reason.
const MAC_ERROR = "The selected model is unavailable for this account. Choose another model. Provider response: "
  + "Codex error event: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. (code=model_not_found)";
const OWNER = 'human:acct_owner';
const MEMBER = 'human:acct_member';
const agentIdentity = {
  id: 'agent:cloud-agent:acct_owner',
  kind: 'agent',
  displayName: 'Pebble',
  ownerIdentityId: OWNER,
} as CanonicalIdentity;
const identities = new Map([[agentIdentity.id, agentIdentity]]);

function failedReply(content: Record<string, unknown>, sourceTransport: string): CanonicalSessionMessage {
  return {
    id: 'msg:cloud-agent:reply-1',
    sessionId: 'session:group:g1',
    senderIdentityId: agentIdentity.id,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: { sender: 'Pebble', deliveryState: 'failed', requestId: 'msg:request-1', replyToMessageId: 'msg:request-1', ...content },
    parentMessageId: 'msg:request-1',
    status: 'failed',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport,
    sourceEventId: `${sourceTransport}:reply-1`,
  } as unknown as CanonicalSessionMessage;
}

function render(message: CanonicalSessionMessage, viewer: string) {
  const mapped = mapCanonicalMessage(message, identities, viewer);
  assert.ok(mapped?.turn);
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn: mapped.turn,
    historical: true,
    showReasoning: true,
    onOpenAuthSettings: mapped.role === 'owned-agent' ? () => undefined : undefined,
  }));
  return { mapped, markup };
}

test('a model the provider refuses on this Mac is shared as model_unavailable', () => {
  assert.equal(cloudAgentFailureCodeForError(new Error(MAC_ERROR)), 'model_unavailable');
  assert.deepEqual(cloudAgentSharedFailure(MAC_ERROR, 'Pebble'), { text: "Pebble couldn't reply.", failureCode: 'model_unavailable' });
  assert.equal(cloudAgentLocalFailureMessage(new Error(MAC_ERROR)), NOTICE);
  // Reconnecting does not help, so the line offers no Authentication link.
  assert.equal(cloudAgentProviderFailureActionLabel(MAC_ERROR), null);
  assert.equal(cloudAgentFallbackErrorNotice({ code: 'model_unavailable' }), NOTICE);
  assert.doesNotMatch(NOTICE, /sign in|try again/i);
});

test('only the owner reads that the model is unavailable', () => {
  for (const [content, transport] of [
    // A Mac run keeps only the neutral line and the code.
    [{ error: "Pebble couldn't reply.", failureCode: 'model_unavailable' }, 'cloud-group-agent'],
    // A Cloud run stores the server's owner line.
    [{ error: NOTICE, failureCode: 'model_unavailable' }, 'cloud-agent-runtime'],
  ] as const) {
    const owner = render(failedReply(content, transport), OWNER);
    assert.equal(owner.mapped.turn?.error, NOTICE, transport);
    assert.match(owner.markup, /Choose another model\./, transport);
    assert.doesNotMatch(owner.markup, /Sign in|Try again|app-error-line-action/i, transport);

    const member = render(failedReply(content, transport), MEMBER);
    assert.equal(member.mapped.turn?.error, "Pebble couldn't reply.", transport);
    assert.doesNotMatch(member.markup, /model|account|provider/i, transport);
  }
});
