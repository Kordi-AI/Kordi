'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const manifest = require('../package.json');
const { questionnaire } = require('../lib/scoring.cjs');
const register = require(path.join('..', manifest.kordi.extensions[0]));

function extension() {
  const tools = new Map();
  const commands = new Map();
  register({
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, definition) => commands.set(name, definition),
  });
  return { tool: tools.get('dnd_alignment'), command: commands.get('alignment'), tools, commands };
}

function neutralAnswers() {
  return questionnaire().questions.map(question => ({
    questionId: question.id, choice: question.options.find(option => option.score === 0).choice,
  }));
}

test('package registers only the opt-in tool and slash command using supported API', () => {
  const { tool, tools, commands } = extension();
  assert.equal(tools.size, 1);
  assert.equal(commands.size, 1);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.answers.minItems, 12);
  assert.equal(tool.parameters.properties.answers.maxItems, 12);
});

test('tool returns questionnaire and reproducible structured result without UI or context', async () => {
  const { tool } = extension();
  const questionResult = await tool.execute('q1', { action: 'questionnaire' });
  assert.deepEqual(JSON.parse(questionResult.content[0].text), questionnaire());
  const result = await tool.execute('s1', { action: 'score', answers: neutralAnswers() });
  assert.equal(JSON.parse(result.content[0].text).alignment, 'True Neutral');
  assert.equal(result.isError, undefined);
});

test('tool returns explicit errors instead of silently defaulting or scoring partial inputs', async () => {
  const { tool } = extension();
  for (const args of [null, [], {}, { action: 'guess' }, { action: 'questionnaire', answers: [] },
    { action: 'score' }, { action: 'score', answers: neutralAnswers(), extra: true }]) {
    const result = await tool.execute('bad', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /entertainment only/);
    assert.doesNotMatch(result.content[0].text, /"alignment":/);
  }
});

test('slash command shows original questionnaire, explanations, and case-insensitive scoring', async () => {
  const { command } = extension();
  assert.match(await command.handler(''), /o1\. Your adventuring party/);
  assert.equal(await command.handler('questions'), await command.handler('help'));
  assert.match(await command.handler('explain'), /arbitrary game design/);
  assert.match(await command.handler('explain'), /configured model provider/);
  const choices = neutralAnswers().map(answer => answer.choice.toLowerCase()).join(' ');
  assert.match(await command.handler(`score ${choices}`), /^True Neutral/);
  assert.match(await command.handler('score A'), /No alignment calculated/);
  assert.match(await command.handler(`score ${'D '.repeat(12)}`), /No alignment calculated/);
  assert.match(await command.handler('score'), /exactly 12 choices/);
  assert.match(await command.handler('unexpected'), /^Usage:/);
});
