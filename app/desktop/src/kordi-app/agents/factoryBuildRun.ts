import type { CloudAuthClient } from '@/features/cloud/authClient';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { kordiCloudFallbackRoute } from '@/features/chat/messageActions/noProviderRoute';
import { claimRuntimeRoute } from '@/features/digest/digestMacRuns';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { DesktopChatContextMessage } from '@/lib/desktopChatContextTypes';
import type { ComposerProviderOption } from '../components';
import { providerFamily } from './factoryTestRun';

type Claim = { acquired?: boolean; runId?: string; message?: string };

/**
 * The route a Build message runs with. A route without an account takes the
 * provider's active account, else its only one. When the provider has no
 * account on this Mac at all, a usable Kordi Cloud account takes over.
 */
export function factoryBuildRoute(
  route: DesktopChatMessageRoute | null,
  providerOptions: ComposerProviderOption[],
  fallback: (selection: { model: string; thinking?: string | null }) => DesktopChatMessageRoute | null = kordiCloudFallbackRoute,
): DesktopChatMessageRoute | null {
  if (!route || route.authChoice?.trim()) return route;
  const provider = providerFamily(route.authProvider || route.model?.split('/')[0]);
  const matching = providerOptions.filter((option) => (
    !option.disabled && !option.unavailable && providerFamily(option.providerId) === provider
  ));
  const selected = matching.find((option) => option.active) ?? (matching.length === 1 ? matching[0] : undefined);
  const authChoice = selected?.value.split('::').slice(1).join('::');
  if (selected && authChoice) return { ...route, authProvider: selected.providerId, authChoice };
  if (!selected && !matching.some((option) => option.hosted !== true)) {
    return fallback({ model: route.model ?? '', thinking: route.thinking }) ?? route;
  }
  return route;
}

/**
 * Runs one Build turn. A hosted-only account has no credential on this Mac, so
 * its turn runs under a Factory run the server admitted: claimed first, renewed
 * while the turn runs, then completed or released.
 */
export async function runFactoryBuildTurn<T extends { succeeded: boolean }>({ route, session, client, run, renewMs = 20_000 }: {
  route: DesktopChatMessageRoute | null;
  session: () => Promise<{ token: string; accountId: string } | null>;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  /** Starts the turn with these context messages and resolves once it completes. */
  run: (contextMessages: DesktopChatContextMessage[]) => Promise<T>;
  renewMs?: number;
}): Promise<T> {
  if (!hasHostedOnlyPrefix(route?.authChoice)) return run([]);
  const signedIn = await session();
  if (!signedIn) throw new Error('Sign in to Kordi to use this provider account in Factory.');
  const { token, accountId } = signedIn;
  const claimId = crypto.randomUUID();
  const claim = await client.desktopAgentExecution<Claim>(token, 'tasks', {
    kind: 'factory_test', claimId, runtimeRoute: claimRuntimeRoute(route),
  });
  const runId = claim.runId?.trim();
  if (!claim.acquired || !runId) throw new Error(claim.message || 'Another Factory run is active. Wait for it to finish, then retry.');
  const path = encodeURIComponent(runId);
  let succeeded = false;
  const timer = setInterval(() => {
    void client.desktopAgentExecution(token, `${path}/renew`, { claimId }).catch(() => undefined);
  }, renewMs);
  try {
    const turn = await run([{
      id: `factory-build-lease:${runId}`,
      authorName: 'Kordi',
      authorKind: 'agent',
      contextRole: 'runtimeIdentity',
      text: '',
      executionLease: { runId, claimId, ownerAccountId: accountId, sessionId: `factory:${accountId}` },
    }]);
    succeeded = turn.succeeded;
    return turn;
  } finally {
    clearInterval(timer);
    await client.desktopAgentExecution(token, `${path}/${succeeded ? 'complete' : 'release'}`, { claimId }).catch(() => undefined);
  }
}
