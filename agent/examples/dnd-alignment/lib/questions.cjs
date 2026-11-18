'use strict';

// Original scenarios. Each question affects exactly one axis by -2, 0, or +2.
const questions = [
  {
    id: 'o1', axis: 'order', prompt: 'Your adventuring party needs a plan before entering a maze. What does your character prefer?',
    options: [
      { choice: 'A', text: 'Agree on roles and a procedure everyone will follow.', score: 2 },
      { choice: 'B', text: 'Agree on a goal, then decide how much structure each room needs.', score: 0 },
      { choice: 'C', text: 'Let each companion improvise without a fixed procedure.', score: -2 },
    ],
  },
  {
    id: 'o2', axis: 'order', prompt: 'A harmless festival rule requires every stall to use the same banner. Your character would:',
    options: [
      { choice: 'A', text: 'Use an individual design rather than accept a uniform rule.', score: -2 },
      { choice: 'B', text: 'Use the standard banner because consistent rules matter.', score: 2 },
      { choice: 'C', text: 'Choose whichever design works best for this particular stall.', score: 0 },
    ],
  },
  {
    id: 'o3', axis: 'order', prompt: 'A guild asks how future members should settle routine disagreements. Your character suggests:',
    options: [
      { choice: 'A', text: 'Use either precedent or improvisation, depending on the disagreement.', score: 0 },
      { choice: 'B', text: 'Let each group invent its own arrangement without binding precedent.', score: -2 },
      { choice: 'C', text: 'Write a shared charter with a predictable appeal process.', score: 2 },
    ],
  },
  {
    id: 'o4', axis: 'order', prompt: 'Two equally safe routes lead to camp. Your character chooses:',
    options: [
      { choice: 'A', text: 'The established route recorded in the expedition plan.', score: 2 },
      { choice: 'B', text: 'A new route, simply for the freedom to change course.', score: -2 },
      { choice: 'C', text: 'Either route; the earlier plan is useful but not decisive.', score: 0 },
    ],
  },
  {
    id: 'o5', axis: 'order', prompt: 'Your character helps organize a friendly weekly game. They prefer:',
    options: [
      { choice: 'A', text: 'A loose schedule that can be renegotiated when needed.', score: 0 },
      { choice: 'B', text: 'A regular time and agreed rules for taking turns.', score: 2 },
      { choice: 'C', text: 'Spontaneous meetings with no standing schedule or turn order.', score: -2 },
    ],
  },
  {
    id: 'o6', axis: 'order', prompt: 'A new settlement can coordinate its public garden in several equally effective ways. Your character favors:',
    options: [
      { choice: 'A', text: 'Independent gardeners making their own arrangements.', score: -2 },
      { choice: 'B', text: 'A mixture of shared guidelines and individual decisions.', score: 0 },
      { choice: 'C', text: 'An elected committee using published procedures.', score: 2 },
    ],
  },
  {
    id: 'm1', axis: 'morality', prompt: 'Your character has spare supplies after a storm. A stranger needs them. They would:',
    options: [
      { choice: 'A', text: 'Share enough to help, accepting a personal inconvenience.', score: 2 },
      { choice: 'B', text: 'Keep their own reserve but offer supplies in a fair trade.', score: 0 },
      { choice: 'C', text: 'Exploit the emergency to demand the stranger\'s treasured keepsake.', score: -2 },
    ],
  },
  {
    id: 'm2', axis: 'morality', prompt: 'A rival adventurer loses a valuable map. Your character finds it and would:',
    options: [
      { choice: 'A', text: 'Destroy it solely to make the rival suffer a setback.', score: -2 },
      { choice: 'B', text: 'Return it even though the rival might reach the treasure first.', score: 2 },
      { choice: 'C', text: 'Arrange an exchange for something of comparable value.', score: 0 },
    ],
  },
  {
    id: 'm3', axis: 'morality', prompt: 'A village requests help repairing a bridge. Your character has free time. They would:',
    options: [
      { choice: 'A', text: 'Help for the usual wage without accepting extra risk.', score: 0 },
      { choice: 'B', text: 'Sabotage another crossing to force a much higher payment.', score: -2 },
      { choice: 'C', text: 'Volunteer some time so isolated villagers can cross sooner.', score: 2 },
    ],
  },
  {
    id: 'm4', axis: 'morality', prompt: 'A magical contest offers a prize if someone else takes a painful penalty. Your character would:',
    options: [
      { choice: 'A', text: 'Give up the prize rather than make an unwilling stranger take the penalty.', score: 2 },
      { choice: 'B', text: 'Secretly assign the penalty to an unwilling stranger to win.', score: -2 },
      { choice: 'C', text: 'Enter only if every participant freely accepts the same risk.', score: 0 },
    ],
  },
  {
    id: 'm5', axis: 'morality', prompt: 'Your character negotiates with a merchant who made an honest pricing error. They would:',
    options: [
      { choice: 'A', text: 'Seek a fair price that protects both parties\' interests.', score: 0 },
      { choice: 'B', text: 'Point out the error even if it costs them a bargain.', score: 2 },
      { choice: 'C', text: 'Use the error to deliberately ruin the merchant for personal gain.', score: -2 },
    ],
  },
  {
    id: 'm6', axis: 'morality', prompt: 'A companion shares a fear in confidence. Your character would:',
    options: [
      { choice: 'A', text: 'Use the fear to coerce the companion into doing their bidding.', score: -2 },
      { choice: 'B', text: 'Respect the confidence without taking on additional responsibilities.', score: 0 },
      { choice: 'C', text: 'Offer support even when doing so takes time away from their own quest.', score: 2 },
    ],
  },
];

// Keep the versioned questionnaire stable even if a caller edits a returned copy.
for (const question of questions) {
  question.options.forEach(Object.freeze);
  Object.freeze(question.options);
  Object.freeze(question);
}
module.exports = Object.freeze(questions);
