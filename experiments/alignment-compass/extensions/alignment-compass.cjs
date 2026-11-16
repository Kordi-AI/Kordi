'use strict';

const { assess } = require('../src/core.cjs');

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'items'],
  properties: {
    scope: { type: 'string', enum: ['fictional', 'agent_decision'],
      description: 'Never evaluate a human being; use fictional characters or specific agent decisions.' },
    items: {
      type: 'array', minItems: 1, maxItems: 64,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Non-sensitive local decision identifier' },
          lawChaos: { type: 'number', minimum: -2, maximum: 2 },
          goodEvil: { type: 'number', minimum: -2, maximum: 2 },
          evidence: { type: 'array', maxItems: 5, items: { type: 'string' },
            description: 'Brief, non-sensitive evidence statements for these caller-provided scores.' },
        },
      },
    },
  },
};

module.exports = function registerAlignmentCompass(kordi) {
  kordi.registerTool({
    name: 'alignment_compass',
    description: 'Classify explicitly scored fictional or agent-decision examples into the nine D&D-inspired alignments. Advisory only; never changes tool permissions.',
    parameters: schema,
    execute: async (_toolCallId, args) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(assess(args)) }] };
      } catch (error) {
        return { is_error: true, content: [{ type: 'text', text: `Alignment Compass input error: ${error.message}` }] };
      }
    },
  });
  kordi.registerCommand('alignment', {
    description: 'Explain Alignment Compass or classify a JSON payload: /alignment {"scope":"fictional","items":[...]}',
    handler: async (args) => {
      if (!args || !args.trim() || args.trim() === 'help') {
        return { message: 'Alignment Compass: call the alignment_compass tool or use /alignment <JSON>. Required: scope=fictional|agent_decision, items=[{id}]. Optional: lawChaos:-2..2, goodEvil:-2..2, evidence:[...]. Missing scores or evidence return UNKNOWN. Scores are supplied, never inferred. This is advisory and cannot override Kordi safeguards.' };
      }
      try {
        return { message: JSON.stringify(assess(JSON.parse(args)), null, 2) };
      } catch (error) {
        return { message: `Alignment Compass input error: ${error.message}` };
      }
    },
  });
};
