// Loopback-only case for the real web app. All data and agent replies are synthetic.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const port = Number(process.argv[2] ?? 61749);
const origin = `http://127.0.0.1:${port}`;
process.env.VITE_KORDI_EDITION = 'cloud';
process.env.VITE_KORDI_DEV_PROFILE = 'community';
process.env.VITE_KORDI_CLOUD_API_BASE = origin;

const caseStarted = Date.now() - 6 * 60_000;
const timestamp = new Date(caseStarted).toISOString();
const groupId = '6b66a724-dcc5-45d3-91a7-43d93a2d4480';
const sessionId = `session:group:${groupId}`;
const home = `/app/chats/${encodeURIComponent(sessionId)}`;
const owner = 'acct_preview_alex';
const peer = 'acct_preview_maya';
const agent = 'acct_kordi_pip';
const title = 'Import launch';
const member = (accountId, displayName, role) => ({
  account_id: accountId, display_name: displayName, role, membership_state: 'active', avatar_url: null,
  version: 1, joined_at: timestamp, last_delivered_sequence: 0, last_read_sequence: 0, left_at: null,
});
const members = [member(owner, 'Alex Rivera', 'owner'), member(peer, 'Maya Chen', 'member'), member(agent, 'Facilitator', 'member')];
const account = {
  accountId: owner, displayName: 'Alex Rivera', primaryEmail: 'alex@example.test', primaryEmailVerified: true,
  avatarUrl: null, avatar: { entityType: 'human', entityId: owner, source: 'generated', style: 'kordi-birds',
    seed: 'bird-robin-color-coral', rendererVersion: 'fixture-v1', uploadedAsset: null, version: 0, updatedAt: timestamp },
  nodeId: null, passwordSet: true, defaultAgent: null,
};
const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [], pinnedSessionIds: [],
  mutedSessionIds: [], pinnedGroupSpaceIds: [] };
const messages = [];
const cards = new Map();
const previewVotes = new Map();
const memories = [];
const events = [];
const syncEvents = [];
const settings = { memoryEnabled: true, excludeSensitive: true };
const conversation = () => ({
  id: groupId, kind: 'group', shared_title: title, group_title: title, group_space_id: null,
  version: 1, created_by_account_id: owner, legacy_session_id: sessionId,
  latest_message_sequence: messages.length, created_at: timestamp, updated_at: timestamp, members,
  preferences: { conversation_id: groupId, account_id: owner, personal_title: null, version: 1 },
});
function add(text, sender, block, input) {
  const row = {
    id: randomUUID(), client_message_id: input?.client_message_id ?? randomUUID(),
    conversation_id: groupId, conversation_sequence: messages.length + 1,
    sender_account_id: sender, kind: 'text', content: input?.content ?? {
      schema: 1, blocks: [{ type: 'text', text }, ...(block ? [block] : [])], legacy_attachments: [],
    },
    reply_to_message_id: input?.reply_to_message_id ?? null, attachment_ids: [], version: 1, generation_status: null,
    provider_response_id: null, created_at: input?.created_at ?? new Date(caseStarted + (messages.length + 1) * 45_000).toISOString(), edited_at: null, deleted_at: null,
  };
  messages.push(row);
  changed(row, 'message.created');
  return row;
}
function changed(row, type = 'message.updated') {
  syncEvents.push({ type, payload: { message: structuredClone(row) }, stream_seq: syncEvents.length + 1,
    event_id: randomUUID(), protocol_version: 2, critical: true, conversation_id: groupId,
    entity_id: row.id, entity_version: row.version, occurred_at: new Date().toISOString(),
  });
}
function cardChanged(block, key) {
  const row = messages.find(message => message.content.blocks.some(item => item[key] === block[key]));
  if (!row) return;
  row.version += 1;
  changed(row);
}
function groupBody(message) {
  const participants = members.map(row => ({
    accountId: row.account_id, displayName: row.display_name, role: row.role,
  }));
  const envelope = { kind: 'group-message', groupId: sessionId, groupTitle: title,
    createdByAccountId: owner, actor: participants.find(row => row.accountId === message.senderAccountId),
    participants, message,
  };
  return `kordi-cloud-group:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
}
function runAssignment(card) {
  const id = `facilitator-handoff:${card.cardId}`;
  const target = `cloud-agent:${owner}`;
  const displayLabel = `${account.displayName}'s Kordi`;
  const displayText = `@${displayLabel}`;
  const createdAtMs = Date.now();
  const created_at = new Date(createdAtMs).toISOString();
  const request = add(groupBody({
    id, senderAccountId: agent, senderKind: 'agent', createdAtMs,
    text: `${displayText} Please take this approved assignment: ${card.title.replace(/\.$/, '')}.`,
    targetCloudAgentId: target, targetCloudAgentName: 'Kordi', targetCloudAgentOwnerAccountId: owner,
    targetCloudAgentOwnerName: account.displayName,
    mentions: [{ label: 'KordiAlexRivera', targetKind: 'agent', targetIdentityId: `agent:${target}`, agentId: target,
      ownerAccountId: owner, sourceHostId: 'cloud', displayLabel, displayText, startUtf16: 0, lengthUtf16: displayText.length }],
  }), agent, null, { created_at });
  const reply = { id: `proactive_run_${card.cardId}`, senderAccountId: owner, senderKind: 'agent',
    senderAgentId: target, senderOwnerAccountId: owner, senderOwnerName: account.displayName, senderDisplayName: 'Kordi',
    text: '', createdAtMs, deliveryState: 'queued', requestId: id, replyToMessageId: id };
  const slot = add(groupBody(reply), owner, null, { created_at, reply_to_message_id: request.id });
  function update(deliveryState, text) {
    slot.content.blocks[0].text = groupBody({ ...reply, deliveryState, text });
    slot.version += 1;
    changed(slot);
    card.result = deliveryState === 'complete' ? 'done' : 'running';
    card.revision += 1;
    cardChanged(card, 'cardId');
  }
  setTimeout(() => update('processing', ''), 900);
  setTimeout(() => update('complete', 'CSV checklist: verify required headers, field count, quoting, date format, and duplicate IDs. This is a scripted preview result.'), 10_000);
}
function newCard(kind, values) {
  const card = { type: 'facilitator_card', kind, cardId: randomUUID(), revision: 1, result: null,
    detail: null, options: [], counts: [], managerIds: [owner], ...values };
  cards.set(card.cardId, card);
  add(card.title, agent, card);
  return card;
}
const decision = () => newCard('decision', {
  title: 'Which import format should ship first?', options: ['CSV import', 'Spreadsheet import'], counts: [1, 0],
});
const memory = () => newCard('memory', {
  title: 'Review imports before publishing',
  detail: 'A second teammate reviews a sample import before it is published.',
});
const assignment = () => newCard('task', {
  title: 'Draft the CSV validation checklist',
  detail: 'List five checks for malformed CSV files and post the checklist in this group.',
  assigneeId: owner, assigneeName: 'Alex Rivera', result: 'pending',
});
const tomorrow = new Date(Date.now() + 86_400_000);
tomorrow.setUTCHours(16, 0, 0, 0);
const plan = {
  type: 'plan_card', eventId: 'preview-import-review', title: 'Review the import checklist', view: 'event',
  state: 'awaiting_confirmation', revision: 1, startAt: tomorrow.toISOString(),
  endAt: new Date(+tomorrow + 30 * 60_000).toISOString(), location: 'Team call', unresolvedFields: [],
  participants: [
    { participantId: owner, displayName: 'Alex Rivera', organizer: true, rsvp: 'yes' },
    { participantId: peer, displayName: 'Maya Chen', organizer: false, rsvp: 'pending' },
  ],
  options: [], managerIds: [owner],
};
add('Should we ship CSV import first or start with spreadsheets?', peer);
decision();
add('Remember this for the group: every sample import needs a second reviewer.', peer);
memory();
add('Assign the task to Alex: draft the CSV validation checklist.', peer);
assignment();
add('', agent, plan);

function planAction(input) {
  if (input.action === 'confirm' && input.revision === plan.revision && plan.state !== 'confirmed') {
    plan.state = 'confirmed';
    plan.revision += 1;
    cardChanged(plan, 'eventId');
    events.push({ eventId: plan.eventId, title: plan.title, startAt: plan.startAt, endAt: plan.endAt, location: plan.location });
  } else if (input.action === 'rsvp') {
    const participant = plan.participants.find(row => row.participantId === owner);
    participant.rsvp = input.rsvp;
    plan.revision += 1;
    cardChanged(plan, 'eventId');
  } else if (input.action === 'cancel' && input.revision === plan.revision) {
    plan.state = 'canceled';
    plan.revision += 1;
    cardChanged(plan, 'eventId');
  }
  return plan;
}

function respond(path, url, method, input) {
  switch (path) {
    case '/v1/cloud/auth/web/session':
      return { account, csrfToken: 'fixture-csrf', session: { organizationId: 'preview-org', deviceId: 'preview-device', expiresAt: '2099-01-01T00:00:00Z' } };
    case '/v1/cloud/auth/me': return account;
    case '/v1/cloud/auth/capabilities': return { password: true, oauthProviders: ['google', 'github'], memoryVersion: 3 };
    case '/v1/cloud/organizations': return { organizations: [{ organizationId: 'preview-org', name: 'Launch team', kind: 'personal', role: 'owner', memberCount: 1 }] };
    case '/v1/cloud/contacts': return { contacts: [{ accountId: peer, displayName: 'Maya Chen', avatarUrl: null, defaultAgent: null, createdAt: timestamp }], requests: [] };
    case '/v1/cloud/contacts/requests': return { requests: [] };
    case '/v1/cloud/personal-agents': return { sessions: [] };
    case '/v1/cloud/agent-subsessions': return { sessions: [], nextCursor: null };
    case '/v1/cloud/scheduled-tasks': return { tasks: [] };
    case '/v1/cloud/agents':
    case '/v1/cloud/agents/shared': return { agents: [] };
    case '/v1/cloud/agent-provider-auth/snapshots': return { snapshots: [] };
    case '/v1/cloud/account/ai-consent': return { status: 'allowed', aiConsentStatus: 'allowed' };
    case '/v1/cloud/account/joinable-organizations': return { organizations: [] };
    case '/v1/cloud/invitations/groups/pending': return { invitations: [] };
    case '/v1/cloud/blocks': return { blocks: [] };
    case '/v1/cloud/expressive-media': return { media: [] };
    case '/v1/cloud/presence/online': return { accounts: [] };
    case '/v1/cloud/sessions/visibility': return visibility;
    case '/v1/cloud/presence/contacts': return { presence: [] };
    case '/v1/cloud/proactive/proposals': return { proposals: [] };
    case '/v2/calls/active': return { calls: [] };
    case '/v2/chat/conversations': return { conversation: conversation() };
    case '/v2/chat/attention': return [];
    case '/v2/chat/sync/bootstrap': return { protocol_version: 2, conversations: [conversation()], latest_messages: messages,
      session_visibility: visibility, next_cursor: String(syncEvents.length), last_stream_seq: syncEvents.length, server_time: timestamp };
    case '/v2/chat/sync': return { protocol_version: 2, events: syncEvents.slice(Number(url.searchParams.get('cursor')) || 0),
      next_cursor: String(syncEvents.length), last_stream_seq: syncEvents.length, has_more: false, server_time: timestamp };
    case '/v1/cloud/memory': return { memories, settings };
    case '/v1/cloud/memory/settings': return settings;
    case '/v1/cloud/common-ground/profiles': return { profiles: [] };
    case '/v1/cloud/digest': return { accountId: owner, status: 'ready', revision: 1, updatedAt: timestamp,
      partial: false, feedback: [], sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } };
    case '/v1/cloud/calendar/events': return { events };
    case '/v1/cloud/session-activity': return {
      tasks: Array.from(cards.values()).filter(card => card.kind === 'task').map(card => ({
        taskActivityId: card.cardId, sessionId, taskId: card.cardId, title: card.title, summary: card.detail,
        status: card.result === 'done' ? 'completed' : card.result === 'running' || card.result === 'approved' ? 'running' : 'pending',
        createdByAccountId: agent, targetAccountId: owner, participants: [], artifactIds: [], responseMessageId: null,
        createdAt: timestamp, updatedAt: timestamp, archivedAt: null,
      })), artifacts: [],
    };
    case '/v1/cloud/plan_cards': return planAction(input);
    case `/v1/cloud/plan_cards/${plan.eventId}`: return plan;
    case `/v2/chat/conversations/${groupId}/messages`: {
      if (method === 'GET') return { messages, next_before_sequence: null, has_more: false };
      const body = input.content?.blocks?.find(block => block.type === 'text')?.text ?? '';
      const text = body.startsWith('kordi-cloud-group:')
        ? JSON.parse(Buffer.from(body.split(':')[1], 'base64url').toString()).message?.text ?? ''
        : body;
      const sent = add(text, owner, null, input);
      if (/put it to a vote|decision poll|should we .* or /i.test(text)) decision();
      else if (/group memory/i.test(text)) memory();
      else if (/assign the task/i.test(text)) assignment();
      return { message: sent };
    }
    default: {
      const card = cards.get(path.split('/').at(-1));
      if (path.startsWith('/v1/cloud/facilitator/cards/') && card) {
        const viewerCard = () => ({ ...card, myVote: previewVotes.get(card.cardId) ?? null });
        if (method === 'GET') return viewerCard();
        if (card.kind === 'decision' && card.result === null && input.revision === card.revision) {
          if (input.action === 'vote' && input.option in card.counts) {
            const previous = previewVotes.get(card.cardId);
            if (previous !== undefined) card.counts[previous] -= 1;
            previewVotes.set(card.cardId, input.option);
            card.counts[input.option] += 1;
          } else if (input.action === 'confirm' && card.counts[input.option] > Math.max(...card.counts.filter((_, i) => i !== input.option))) {
            card.result = String(input.option);
          }
        } else if (card.kind === 'memory' && input.action === 'save_memory' && !card.result) {
          card.result = randomUUID();
          memories.push({ memoryId: card.result, text: card.detail, scope: 'group', scopeId: groupId, scopeLabel: title,
            source: 'manual', category: 'work_context', ownerAccountId: owner, ownerName: account.displayName,
            createdAt: timestamp, updatedAt: timestamp, profileIds: [] });
        } else if (card.kind === 'task' && card.result === 'pending') {
          if (input.action === 'approve') {
            card.result = 'approved';
            runAssignment(card);
          } else if (input.action === 'decline') card.result = 'declined';
        }
        card.revision += 1;
        cardChanged(card, 'cardId');
        return viewerCard();
      }
      if (/\/conversations\/[^/]+\/(read|delivered)$/.test(path)) return {};
      if (path.endsWith('/pin')) return { pin: null };
      if (path.endsWith('/pin-history')) return { pins: [] };
      if (path.endsWith('/unread')) return {};
      if (/\/conversations\/[^/]+\/calls\/active$/.test(path)) return { call: null };
      if (/\/conversations\/[^/]+\/calls$/.test(path)) return { unavailable: 'Calls need a live media service.' };
      if (/\/(auth\/profiles|accounts)\//.test(path)) return account;
      return undefined;
    }
  }
}

const fixture = {
  name: 'facilitator-case-fixture',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/') {
        response.writeHead(302, { location: home }).end();
        return;
      }
      if (!/^\/v[12]\//.test(url.pathname)) return next();
      let input = {};
      try {
        if (request.method !== 'GET') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          if (chunks.length) input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        const body = respond(url.pathname, url, request.method, input);
        const status = body?.unavailable ? 503 : body === undefined ? 404 : 200;
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(status === 200 ? body : {
          errorCode: 'fixture_route_unavailable', message: body?.unavailable ?? 'This request is unavailable in the synthetic preview.',
        }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"message":"Invalid fixture request."}');
      }
    });
  },
  transformIndexHtml() {
    return [{
      tag: 'div', attrs: { role: 'note', style: 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:5000;pointer-events:none;padding:4px 8px;border-radius:6px;background:#fff4d6;color:#503e14;font:11px system-ui;' },
      children: 'Facilitator case · Synthetic data and scripted agent replies', injectTo: 'body',
    }];
  },
};
const server = await createServer({
  configFile: fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
  plugins: [fixture], server: { host: '127.0.0.1', port, strictPort: true },
});
await server.listen();
process.stdout.write(`Facilitator case: ${origin}${home}\n`);
