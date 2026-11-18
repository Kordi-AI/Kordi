'use strict';

const questions = require('./questions.cjs');
const VERSION = '1.0.0';
const DISCLAIMER = 'For fictional character role-play and entertainment only. Not a clinical, psychological, or real-world moral assessment. The player decides their character\'s alignment.';
const THRESHOLD = 4;
const MAXIMUM = 12;
const AXES = Object.freeze({
  order: 'Positive = Lawful (structure); negative = Chaotic (autonomy). Neither implies kindness or cruelty.',
  morality: 'Positive = Good (care at personal cost); negative = Evil (deliberate exploitation or harm), using fantasy labels only.',
});

function questionnaire() {
  return {
    version: VERSION,
    disclaimer: DISCLAIMER,
    instructions: 'Answer as a fictional character. Choose exactly one A, B, or C for each question; do not infer answers from chat history or another person.',
    axes: { ...AXES },
    scoring: { minimum: -MAXIMUM, maximum: MAXIMUM, directionalThreshold: THRESHOLD, neutralRange: [-3, 3] },
    questions: questions.map(question => ({
      ...question, options: question.options.map(option => ({ ...option })),
    })),
  };
}

function score(answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new Error(`Provide exactly ${questions.length} answers, one for every question.`);
  }
  const byId = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)
      || Object.keys(answer).some(key => !['questionId', 'choice'].includes(key))
      || !Object.hasOwn(answer, 'questionId') || !Object.hasOwn(answer, 'choice')) {
      throw new Error('Each answer must contain only questionId and choice.');
    }
    const question = questions.find(item => item.id === answer.questionId);
    if (!question) throw new Error('Unknown questionId; use the current questionnaire.');
    if (byId.has(question.id)) throw new Error(`Duplicate answer for ${question.id}.`);
    const option = question.options.find(item => item.choice === answer.choice);
    if (!option) throw new Error(`Choice for ${question.id} must be A, B, or C.`);
    byId.set(question.id, option);
  }
  const totals = { order: 0, morality: 0 };
  const contributions = questions.map(question => {
    const option = byId.get(question.id);
    totals[question.axis] += option.score;
    return { questionId: question.id, choice: option.choice, axis: question.axis, score: option.score };
  });
  const order = totals.order >= THRESHOLD ? 'Lawful' : totals.order <= -THRESHOLD ? 'Chaotic' : 'Neutral';
  const morality = totals.morality >= THRESHOLD ? 'Good' : totals.morality <= -THRESHOLD ? 'Evil' : 'Neutral';
  const alignment = order === 'Neutral' && morality === 'Neutral' ? 'True Neutral' : `${order} ${morality}`;
  const axes = Object.fromEntries(Object.entries(totals).map(([axis, raw]) => [axis, {
    raw, normalized: raw / MAXIMUM, minimum: -MAXIMUM, maximum: MAXIMUM,
    tendency: axis === 'order' ? order : morality,
    description: AXES[axis],
  }]));
  return {
    version: VERSION, alignment, axes, contributions,
    explanation: `Each of six answers per axis contributes -2, 0, or +2. Totals at +${THRESHOLD} or above use the positive label; totals at -${THRESHOLD} or below use the negative label; otherwise Neutral. Opposing choices cancel. Thresholds are design choices, not validated measurements.`,
    disclaimer: DISCLAIMER,
  };
}

function formatQuestionnaire() {
  const lines = [DISCLAIMER, '', 'Choose A, B, or C for each scenario as your fictional character.'];
  for (const question of questions) {
    lines.push('', `${question.id}. ${question.prompt}`);
    for (const option of question.options) {
      lines.push(`  ${option.choice}. ${option.text} [${question.axis}: ${option.score >= 0 ? '+' : ''}${option.score}]`);
    }
  }
  lines.push('', 'Submit in the displayed order: /alignment score <12 space-separated A/B/C choices>.',
    'Use /alignment explain for thresholds and axis meanings. No result is produced for incomplete answers.');
  return lines.join('\n');
}

function formatResult(result) {
  return [
    `${result.alignment} (questionnaire v${result.version})`,
    `Order: ${result.axes.order.raw}/${MAXIMUM}; normalized ${result.axes.order.normalized.toFixed(3)} (-1 Chaotic to +1 Lawful).`,
    `Morality: ${result.axes.morality.raw}/${MAXIMUM}; normalized ${result.axes.morality.normalized.toFixed(3)} (-1 Evil to +1 Good).`,
    result.explanation,
    `Contributions: ${result.contributions.map(item => `${item.questionId}=${item.choice}:${item.score}`).join(', ')}.`,
    result.disclaimer,
  ].join('\n');
}

module.exports = { VERSION, DISCLAIMER, AXES, questionnaire, score, formatQuestionnaire, formatResult };
