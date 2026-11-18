'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { questionnaire, score, formatResult } = require('../lib/scoring.cjs');
const questions = questionnaire().questions;

function answersFor(order, morality) {
  return questions.map(question => ({
    questionId: question.id,
    choice: question.options.find(option => option.score === (question.axis === 'order' ? order : morality)).choice,
  }));
}

for (const [orderScore, order] of [[2, 'Lawful'], [0, 'Neutral'], [-2, 'Chaotic']]) {
  for (const [moralityScore, morality] of [[2, 'Good'], [0, 'Neutral'], [-2, 'Evil']]) {
    test(`classifies ${order} / ${morality} independently`, () => {
      const answers = answersFor(orderScore, moralityScore);
      const result = score(answers);
      assert.equal(result.alignment, order === 'Neutral' && morality === 'Neutral' ? 'True Neutral' : `${order} ${morality}`);
      assert.equal(result.axes.order.raw, orderScore * 6);
      assert.equal(result.axes.morality.raw, moralityScore * 6);
      assert.equal(result.axes.order.normalized, orderScore / 2);
      assert.equal(result.axes.morality.normalized, moralityScore / 2);
      assert.deepEqual(score([...answers].reverse()), result);
      assert.equal(result.contributions.length, 12);
      assert.match(formatResult(result), /entertainment only/);
    });
  }
}

test('questionnaire is balanced, original-data shaped, and copied defensively', () => {
  assert.equal(questions.length, 12);
  assert.equal(new Set(questions.map(question => question.id)).size, 12);
  for (const axis of ['order', 'morality']) assert.equal(questions.filter(question => question.axis === axis).length, 6);
  for (const question of questions) {
    assert.deepEqual(question.options.map(option => option.choice), ['A', 'B', 'C']);
    assert.deepEqual(question.options.map(option => option.score).sort((a, b) => a - b), [-2, 0, 2]);
  }
  const copy = questionnaire();
  copy.questions[0].options[0].score = 999;
  copy.axes.order = 'modified';
  assert.equal(questionnaire().questions[0].options[0].score, 2);
  assert.match(questionnaire().axes.order, /Lawful/);
});

test('inclusive thresholds at +/-4 and neutral values immediately inside them', () => {
  for (const axis of ['order', 'morality']) {
    for (const direction of [-1, 1]) {
      for (const count of [1, 2]) {
        const answers = answersFor(0, 0);
        const relevant = questions.filter(question => question.axis === axis).slice(0, count);
        for (const question of relevant) {
          answers.find(answer => answer.questionId === question.id).choice = question.options.find(option => option.score === direction * 2).choice;
        }
        const result = score(answers);
        assert.equal(result.axes[axis].raw, direction * count * 2);
        const expected = count === 1 ? 'Neutral' : axis === 'order'
          ? (direction === 1 ? 'Lawful' : 'Chaotic') : (direction === 1 ? 'Good' : 'Evil');
        assert.equal(result.axes[axis].tendency, expected);
      }
    }
  }
});

test('opposing answers cancel rather than resolving ties by question order', () => {
  const answers = questions.map((question, index) => ({
    questionId: question.id,
    choice: question.options.find(option => option.score === (index % 2 ? -2 : 2)).choice,
  }));
  assert.equal(score(answers).alignment, 'True Neutral');
  assert.equal(score(answers).axes.order.raw, 0);
  assert.equal(score(answers).axes.morality.raw, 0);
});

test('every combination for either axis stays bounded and follows the documented rule', () => {
  for (const axis of ['order', 'morality']) {
    const relevant = questions.filter(question => question.axis === axis);
    for (let combination = 0; combination < 3 ** 6; combination++) {
      let remaining = combination;
      const answers = answersFor(0, 0);
      let expected = 0;
      for (const question of relevant) {
        const option = question.options[remaining % 3];
        remaining = Math.floor(remaining / 3);
        answers.find(answer => answer.questionId === question.id).choice = option.choice;
        expected += option.score;
      }
      const result = score(answers);
      assert.equal(result.axes[axis].raw, expected);
      assert.equal(result.axes[axis].normalized, expected / 12);
      assert.ok(Math.abs(result.axes[axis].normalized) <= 1);
      assert.equal(result.axes[axis === 'order' ? 'morality' : 'order'].raw, 0);
      assert.equal(result.axes[axis].tendency === 'Neutral', Math.abs(expected) < 4);
      assert.equal(result.contributions.filter(item => item.axis === axis).reduce((sum, item) => sum + item.score, 0), expected);
    }
  }
});

test('rejects incomplete, excessive, duplicate, unknown, and malformed answers', () => {
  for (const answers of [undefined, null, {}, 'ABC', [], answersFor(0, 0).slice(1), [...answersFor(0, 0), {}]]) {
    assert.throws(() => score(answers), /exactly 12 answers/);
  }
  for (const invalid of [null, [], 'A', {}, { questionId: 'o1', choice: 'A', extra: true }]) {
    const answers = answersFor(0, 0);
    answers[0] = invalid;
    assert.throws(() => score(answers), /only questionId and choice/);
  }
  for (const choice of ['D', 'a', 1, null, ' A ', '__proto__']) {
    const answers = answersFor(0, 0);
    answers[0].choice = choice;
    assert.throws(() => score(answers), /must be A, B, or C/);
  }
  const duplicate = answersFor(0, 0);
  duplicate[0] = duplicate[1];
  assert.throws(() => score(duplicate), /Duplicate/);
  const unknown = answersFor(0, 0);
  unknown[0].questionId = '__proto__';
  assert.throws(() => score(unknown), /Unknown questionId/);
});

test('scoring does not mutate supplied answers and reports no confidence or diagnosis', () => {
  const answers = answersFor(2, -2).map(Object.freeze);
  const result = score(Object.freeze(answers));
  assert.equal(result.alignment, 'Lawful Evil');
  assert.match(result.disclaimer, /Not a clinical/);
  assert.match(result.explanation, /not validated measurements/);
  assert.equal(Object.hasOwn(result, 'confidence'), false);
});
