/**
 * Account-private sync hints that ask this Mac to run something: a digest
 * run or a proactive run the server holds for this Mac, or a comment request
 * in a shared document. The server announces each held run only once, so a
 * hint the sync mapping drops leaves the run to the cloud once its hold ends.
 * `proactive.proposal_changed` tells the owner that one of their agents'
 * proactive offers was created or changed. `proactive.eval_requested` and
 * `proactive.run_requested` hold an evaluation or an allowed offer for this
 * Mac (`features/proactive/proactiveMacRuns`). `personal_agent.eval_requested`
 * holds a personal agent's evaluation of new connector events, which this Mac
 * runs like a proactive evaluation.
 * `common_ground.nearby.updated`
 * and `common_ground.nearby.alert` refresh open Grounding Nearby views
 * (`features/commonGround/nearbyHints`). `common_ground.card.updated` (a card
 * build finished, by hand or automatically) refreshes an open Grounding page
 * (`features/commonGround/cardHints`). `common_ground.room.updated` (a room's
 * members, matching, themes or a member's card changed) and
 * `common_ground.matches.updated` (a match for this account finished or
 * failed) refresh the open Grounding room, match page or Rooms list
 * (`features/commonGround/roomHints`). `common_ground.invitations.updated` (a
 * person invited this account to a group, or it answered one elsewhere)
 * refreshes Contacts › Requests (`features/commonGround/roomInvitations`).
 */
export const ACCOUNT_HINT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'common_ground.card.updated',
  'common_ground.invitations.updated',
  'common_ground.matches.updated',
  'common_ground.nearby.alert',
  'common_ground.nearby.updated',
  'common_ground.room.updated',
  'digest.run_requested',
  'document.agent_request',
  'personal_agent.eval_requested',
  'proactive.eval_requested',
  'proactive.proposal_changed',
  'proactive.run_requested',
]);
