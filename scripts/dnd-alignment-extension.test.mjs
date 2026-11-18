import '../agent/examples/dnd-alignment/test/scoring.test.cjs';
import '../agent/examples/dnd-alignment/test/extension.test.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Exercise the shipped host, not a reimplementation of its registration protocol.
test('alignment package loads and executes through the real plugin host', { timeout: 15_000 }, async (t) => {
  const host = fileURLToPath(new URL('../agent/crates/plugin-host/js/host.js', import.meta.url));
  const plugin = fileURLToPath(new URL('../agent/examples/dnd-alignment/extensions/index.cjs', import.meta.url));
  const child = spawn(process.execPath, [host, plugin], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  let sequence = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    lines.close();
    child.kill();
    await exited;
  });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.id === undefined) { notifications.push(message); return; }
      const response = pending.get(message.id);
      if (!response) return;
      pending.delete(message.id);
      if (message.error) response.reject(new Error(message.error.message));
      else response.resolve(message.result);
    } catch (error) {
      for (const response of pending.values()) response.reject(error);
      pending.clear();
    }
  });
  child.on('error', error => {
    for (const response of pending.values()) response.reject(error);
    pending.clear();
  });
  child.on('exit', code => {
    for (const response of pending.values()) response.reject(new Error(`Host exited (${code}): ${stderr}`));
    pending.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const execute = params => request('execute_tool', { name: 'dnd_alignment', toolCallId: 'alignment-test', params, context: { has_ui: false } });

  const result = await execute({ action: 'questionnaire' });
  const questionnaire = JSON.parse(result.content[0].text);
  assert.equal(questionnaire.questions.length, 12);
  assert.ok(notifications.some(message => message.method === 'tool_registered' && message.params.name === 'dnd_alignment'));
  assert.ok(notifications.some(message => message.method === 'command_registered' && message.params.name === 'alignment'));
  assert.ok(notifications.some(message => message.method === 'plugins_loaded'));
  assert.equal(notifications.some(message => message.method === 'plugin_error'), false);

  const answers = questionnaire.questions.map(question => ({
    questionId: question.id, choice: question.options.find(option => option.score === 2).choice,
  }));
  const scored = await execute({ action: 'score', answers });
  assert.equal(JSON.parse(scored.content[0].text).alignment, 'Lawful Good');
  const invalid = await execute({ action: 'score', answers: answers.slice(1) });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /exactly 12/);

  const command = await request('execute_command', {
    name: 'alignment', args: `score ${answers.map(answer => answer.choice).join(' ')}`, context: { has_ui: false },
  });
  assert.match(command, /^Lawful Good/);
  const explanation = await request('execute_command', { name: 'alignment', args: 'explain' });
  assert.match(explanation, /not validated measurements/);
  assert.equal(stderr, '');
});
