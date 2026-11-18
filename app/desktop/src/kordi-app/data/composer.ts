import { CHATGPT_MODEL_ORDER } from '@/features/cloud/chatgptModelCatalog';

/** The models a composer lists before any account provides its own. */
export const composerModelOptions = CHATGPT_MODEL_ORDER;

export const composerModeOptions = {
  chat: ['Send as Me', 'Send as Research Agent', 'Delegate to Research Agent', 'Internal note'],
  project: ['Post update', 'Ask project agent', 'Start new session', 'Share artifact'],
} as const;

export const composerThinkingOptions = [
  { value: 'off', label: 'Off' },
  { value: 'default', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
] as const;
