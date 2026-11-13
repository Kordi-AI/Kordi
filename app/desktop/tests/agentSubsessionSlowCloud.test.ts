import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { publishModelSubsession } from '../src/features/cloud/agentSubsessionSync';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

// A background session on this Mac holds a 30 s native deadline that the
// publish loop renews. Renewals used to follow only accepted publishes, so a
// slow server (15 s timeouts, a hanging request) let the deadline pass and
// the native watchdog stopped a healthy task with no result.
test('a slow or unreachable cloud does not stop a running background session', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldGet = CloudAuthClient.prototype.getAgentSubsession;
  const oldPut = CloudAuthClient.prototype.putAgentSubsession;
  const commands: string[] = [];
  let renewalsDuringHang = 0;
  let hanging = false;
  let releaseHang!: () => void;
  let writes = 0;
  let finished = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => setTimeout(callback, 1),
    __TAURI_INTERNALS__: { invoke: async (command: string) => {
      commands.push(command);
      if (command === 'desktop_chat_subsession_snapshot') {
        return { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request', turnId: 'turn',
          title: 'Investigate', status: finished ? 'done' : 'running', messages: [] };
      }
      if (command === 'desktop_chat_renew_execution_lease') {
        if (hanging) renewalsDuringHang += 1;
        return null;
      }
      throw Error(`Unexpected command: ${command}`);
    } },
  } });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'owner', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  CloudAuthClient.prototype.getAgentSubsession = async () => ({ status: 'running', version: writes }) as CloudAgentSubsession;
  CloudAuthClient.prototype.putAgentSubsession = async (_token, value) => {
    writes += 1;
    // Timeouts and server errors: the request got no answer.
    if (writes >= 2 && writes <= 4) throw new CloudAuthError(writes === 3 ? 'server_error' : 'network_error', 'No answer', writes === 3 ? 503 : 0);
    // A request that hangs far longer than one loop step.
    if (writes === 5) {
      hanging = true;
      await new Promise<void>((resolve) => { releaseHang = resolve; });
      hanging = false;
    }
    if (writes >= 6) finished = true;
    return { status: value.status, version: writes } as CloudAgentSubsession;
  };
  try {
    await publishModelSubsession('child');
    for (let wait = 0; wait < 400 && !hanging; wait += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert(hanging, 'the loop reached the hanging request');
    const renewalsBeforeHang = commands.filter(command => command === 'desktop_chat_renew_execution_lease').length;
    assert(renewalsBeforeHang >= 4, 'unanswered publishes keep renewing the deadline');
    for (let wait = 0; wait < 400 && renewalsDuringHang < 3; wait += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert(renewalsDuringHang >= 3, 'the heartbeat renews while a request hangs');
    releaseHang();
    for (let wait = 0; wait < 400 && writes < 7; wait += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert(!commands.includes('desktop_chat_cancel_turn'), 'a slow cloud must not stop the task');
  } finally {
    // Let the loop publish the finished task and end before restoring.
    await new Promise(resolve => setTimeout(resolve, 20));
    CloudAuthClient.prototype.getAgentSubsession = oldGet;
    CloudAuthClient.prototype.putAgentSubsession = oldPut;
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('an answer that refuses each attempt keeps renewing the deadline', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldGet = CloudAuthClient.prototype.getAgentSubsession;
  const oldPut = CloudAuthClient.prototype.putAgentSubsession;
  const oldWarn = console.warn;
  console.warn = () => undefined;
  const commands: string[] = [];
  let writes = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => setTimeout(callback, 1),
    __TAURI_INTERNALS__: { invoke: async (command: string) => {
      commands.push(command);
      if (command === 'desktop_chat_subsession_snapshot') {
        return { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request', turnId: 'turn',
          title: 'Investigate', status: writes >= 8 ? 'done' : 'running', messages: [] };
      }
      if (command === 'desktop_chat_renew_execution_lease') return null;
      throw Error(`Unexpected command: ${command}`);
    } },
  } });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'owner', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  CloudAuthClient.prototype.getAgentSubsession = async () => ({ status: 'running', version: 1 }) as CloudAgentSubsession;
  CloudAuthClient.prototype.putAgentSubsession = async (_token, value) => {
    writes += 1;
    if (writes >= 2 && writes < 8) throw new CloudAuthError('unauthorized', 'Sign in again', 401);
    return { status: value.status, version: writes } as CloudAgentSubsession;
  };
  try {
    await publishModelSubsession('child');
    let renewalsAfterRefusals = -1;
    for (let wait = 0; wait < 2000 && writes < 8; wait += 1) {
      if (writes >= 3 && renewalsAfterRefusals < 0) renewalsAfterRefusals = commands.filter(command => command === 'desktop_chat_renew_execution_lease').length;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const renewalsAtRecovery = commands.filter(command => command === 'desktop_chat_renew_execution_lease').length;
    assert(renewalsAfterRefusals >= 0, 'the loop retried the refused publish');
    assert(renewalsAtRecovery - renewalsAfterRefusals >= 3, 'refused attempts keep renewing the deadline');
    for (let wait = 0; wait < 400 && writes < 9; wait += 1) await new Promise(resolve => setTimeout(resolve, 1));
    assert(!commands.includes('desktop_chat_cancel_turn'));
  } finally {
    // Let the loop publish the finished task and end before restoring.
    await new Promise(resolve => setTimeout(resolve, 20));
    CloudAuthClient.prototype.getAgentSubsession = oldGet;
    CloudAuthClient.prototype.putAgentSubsession = oldPut;
    __setSessionBackendForTests(null);
    console.warn = oldWarn;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
