import { useState, type ReactNode } from 'react';
import type { Message } from '@/kordi-app/types';
import { createModelRecoveryStore, ModelRecoveryContext } from './modelRecovery';

/** Joins one chat pane's composer and transcript for the failed reply's recovery. */
export function ModelRecoveryProvider({ messages, children }: { messages: readonly Message[]; children: ReactNode }) {
  const [store] = useState(createModelRecoveryStore);
  store.setMessages(messages);
  return <ModelRecoveryContext.Provider value={store}>{children}</ModelRecoveryContext.Provider>;
}
