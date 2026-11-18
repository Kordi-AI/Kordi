import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudAgentSharedFailure, cloudAgentViewerFailureText } from '../src/features/cloud/cloudAgentFailureNotices';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudGroupMessageRuntimeFields } from '../src/features/cloud/cloudGroupDecoding';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const OWNER = 'human:acct_owner';
const MEMBER = 'human:acct_member';
const ownerIdentity = { id: OWNER, kind: 'human', displayName: 'Bea Okafor' } as CanonicalIdentity;
const agentIdentity = {
  id: 'agent:cloud-agent:acct_owner',
  kind: 'agent',
  displayName: 'Pebble',
  ownerIdentityId: OWNER,
} as CanonicalIdentity;
const identities = new Map([[agentIdentity.id, agentIdentity], [ownerIdentity.id, ownerIdentity]]);

const MODEL_NOTICE = "This model isn't available with your AI provider account. Choose another model.";
const MEMBER_LINES = {
  missing_provider_auth: "Bea hasn't connected a model yet.",
  provider_auth_rejected: 'Bea needs to reconnect their model.',
  hosted_credentials_unavailable: 'Bea needs to reconnect their model.',
  provider_sign_in_failed: 'Bea needs to reconnect their model.',
  model_unavailable: 'Bea needs to choose another model.',
  model_provider_error: "The model service didn't respond. Try again.",
  provider_call_failed: "The model service didn't respond. Try again.",
} as const;
const GENERIC_CODES = ['sandbox_error', 'failed', 'made_up_code', 'agent_unreachable', 'agent_not_available'];
// A raw provider error a stored row might hold; none of it may reach a member.
const RAW_PROVIDER_ERROR = 'Provider response: 401 Unauthorized from https://api.example.test/v1/responses '
  + 'for model lumen-9-sol on account acct_7f3a91 (snapshot snap_44c2e0)';
const RAW_PROVIDER_PARTS = ['https://api.example.test', 'lumen-9-sol', 'acct_7f3a91', 'snap_44c2e0', 'Unauthorized'];

function failedReply(content: Record<string, unknown>): CanonicalSessionMessage {
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
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:reply-1',
  } as unknown as CanonicalSessionMessage;
}

/** The member's bubble, offered the provider settings link as the transcript would offer it. */
function render(message: CanonicalSessionMessage, viewer: string, identityMap = identities) {
  const mapped = mapCanonicalMessage(message, identityMap, viewer);
  assert.ok(mapped?.turn);
  const bubble = renderToStaticMarkup(createElement(MessageBubble, { msg: mapped, onOpenAuthSettings: () => undefined }));
  const card = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn: mapped.turn, historical: true, showReasoning: true, onOpenAuthSettings: () => undefined,
  }));
  return { mapped, markup: `${bubble}\n${card}` };
}

function escaped(text: string) {
  return text.replace(/'/g, '&#x27;');
}

test('a member reads the short reason for each known code, with no provider link', () => {
  for (const [failureCode, line] of Object.entries(MEMBER_LINES)) {
    const { mapped, markup } = render(failedReply({ error: "Pebble couldn't reply.", failureCode }), MEMBER);
    assert.equal(mapped.role, 'external-agent', failureCode);
    assert.equal(mapped.turn?.error, line, failureCode);
    assert.ok(markup.includes(escaped(line)), failureCode);
    assert.doesNotMatch(markup, /app-error-line-action|>Reconnect<|>Connect</, failureCode);
  }
});

test('a member reads the neutral line for any other code, no code, or an older free-text error', () => {
  for (const failureCode of [...GENERIC_CODES, undefined]) {
    const { mapped } = render(failedReply({ error: "Pebble couldn't reply.", failureCode }), MEMBER);
    assert.equal(mapped.turn?.error, "Pebble couldn't reply.", String(failureCode));
  }
  for (const error of [
    'Sign in again to use this account.',
    'No provider configured yet.',
    'Reconnect your account to run your agent.',
    'This model is not available for the selected account.',
    'The provider sign-in needs attention. Reconnect this account in Authentication and try again.',
  ]) {
    assert.equal(render(failedReply({ error }), MEMBER).mapped.turn?.error, "Pebble couldn't reply.", error);
  }
});

test('the unreachable and refused lines render as before for the owner and members', () => {
  for (const [error, failureCode] of [["Couldn't reach Pebble.", 'agent_unreachable'], ["Pebble isn't available.", 'agent_not_available']]) {
    const content = { error, failureCode };
    assert.equal(render(failedReply(content), OWNER).mapped.turn?.error, error);
    assert.equal(render(failedReply(content), MEMBER).mapped.turn?.error, "Pebble couldn't reply.");
  }
});

test('the stored text never reaches a member, whatever the code', () => {
  for (const failureCode of [...Object.keys(MEMBER_LINES), ...GENERIC_CODES, undefined]) {
    const { mapped, markup } = render(failedReply({ error: RAW_PROVIDER_ERROR, failureCode }), MEMBER);
    // Avatar images and icons carry their own URLs; the text a member reads must not.
    const visible = `${mapped.turn?.error}\n${markup.replace(/\s(?:href|src|srcset|xmlns)="[^"]*"/g, '')}`;
    for (const part of [...RAW_PROVIDER_PARTS, 'http']) {
      assert.ok(!visible.includes(part), `${failureCode}: ${part}`);
    }
    assert.doesNotMatch(visible, /provider/i, String(failureCode));
  }
});

test('the owner is named by first name, or as the owner when the name is unknown', () => {
  const missing = render(failedReply({ error: "Pebble couldn't reply.", failureCode: 'missing_provider_auth' }), MEMBER,
    new Map([[agentIdentity.id, agentIdentity]]));
  assert.equal(missing.mapped.turn?.error, "The owner hasn't connected a model yet.");
  // Without the owner's identity, the name the owner's Mac stored is used.
  const stored = render(failedReply({ error: "Pebble couldn't reply.", failureCode: 'model_unavailable', senderOwnerName: 'Cy Mendes' }), MEMBER,
    new Map([[agentIdentity.id, agentIdentity]]));
  assert.equal(stored.mapped.turn?.error, 'Cy needs to choose another model.');
  const member = (ownerName: string | null | undefined, agentName: string | null = 'Pebble', failureCode = 'provider_auth_rejected') =>
    cloudAgentViewerFailureText({ error: RAW_PROVIDER_ERROR, failureCode, viewerOwnsAgent: false, agentName, ownerName });
  assert.equal(member('  Bea   Okafor '), 'Bea needs to reconnect their model.');
  for (const unknown of [undefined, null, '', '   ', 'You', 'you']) {
    assert.equal(member(unknown), 'The owner needs to reconnect their model.', String(unknown));
  }
  assert.equal(member('Bea', null, 'failed'), "The agent couldn't reply.");
  assert.equal(member('Bea', '  ', 'sandbox_error'), "The agent couldn't reply.");
});

test("the owner's line for every code is unchanged", () => {
  const detailed = 'The provider sign-in needs attention. Reconnect this account in Authentication and try again. '
    + 'Provider response: 401 Unauthorized: invalid token for https://api.example.test';
  const busy = 'The provider is busy or rate-limited. Try again shortly. Provider response: You have hit your usage limit (plus plan).';
  for (const [content, line] of [
    [{ error: "Pebble couldn't reply.", failureCode: 'provider_auth_rejected' }, 'Your AI provider connection expired.'],
    [{ error: "Pebble couldn't reply.", failureCode: 'hosted_credentials_unavailable' }, 'Your AI provider connection is unavailable.'],
    [{ error: "Pebble couldn't reply.", failureCode: 'missing_provider_auth' }, 'No provider configured yet.'],
    [{ error: "Pebble couldn't reply.", failureCode: 'model_unavailable' }, MODEL_NOTICE],
    [{ error: "Pebble couldn't reply.", failureCode: 'model_provider_error' }, 'The provider failed while Kordi was replying. Try again in a moment.'],
    [{ error: "Pebble couldn't reply.", failureCode: 'sandbox_error' }, "Kordi Cloud couldn't finish this reply in the sandbox. Try again."],
    [{ error: detailed, failureCode: 'failed' }, detailed],
    // The two Mac provider codes keep the detailed line this Mac stored, as `failed` did.
    [{ error: detailed, failureCode: 'provider_sign_in_failed' }, detailed],
    [{ error: busy, failureCode: 'provider_call_failed' }, busy],
    [{ error: "Pebble couldn't reply.", failureCode: 'provider_call_failed' }, "Pebble couldn't reply."],
    [{ error: 'Sign in again to use this account.' }, 'Sign in again to use this account.'],
  ] as const) {
    const { mapped, markup } = render(failedReply(content), OWNER);
    assert.equal(mapped.role, 'owned-agent');
    assert.equal(mapped.turn?.error, line, JSON.stringify(content));
    if (line === detailed || line === busy) assert.ok(markup.includes(escaped(line)), JSON.stringify(content));
  }
});

// The OMP runtime's fixed provider wording, from `worker_message` in shared/rust/omp-runtime/src/error.rs.
const RUNTIME_SENTENCES = [
  ['The provider sign-in needs attention. Reconnect this account in Authentication and try again.', 'provider_sign_in_failed'],
  ['The provider is temporarily unavailable. Try again shortly.', 'provider_call_failed'],
  ['The provider is busy or rate-limited. Try again shortly.', 'provider_call_failed'],
  ['A secure connection to the provider could not be established. Check your network and try again.', 'provider_call_failed'],
  ['Could not connect to the provider. Check your network and try again.', 'provider_call_failed'],
  ['The provider could not complete this request. Try again.', 'provider_call_failed'],
  ['The provider rejected this request. Check the selected model and settings, then try again.', 'provider_call_failed'],
  ['This account cannot use the selected model. Check its access or choose another model.', 'provider_call_failed'],
  ['The provider rejected a tool definition. Update Kordi or try another model.', 'provider_call_failed'],
  ['The selected model does not support a request setting. Adjust the model settings and try again.', 'provider_call_failed'],
  ['The selected model is unavailable for this account. Choose another model.', 'model_unavailable'],
  ['The agent could not complete this request. Try again.', 'failed'],
  ['The agent reached its run limit before finishing. Try again.', 'failed'],
  ['The agent timed out. Try again.', 'failed'],
] as const;

test('a failed turn on this Mac shares the code its runtime wording names, and only the neutral line', () => {
  const runtimeSource = readFileSync(new URL('../../../shared/rust/omp-runtime/src/error.rs', import.meta.url), 'utf8');
  for (const [sentence, failureCode] of RUNTIME_SENTENCES) {
    assert.ok(runtimeSource.includes(`"${sentence}"`), `the runtime still words it: ${sentence}`);
    for (const error of [sentence, `${sentence} Provider response: 401 https://x.test model-9`, new Error(sentence)]) {
      assert.deepEqual(cloudAgentSharedFailure(error, 'Pebble'), { text: "Pebble couldn't reply.", failureCode }, String(error));
    }
  }
});

test("provider words inside the provider's own text never choose the code", () => {
  for (const error of [
    'The agent could not complete this request. Try again. Provider response: The provider sign-in needs attention. '
      + 'Reconnect this account in Authentication and try again.',
    'The agent timed out. Try again. Provider response: The provider is busy or rate-limited. Try again shortly. 401 403 429',
    'Upstream said: The provider sign-in needs attention. Reconnect this account in Authentication and try again.',
    'Cloud agent returned no text response',
  ]) {
    assert.deepEqual(cloudAgentSharedFailure(error, 'Pebble'), { text: "Pebble couldn't reply.", failureCode: 'failed' }, error);
  }
});

test('the two Mac codes reach other members on the wire', () => {
  for (const failureCode of ['provider_sign_in_failed', 'provider_call_failed'] as const) {
    const parsed = parseCloudAgentResponse(encodeCloudAgentResponse({ requestId: 'msg:request-1', text: "Pebble couldn't reply.", deliveryState: 'failed', failureCode }));
    assert.equal(parsed?.failureCode, failureCode);
    assert.equal(cloudGroupMessageRuntimeFields({ deliveryState: 'failed', failureCode }).failureCode, failureCode);
  }
});

const owner: CloudAccount = {
  accountId: 'owner', displayName: 'Bea Okafor', primaryEmail: 'owner@example.test', avatarUrl: null, avatar,
  nodeId: 'owner', passwordSet: true,
  defaultAgent: { agentId: 'cloud-agent:owner', displayName: 'Pebble', avatarUrl: null, avatar },
};
const peer: CloudAccount = {
  ...owner, accountId: 'peer', displayName: 'Peer Person', primaryEmail: 'peer@example.test', nodeId: 'peer',
  defaultAgent: { agentId: 'cloud-agent:peer', displayName: 'Peer Helper', avatarUrl: null, avatar },
};

function wire(id: string, from: CloudAccount, sequence: number, body: string, createdAtMs: number): CloudMessage {
  return {
    messageId: id, fromAccountId: from.accountId, toAccountId: from === owner ? peer.accountId : owner.accountId,
    createdAt: new Date(createdAtMs).toISOString(), deliveredAt: null, readAt: null,
    direction: from === peer ? 'outgoing' : 'incoming', sessionId: 'session:direct-person:owner:peer',
    conversationId: 'conversation', conversationSequence: sequence, version: 2, body,
  };
}

test('a direct chat member reads the same short reason through the collaboration transcript', () => {
  const base = Date.now() - 60_000;
  const request = wire('request-1', peer, 1, encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: '@Pebble hi',
    targetCloudAgentId: 'cloud-agent:owner', targetCloudAgentName: 'Pebble',
    targetCloudAgentOwnerAccountId: owner.accountId, targetCloudAgentOwnerName: owner.displayName,
  }), base);
  for (const [failureCode, line] of [...Object.entries(MEMBER_LINES), ['sandbox_error', "Pebble couldn't reply."]]) {
    const reply = wire('reply-1', owner, 2, encodeCloudAgentResponse({
      requestId: 'request-1', ...cloudAgentSharedFailure(RAW_PROVIDER_ERROR, 'Pebble'),
      failureCode: failureCode as never, deliveryState: 'failed',
    }), base + 1_000);
    const projected = buildCloudCollaborationConversation({
      account: peer,
      contact: cloudContactToContact({ ...owner, createdAt: new Date().toISOString() }),
      messages: [request, reply], runtime: 'person',
    });
    const view = mapCollaborationConversationToViewModel(projected, undefined, 'Pebble');
    const failed = view.messages.find((message) => message.turn?.status === 'failed');
    assert.equal(failed?.turn?.error, line, failureCode);
  }
});
