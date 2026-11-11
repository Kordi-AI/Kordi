import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalMentions } from '../src/features/canonical/readModel/mentionMapping';
import { parseMessageInlineParts } from '../src/kordi-app/components/messageLinks';

// Same message and mentions as the server test
// `rendered_mentions_match_the_desktop_fixture` in
// bridges/cloud-server/src/system_agent/mentions.rs.
test('System agent mentions render the person and agent names they carry', () => {
  const text = "@Maya Patel Synthetic does 7pm work? @Ana's Scout can confirm. @KordiSystem";
  const parts = parseMessageInlineParts(text, canonicalMentions([
    {
      label: 'MayaPatelSynthetic',
      targetKind: 'person',
      targetIdentityId: 'human:acct_maya',
      humanId: 'acct_maya',
      displayLabel: 'Maya Patel Synthetic',
      displayText: '@Maya Patel Synthetic',
      startUtf16: 0,
      lengthUtf16: 21,
    },
    {
      label: 'ScoutAna',
      targetKind: 'agent',
      targetIdentityId: 'agent:cloud-agent:acct_ana',
      agentId: 'cloud-agent:acct_ana',
      ownerAccountId: 'acct_ana',
      sourceHostId: 'cloud',
      displayLabel: "Ana's Scout",
      displayText: "@Ana's Scout",
      startUtf16: 37,
      lengthUtf16: 12,
    },
  ]));
  const mentions = parts.filter((part) => part.type === 'mention');

  assert.deepEqual(
    mentions.slice(0, 2).map((part) => part.type === 'mention'
      ? [part.label, part.targetKind, part.targetIdentityId]
      : []),
    [
      ['@Maya Patel Synthetic', 'person', 'human:acct_maya'],
      ["@Ana's Scout", 'agent', 'agent:cloud-agent:acct_ana'],
    ],
  );
  assert.equal(mentions[0]?.type === 'mention' ? mentions[0].humanId : null, 'acct_maya');
  assert.equal(parts[1]?.type === 'text' ? parts[1].value : null, ' does 7pm work? ');
});
