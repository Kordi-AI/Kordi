'use strict';

const { AXES, DISCLAIMER, questionnaire, score, formatQuestionnaire, formatResult } = require('../lib/scoring.cjs');

module.exports = function alignmentExtension(kordi) {
  kordi.registerTool({
    name: 'dnd_alignment',
    description: 'Optional fictional-character alignment game. Use action questionnaire to present original scenarios, then score only the player\'s explicit complete answers. Never infer a real person\'s morality or score chat history. Entertainment only, not a clinical assessment.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['questionnaire', 'score'] },
        answers: {
          type: 'array', minItems: 12, maxItems: 12,
          items: {
            type: 'object',
            properties: {
              questionId: { type: 'string', enum: questionnaire().questions.map(question => question.id) },
              choice: { type: 'string', enum: ['A', 'B', 'C'] },
            },
            required: ['questionId', 'choice'], additionalProperties: false,
          },
        },
      },
      required: ['action'], additionalProperties: false,
    },
    execute: async (_toolCallId, args) => {
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || !Object.hasOwn(args, 'action')
          || Object.keys(args).some(key => !['action', 'answers'].includes(key))) {
          throw new Error('Provide action questionnaire or score, and answers only when scoring.');
        }
        let result;
        if (args.action === 'questionnaire') {
          if (Object.hasOwn(args, 'answers')) throw new Error('Request the questionnaire without answers.');
          result = questionnaire();
        } else if (args.action === 'score') {
          result = score(args.answers);
        } else {
          throw new Error('Unknown action; use questionnaire or score.');
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `${error.message} ${DISCLAIMER}` }] };
      }
    },
  });

  kordi.registerCommand('alignment', {
    description: 'Fictional D&D alignment: /alignment, /alignment explain, or /alignment score <12 choices>.',
    handler: async (args) => {
      const input = args.trim();
      if (!input || input === 'help' || input === 'questions') return formatQuestionnaire();
      if (input === 'explain') {
        return [DISCLAIMER, AXES.order, AXES.morality,
          'Six questions per axis; each contributes -2, 0, or +2. Range: -12 to +12; normalized = total / 12.',
          'At least +4: Lawful / Good. At most -4: Chaotic / Evil. Otherwise Neutral; both neutral = True Neutral.',
          'Opposing choices cancel. Thresholds are arbitrary game design, not validated measurements.',
          'Only complete answers are scored. The plugin does not store answers or make network requests.',
          'Answers supplied through an agent may enter its chat transcript and configured model provider.',
        ].join('\n');
      }
      const tokens = input.split(/\s+/);
      if (tokens.shift() !== 'score') return 'Usage: /alignment [questions|explain|score <12 space-separated A/B/C choices>]';
      try {
        const questions = questionnaire().questions;
        if (tokens.length !== questions.length) throw new Error(`Provide exactly ${questions.length} choices in the displayed question order.`);
        const answers = tokens.map((choice, index) => ({ questionId: questions[index].id, choice: choice.toUpperCase() }));
        return formatResult(score(answers));
      } catch (error) {
        return `No alignment calculated: ${error.message} Use /alignment for the questionnaire.`;
      }
    },
  });
};
