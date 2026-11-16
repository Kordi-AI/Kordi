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
  async () => {
    const child = spawn(process.execPath, [hostPath, extPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const registered = [];
    const pending = new Map();
    let counter = 0;
    let loaded;
    const loadedPromise = new Promise(resolve => { loaded = resolve; });
    const lines = createInterface({ input: child.stdout });
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
      lines.close();
      child.kill();
    }
  });
