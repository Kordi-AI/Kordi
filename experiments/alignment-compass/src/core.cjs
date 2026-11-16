'use strict';

/**
 * Deterministic D&D-inspired decision alignment lens.
 * Scores are supplied by the caller, not inferred from a person or agent.
 * This utility does not change agent permissions, autonomy, or safety policy.
 */
const VERSION = '0.1.0';
const LIMIT = 64;
const AXES = Object.freeze({
  lawChaos: { positive: 'Lawful', neutral: 'Neutral', negative: 'Chaotic' },
  goodEvil: { positive: 'Good', neutral: 'Neutral', negative: 'Evil' },
});

function axisName(value, axis) {
  if (value >= 0.5) return AXES[axis].positive;
  if (value <= -0.5) return AXES[axis].negative;
  return AXES[axis].neutral;
}

function normalizeItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`items[${index}] must be an object`);
  }
  const id = item.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
    throw new TypeError(`items[${index}].id must be 1-64 ASCII ID characters`);
  }
  const evidence = item.evidence === undefined ? [] : item.evidence;
  if (!Array.isArray(evidence) || evidence.length > 5 ||
      evidence.some(value => typeof value !== 'string' ||
        value.trim().length === 0 || value.length > 500)) {
    throw new TypeError(`items[${index}].evidence must be at most 5 nonempty strings (500 chars each)`);
  }
  for (const axis of Object.keys(AXES)) {
    const value = item[axis];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) ||
        value < -2 || value > 2)) {
      throw new TypeError(`items[${index}].${axis} must be a finite number in [-2, 2]`);
    }
  }
  return { id, lawChaos: item.lawChaos, goodEvil: item.goodEvil, evidence };
}

function assess(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Expected an object');
  }
  if (!['fictional', 'agent_decision'].includes(input.scope)) {
    throw new TypeError('scope must be fictional or agent_decision');
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > LIMIT) {
    throw new TypeError(`items must contain 1-${LIMIT} entries`);
  }
  const ids = new Set();
  const results = input.items.map((item, i) => {
    const row = normalizeItem(item, i);
    if (ids.has(row.id)) throw new TypeError(`Duplicate decision ID: ${row.id}`);
    ids.add(row.id);
    const hasAxes = row.lawChaos !== undefined && row.goodEvil !== undefined;
    // Evidence-free or incomplete scores must not receive a confident label.
    const scored = hasAxes && row.evidence.length > 0;
    const law = scored ? axisName(row.lawChaos, 'lawChaos') : null;
    const ethic = scored ? axisName(row.goodEvil, 'goodEvil') : null;
    return {
      id: row.id,
      status: scored ? 'SCORED' : 'UNKNOWN',
      alignment: scored ? (law === 'Neutral' && ethic === 'Neutral' ? 'True Neutral' :
        `${law} ${ethic}`) : null,
      axes: { lawChaos: row.lawChaos ?? null, goodEvil: row.goodEvil ?? null },
      evidence: row.evidence,
      note: scored ? 'Descriptive classification of supplied decision scores; not an ethical verdict.' :
        'Both axis scores and at least one evidence statement are required.',
    };
  });
  const countByAlignment = {};
  for (const result of results) {
    const name = result.alignment || 'UNKNOWN';
    countByAlignment[name] = (countByAlignment[name] || 0) + 1;
  }
  return {
    version: VERSION,
    scope: input.scope,
    methodology: {
      lawChaos: '-2 = Chaotic, +2 = Lawful',
      goodEvil: '-2 = Evil, +2 = Good',
      threshold: '|score| >= 0.5 produces a non-neutral axis',
      interpretation: 'User-supplied scores only; no automated moral inference or enforcement.',
    },
    results,
    summary: { total: results.length, scored: results.filter(r => r.status === 'SCORED').length,
      unknown: results.filter(r => r.status === 'UNKNOWN').length, countByAlignment },
  };
}

module.exports = { assess, axisName, VERSION, LIMIT };
