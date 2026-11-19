'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('../src/core.cjs');

function generator(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

test('20,000 deterministic synthetic decisions: bounds, no mutation, no unexpected UNKNOWN',
  { timeout: 15000 }, () => {
    const random = generator(20261116);
    const count = 20000;
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const law = random() * 4 - 2;
      const good = random() * 4 - 2;
      const item = { id: `synthetic-${i}`, lawChaos: law, goodEvil: good,
        evidence: [`Synthetic trace ${i}`] };
      const input = { scope: 'agent_decision', items: [item] };
      const before = JSON.stringify(input);
      const result = assess(input);
      assert.equal(JSON.stringify(input), before);
      assert.equal(result.summary.total, 1);
      assert.equal(result.summary.scored, 1);
      assert.equal(result.summary.unknown, 0);
      assert.equal(result.results[0].status, 'SCORED');
      assert.equal(result.results[0].axes.lawChaos, law);
      assert.equal(result.results[0].axes.goodEvil, good);
      seen.add(result.results[0].alignment);
    }
    assert.equal(seen.size, 9);
  });
