import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession, type AgentSession, type CustomTool, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { ompCapabilityOptions } from './capabilities';
import { toKordiMessage, toOmpMessage } from './messages';
import { RuntimeError, type JsonObject, type RunRequest, type ToolResult } from './protocol';
import { ompThinkingLevel } from './thinkingLevel';
import { DeltaJoiner } from './wellFormed';

export type RuntimeHost = {
  event(event: JsonObject): void;
  hook?(name: string, input: JsonObject): Promise<JsonObject>;
  tool(callId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

/** One admitted Kordi turn. Kordi owns credentials, tool permissions, and persistence. */
export async function runTurn(request: RunRequest, host: RuntimeHost, signal: AbortSignal) {
  const agentDir = await mkdtemp(join(tmpdir(), 'kordi-omp-'));
  let authStorage: AuthStorage | undefined;
  let session: AgentSession | undefined;
  let terminalError: RuntimeError | undefined;
  let steps = 0;
  let toolCalls = 0;
  let providerFailed = false;
  let providerFailureCode = 'provider_error';
  let providerFailureReason: string | undefined;
  let providerFailureResetsAt: number | undefined;
  const fail = (code: string, message: string) => {
    terminalError ??= new RuntimeError(code, message);
    if (session) void session.abort();
  };
  const abort = () => fail('cancelled', 'Run cancelled.');
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => fail('timeout', 'Run exceeded its time limit.'), request.limits.timeoutMs);
  try {
    host.event({ kind: 'status', status: 'starting' });
    if (signal.aborted) throw new RuntimeError('cancelled', 'Run cancelled.');
    authStorage = await AuthStorage.create(':memory:', {
      configValueResolver: async () => undefined,
      usageProviderResolver: () => undefined,
    });
    // A non-secret sentinel prevents upstream ambient environment key lookup for local no-auth routes.
    const credential = request.auth.kind === 'none' ? 'kordi-local-no-auth' : request.auth.credential!;
    authStorage.keys.setRuntime(request.model.provider, credential);
    const capabilityOptions = ompCapabilityOptions(request.capabilities ?? { ownerLocal: false, computer: false, browser: false }, request.tools.map(tool => tool.name));
    // Exact Kordi account/model selection must never silently fall back to ambient accounts/models.
    const settings = capabilityOptions.settings!.overlay({
      'retry.modelFallback': false,
      'retry.usageAwareFallback': false,
      'retry.waitForUsageReset': false,
      'compaction.idleEnabled': false,
      'compaction.handoffSaveToDisk': false,
      'compaction.methodOrder': ['handoff'],
      ...(request.compaction ? {
        'compaction.enabled': request.compaction.enabled,
        'compaction.reserveTokens': request.compaction.reserveTokens,
        'compaction.keepRecentTokens': request.compaction.keepRecentTokens,
        ...(request.compaction.thresholdTokens !== undefined ? { 'compaction.thresholdTokens': request.compaction.thresholdTokens } : {}),
      } : {}),
      'todo.enabled': false,
    });
    const modelRegistry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'), {
      ignoreLocalModelConfig: true, settings, cacheDbPath: join(agentDir, 'models.db'),
      fetch: async () => { throw new Error('Model discovery is disabled.'); },
    });
    const catalogModel = modelRegistry.find(request.model.provider, request.model.id);
    if (!catalogModel && (!request.model.api || !request.model.baseUrl)) {
      throw new RuntimeError('model_unavailable', 'The selected model needs an explicit provider transport and endpoint.');
    }
    const model: any = buildModel({
      name: request.model.id, reasoning: true, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
      ...catalogModel,
      ...Object.fromEntries(Object.entries(request.model).filter(([, value]) => value !== undefined)),
      headers: { ...catalogModel?.headers, ...request.auth.headers },
    } as any);
    modelRegistry.registerProvider(request.model.provider, {
      baseUrl: model.baseUrl, api: model.api, apiKey: 'kordi-selected-route', headers: model.headers, models: [model],
    }, 'kordi-selected-route');
    const sessionManager = SessionManager.inMemory(request.cwd);
    for (const message of request.messages) sessionManager.appendMessage(toOmpMessage(message, model.api, model));
    const initialEntryCount = sessionManager.getEntries().length;
    const customTools: CustomTool[] = request.tools.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
      // Visibility is explicit, and the Kordi host still applies its real permission policy.
      loadMode: 'essential',
      execute: async (callId, input, _onUpdate, _context, toolSignal) => {
        if (terminalError || signal.aborted) throw terminalError ?? new RuntimeError('cancelled', 'Run cancelled.');
        const result = await host.tool(callId, tool.name, input, toolSignal);
        return { content: result.content.map(block => toOmpMessage(block, model.api)) as any, details: result.details, isError: !result.ok };
      },
    }));
    const hookBridge: ExtensionFactory = api => {
      if (request.hooks?.includes('context') || request.prompt.trailingMessages?.length) api.on('context', async event => {
        try {
          const messages = event.messages.map(message => toKordiMessage(message));
          if (request.prompt.trailingMessages?.length) {
            // BeforeAgentStart custom context is already durable in Kordi. Keep
            // its position after this request without appending it a second time.
            const currentUser = messages.findLastIndex(message => message.role === 'user');
            if (currentUser < 0) throw new RuntimeError('hook_error', 'Current request context is unavailable.');
            messages.splice(currentUser + 1, 0, ...request.prompt.trailingMessages);
          }
          const input = { messages };
          const result = request.hooks?.includes('context') ? await host.hook?.('context', input) ?? input : input;
          if (!Array.isArray(result.messages)) throw new RuntimeError('hook_error', 'Invalid context hook result.');
          return { messages: result.messages.map((message: JsonObject) => toOmpMessage(message, model.api, model)) as any };
        } catch (error) { fail('hook_error', 'Context hook failed.'); throw error; }
      });
      if (request.hooks?.includes('before_provider_request')) api.on('before_provider_request', async event => {
        try {
          const input = { payload: event.payload };
          const result = await host.hook?.('before_provider_request', input) ?? input;
          if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) throw new RuntimeError('hook_error', 'Invalid provider hook result.');
          if (result.payload.model !== undefined && result.payload.model !== (event.payload as any)?.model) throw new RuntimeError('route_mismatch', 'A plugin cannot change the selected model.');
          return result.payload;
        } catch (error) { fail('hook_error', 'Provider hook failed.'); throw error; }
      });
    };
    const created = await createAgentSession({
      ...capabilityOptions, settings, cwd: request.cwd, agentDir, authStorage, modelRegistry, model,
      rebindModelAfterDiscovery: false,
      getApiKey: async selectedModel => {
        if (selectedModel.provider !== request.model.provider || selectedModel.id !== request.model.id) throw new RuntimeError('route_mismatch', 'Provider selection changed during the run.');
        return credential;
      },
      systemPrompt: request.systemPrompt, sessionManager, customTools,
      thinkingLevel: ompThinkingLevel(request.model.provider, request.model.id, request.thinking) as any,
      providerSessionId: request.sessionId,
      preloadedExtensionPaths: [], preloadedCustomToolPaths: [], extensions: [],
      preloadedPreparedExtensions: request.hooks?.length || request.prompt.trailingMessages?.length ? [{ path: '<kordi-hooks>', resolvedPath: '<kordi-hooks>', factory: hookBridge, error: null }] : [],
      enableIrc: false, skipPythonPreflight: true,
      workspaceTree: { rootPath: request.cwd, rendered: '', truncated: false, totalLines: 0, agentsMdFiles: [] },
      hasUI: false, interactivePrompts: false,
      // Host tools enforce Kordi approvals. Built-in Eval is admitted only for owner-local capability.
      autoApprove: true,
    });
    session = created.session;
    // A character split across two deltas is sent whole (see wellFormed.ts).
    const deltas = new DeltaJoiner();
    session.subscribe(event => {
      if (terminalError) return;
      switch (event.type) {
        case 'turn_start':
          if (++steps > (request.limits.maxSteps ?? Infinity)) return fail('step_limit', 'Run reached its model step limit.');
          host.event({ kind: 'turn_start', step: steps - 1 });
          host.event({ kind: 'status', status: 'running', step: steps });
          break;
        case 'turn_end': host.event({ kind: 'turn_end', step: steps - 1 }); break;
        case 'message_start':
          if (event.message.role === 'assistant') host.event({ kind: 'message_start' });
          break;
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_delta' || update.type === 'thinking_delta') {
            const delta = deltas.push(update.type, update.delta);
            if (delta) host.event({ kind: update.type, delta });
          }
          break;
        }
        case 'message_end':
          deltas.reset();
          // A host may continue after an explicitly configured provider failure.
          // Journal completed actions, never failed/partial assistant output.
          if (event.message.role !== 'assistant' || !['error', 'aborted'].includes(event.message.stopReason)) {
            host.event({ kind: 'message_end', message: toKordiMessage(event.message) });
          }
          if (event.message.role === 'assistant') {
            // Let the SDK complete its bounded retry policy before deciding the turn failed.
            providerFailed = event.message.stopReason === 'error';
            if (providerFailed) {
              providerFailureCode = providerErrorCode(event.message);
              providerFailureReason = providerReasonText(event.message.errorMessage);
              providerFailureResetsAt = providerFailureCode === 'provider_usage_limit' ? usageLimitResetsAt(event.message.errorMessage) : undefined;
            }
            if (event.message.stopReason === 'aborted') fail('cancelled', 'Run cancelled.');
          }
          break;
        case 'tool_execution_start':
          if (++toolCalls > (request.limits.maxToolCalls ?? Infinity)) return fail('tool_limit', 'Run reached its tool call limit.');
          host.event({ kind: 'tool_start', callId: event.toolCallId, name: event.toolName, input: event.args });
          break;
        case 'tool_execution_update':
          host.event({ kind: 'tool_update', callId: event.toolCallId, name: event.toolName, result: event.partialResult });
          break;
        case 'tool_execution_end':
          host.event({ kind: 'tool_end', callId: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError ?? false });
          break;
        case 'auto_compaction_start': host.event({ kind: 'compaction', phase: 'start' }); break;
        case 'auto_compaction_end': host.event({ kind: 'compaction', phase: 'end', aborted: event.aborted }); break;
        case 'auto_retry_start': host.event({ kind: 'retry', phase: 'start', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs,
          ...(providerReasonText(event.errorMessage) ? { reason: providerReasonText(event.errorMessage) } : {}) }); break;
        case 'auto_retry_end': host.event({ kind: 'retry', phase: 'end', attempt: event.attempt, success: event.success }); break;
      }
    });
    if (terminalError || signal.aborted) throw terminalError ?? new RuntimeError('cancelled', 'Run cancelled.');
    if (request.prompt.resume) {
      await session.agent.continue();
      await session.waitForIdle();
    } else {
      await session.prompt(request.prompt.text, { images: request.prompt.images, expandPromptTemplates: false });
    }
    if (terminalError) throw terminalError;
    if (providerFailed) throw new RuntimeError(providerFailureCode, 'The selected provider could not complete this request.', providerFailureReason, providerFailureResetsAt);
    const entries = sessionManager.getEntries();
    const newEntries = entries.slice(initialEntryCount);
    const messages = newEntries.filter((entry): entry is any => entry.type === 'message' && entry.message.role !== 'user').map(entry => toKordiMessage(entry.message));
    const lastAssistant = messages.findLast(message => message.role === 'assistant');
    const text = (lastAssistant?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
    const compacted = newEntries.findLast((entry): entry is any => entry.type === 'compaction');
    const allMessageEntries = entries.filter(entry => entry.type === 'message');
    const checkpoint = compacted ? {
      summary: compacted.summary, shortSummary: compacted.shortSummary, tokensBefore: compacted.tokensBefore,
      firstKeptMessageIndex: allMessageEntries.findIndex(entry => entry.id === compacted.firstKeptEntryId),
    } : undefined;
    if (checkpoint && checkpoint.firstKeptMessageIndex < 0) throw new RuntimeError('checkpoint_error', 'Cannot preserve the compacted history boundary.');
    const firstKeptEntryId = checkpoint
      ? request.messageEntryIds?.[checkpoint.firstKeptMessageIndex] ??
        (checkpoint.firstKeptMessageIndex === request.messages.length ? request.prompt.entryId : undefined)
      : undefined;
    host.event({ kind: 'status', status: 'completed' });
    return { text, messages, contextMessages: session.messages.map(message => toKordiMessage(message)),
      checkpoint: checkpoint ? { ...checkpoint, firstKeptEntryId } : undefined, usage: lastAssistant?.usage };
  } catch (error) {
    if (terminalError) throw terminalError;
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('runtime_error', 'The agent runtime could not complete this request.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await session?.dispose();
    authStorage?.close();
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** Only fixed classifications leave the worker; provider bodies may contain credentials or conversation text. */
export function providerErrorCode(error: { errorStatus?: number; errorMessage?: string }) {
  const message = error.errorMessage ?? '';
  if (/account.?id|decode.*token|invalid.*jwt/i.test(message)) return 'provider_account_identity';
  if (/model.*(?:not found|not supported|does not exist|unavailable|not allowed)|unsupported.*model/i.test(message)) return 'provider_model_unavailable';
  if (/invalid.*(?:tool|schema)|(?:tool|schema).*invalid/i.test(message)) return 'provider_tool_schema';
  if (/unsupported.*(?:parameter|value)|unknown.*parameter|unrecognized.*parameter/i.test(message)) return 'provider_unsupported_parameter';
  // Before the TLS and connection checks: a request ID in the body can contain their keywords.
  if (isUsageLimit(error.errorStatus, message)) return 'provider_usage_limit';
  if (/certificate|TLS|SSL/i.test(message)) return 'provider_tls';
  if (/fetch failed|unable to connect|connection refused|network|ENOTFOUND|ECONN/i.test(message)) return 'provider_connection';
  if (Number.isInteger(error.errorStatus) && error.errorStatus! >= 400 && error.errorStatus! <= 599) return `provider_http_${error.errorStatus}`;
  // Stream error events (Codex) carry no HTTP status.
  if (/rate.?limit|too many requests|at capacity/i.test(message)) return 'provider_http_429';
  if (/overloaded|temporarily unavailable/i.test(message)) return 'provider_http_503';
  return 'provider_error';
}

const USAGE_LIMIT_MIN_WAIT_MS = 5 * 60_000;
const USAGE_LIMIT_MAX_WAIT_MS = 31 * 24 * 60 * 60_000;

/**
 * An account's usage limit, which waits for a reset, rather than a short
 * throttle that a retry soon clears. Kept narrow: cloud runs retry throttles.
 */
function isUsageLimit(status: number | undefined, message: string) {
  if (status !== undefined && ![429, 402, 403].includes(status)) return false;
  // A per-minute or per-second cap is a throttle, whatever wait comes with it.
  if (/\bper[- ]?(?:sec(?:ond)?|min(?:ute)?)\b|\b(?:rpm|tpm)\b/i.test(message)) return false;
  // When the provider names a wait, its length decides.
  const wait = providerRetryHintMs(message);
  if (wait !== undefined && wait > 0) return wait >= USAGE_LIMIT_MIN_WAIT_MS;
  return /usage.?limit|usage_limit_reached|out of (?:extra )?usage|\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit/i.test(message);
}

/** The SDK's `retry-after-ms=<n>` hint on a provider error, in milliseconds. */
export function providerRetryHintMs(errorMessage: unknown) {
  if (typeof errorMessage !== 'string') return undefined;
  const match = /\bretry-after-ms=(\d{1,12})\b/.exec(errorMessage);
  return match ? Number(match[1]) : undefined;
}

/** When a usage limit resets, in epoch milliseconds, from the provider's retry hint. */
export function usageLimitResetsAt(errorMessage: unknown, now = Date.now()) {
  const wait = providerRetryHintMs(errorMessage);
  return wait !== undefined && wait >= USAGE_LIMIT_MIN_WAIT_MS && wait <= USAGE_LIMIT_MAX_WAIT_MS ? Math.trunc(now + wait) : undefined;
}

/**
 * The provider's own words, size-capped: the message of a JSON error body
 * that starts on the first line, else the first line. The Kordi host removes
 * credentials and IDs before display.
 */
export function providerReasonText(errorMessage: unknown) {
  if (typeof errorMessage !== 'string') return undefined;
  const text = (errorBodyMessage(errorMessage) ?? errorMessage).replace(/[ \t]*\bretry-after-ms=\d+\b/g, '');
  const line = text.split(/\r?\n/u, 1)[0]?.trim().slice(0, 2000);
  return line || undefined;
}

/** A JSON error body's message with its error code, or else its short error type. The request ID is never kept. */
function errorBodyMessage(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const lineEnd = text.search(/\r?\n/u);
  // A body on a later line follows wording the SDK chose to put first.
  if (start < 0 || end <= start || (lineEnd >= 0 && start > lineEnd)) return undefined;
  let body: any;
  try { body = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  const error = body?.error;
  const message = typeof error?.message === 'string' ? error.message
    : typeof body?.message === 'string' ? body.message
    : typeof error === 'string' ? error : '';
  if (!message.trim()) return undefined;
  // Hosts read codes such as `model_not_found` from this text.
  const code = typeof error?.code === 'string' ? error.code : body?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(code)) return `${message.trim()} (code=${code})`;
  const type = error?.type;
  return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? `${message.trim()} (${type})` : message.trim();
}
