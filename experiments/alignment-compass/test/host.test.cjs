'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

const hostPath = path.resolve(__dirname, '../../../agent/crates/plugin-host/js/host.js');
const extPath = path.resolve(__dirname, '../extensions/alignment-compass.cjs');

test('real Kordi plugin host registers tool and command, runs RPC and rejects invalid data',
  { timeout: 15000, skip: !fs.existsSync(hostPath) ? 'Kordi plugin-host not checked out' : false },
  async (t) => {
    const child = spawn(process.execPath, [hostPath, extPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const registered = [];
    const pending = new Map();
    let counter = 0;
    let loaded;
    let failed;
    const loadedPromise = new Promise((resolve, reject) => { loaded = resolve; failed = reject; });
    const lines = createInterface({ input: child.stdout });
    const stop = (error = new Error('Plugin host stopped')) => {
      failed(error);
      for (const handler of pending.values()) handler.reject(error);
      pending.clear();
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    t.after(stop);
    t.signal.addEventListener('abort', () => stop(new Error('Plugin host test aborted')), { once: true });
    child.on('error', stop);
    child.on('exit', () => stop(new Error('Plugin host exited')));
    const errors = [];
    child.stderr.on('data', chunk => errors.push(chunk.toString()));
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.method === 'tool_registered' || event.method === 'command_registered') {
        registered.push(event.params.name);
      }
      if (event.method === 'plugins_loaded') loaded();
      if (event.method === 'plugin_error') errors.push(event.params.error);
      if (event.id !== undefined && pending.has(event.id)) {
        const handler = pending.get(event.id);
        pending.delete(event.id);
        event.error ? handler.reject(Error(event.error.message)) : handler.resolve(event.result);
      }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await loadedPromise;
      assert.deepEqual(errors, []);
      assert.deepEqual(registered.sort(), ['alignment', 'alignment_compass']);
      const params = {
        scope: 'agent_decision', items: [
          { id: 'consent-first', lawChaos: 2, goodEvil: 2, evidence: ['Explicit approval before modification'] },
        ],
      };
      const tool = await request('execute_tool', {
        name: 'alignment_compass', toolCallId: 'rpc-1', params, context: {},
      });
      assert.equal(JSON.parse(tool.content[0].text).results[0].alignment, 'Lawful Good');
      const cmd = await request('execute_command', {
        name: 'alignment', args: JSON.stringify(params), context: {},
      });
      assert.equal(JSON.parse(cmd.message).summary.scored, 1);
      const help = await request('execute_command', { name: 'alignment', args: 'help', context: {} });
      assert.match(help.message, /advisory/i);
      const bad = await request('execute_tool', {
        name: 'alignment_compass', toolCallId: 'rpc-bad', params: { scope: 'human', items: [] }, context: {},
      });
      assert.equal(bad.is_error, true);
      assert.match(bad.content[0].text, /input error/);
      const calls = Array.from({ length: 150 }, (_, i) => request('execute_tool', {
        name: 'alignment_compass', toolCallId: `stress-${i}`, params: {
          scope: 'fictional', items: [{
            id: `stress-${i}`, lawChaos: i % 5 - 2, goodEvil: 2 - (i % 5),
            evidence: ['Synthetic fixture'],
          }],
        }, context: {},
      }));
      const many = await Promise.all(calls);
      assert.equal(many.length, 150);
      for (let i = 0; i < many.length; i++) {
        assert.equal(JSON.parse(many[i].content[0].text).results[0].id, `stress-${i}`);
      }
    } finally {
      stop();
    }
  });

// Capture the advertised provider schema, rather than relying only on raw RPC.
test('tool schema permits omitted scores and evidence for UNKNOWN abstention', async () => {
  let tool;
  require('../extensions/alignment-compass.cjs')({
    registerTool: definition => { tool = definition; },
    registerCommand: () => {},
  });
  const itemSchema = tool.parameters.properties.items.items;
  assert.deepEqual(itemSchema.required, ['id']);
  for (const axis of ['lawChaos', 'goodEvil']) {
    assert.equal(itemSchema.properties[axis].type, 'number');
    assert.equal(itemSchema.properties[axis].minimum, -2);
    assert.equal(itemSchema.properties[axis].maximum, 2);
  }
  for (const item of [
    { id: 'missing-all' },
    { id: 'missing-axis', lawChaos: 0, evidence: ['Synthetic evidence'] },
    { id: 'missing-evidence', lawChaos: 0, goodEvil: 0 },
    { id: 'unverified-option', lawChaos: 0, evidence: [] },
  ]) {
    for (const key of itemSchema.required) assert.ok(Object.hasOwn(item, key));
    const response = await tool.execute('schema-test', { scope: 'fictional', items: [item] });
    assert.equal(JSON.parse(response.content[0].text).results[0].status, 'UNKNOWN');
  }
});
