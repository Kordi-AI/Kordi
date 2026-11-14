import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchDesktopCommunityPopularSkills,
  fetchDesktopCommunitySkillProviders,
  searchDesktopCommunitySkills,
  type DesktopCommunitySkillSummary,
} from '@/lib/desktop';
import type { FactoryCommunityProvider } from './model';

const SEARCH_DELAY_MS = 320;
const MIN_QUERY_LENGTH = 2;

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function isProvider(value: string): value is FactoryCommunityProvider {
  return value === 'clawhub' || value === 'skills-sh';
}

export type CommunitySkillCatalog = ReturnType<typeof useCommunitySkillCatalog>;

/**
 * Community catalog state shared by the Factory rail (results list) and the detail pane.
 * `listProviders` loads the available catalogs for the filter menu before any catalog is open.
 * Before the user types two characters the list shows the catalog's most-installed skills;
 * that leaderboard is cached per provider for the session.
 */
export function useCommunitySkillCatalog(active: boolean, listProviders = active) {
  const [providers, setProviders] = useState<FactoryCommunityProvider[]>(['clawhub']);
  const [provider, setProvider] = useState<FactoryCommunityProvider>('clawhub');
  const [queries, setQueries] = useState<Partial<Record<FactoryCommunityProvider, string>>>({});
  const [results, setResults] = useState<DesktopCommunitySkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Partial<Record<FactoryCommunityProvider, string>>>({});
  const [installedIds, setInstalledIds] = useState<Set<string>>(() => new Set());
  const popularRef = useRef<Partial<Record<FactoryCommunityProvider, DesktopCommunitySkillSummary[]>>>({});
  const providersLoadedRef = useRef(false);

  const query = queries[provider] ?? '';
  const trimmedQuery = query.trim();
  const browsing = trimmedQuery.length < MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!listProviders || providersLoadedRef.current) return undefined;
    providersLoadedRef.current = true;
    let cancelled = false;
    void fetchDesktopCommunitySkillProviders()
      .then((available) => {
        if (cancelled) return;
        const next = available.filter(isProvider);
        setProviders(next.length > 0 ? next : ['clawhub']);
      })
      .catch(() => {
        if (!cancelled) setProviders(['clawhub']);
      });
    return () => { cancelled = true; };
  }, [listProviders]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const cachedPopular = browsing ? popularRef.current[provider] : undefined;
    if (cachedPopular) {
      setResults(cachedPopular);
      setLoading(false);
      setError(null);
      return undefined;
    }
    const run = () => {
      setLoading(true);
      setError(null);
      const request = browsing
        ? fetchDesktopCommunityPopularSkills(provider).then((next) => {
          popularRef.current[provider] = next;
          return next;
        })
        : searchDesktopCommunitySkills(provider, trimmedQuery);
      void request
        .then((next) => {
          if (!cancelled) setResults(next);
        })
        .catch((loadError) => {
          if (cancelled) return;
          setResults([]);
          setError(errorMessage(loadError, browsing ? 'Kordi could not load popular skills.' : 'Kordi could not search this catalog.'));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    if (browsing) {
      setResults([]);
      run();
      return () => { cancelled = true; };
    }
    const timeout = window.setTimeout(run, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [active, browsing, provider, trimmedQuery]);

  const decorated = useMemo(() => (
    installedIds.size === 0 ? results : results.map((result) => (
      installedIds.has(result.id) ? { ...result, installed: true } : result
    ))
  ), [installedIds, results]);
  const selectedId = selectedIds[provider] ?? null;
  const selected = decorated.find((result) => result.id === selectedId) ?? decorated[0] ?? null;

  const setQuery = useCallback((value: string) => {
    setQueries((current) => ({ ...current, [provider]: value }));
  }, [provider]);
  const select = useCallback((id: string) => {
    setSelectedIds((current) => ({ ...current, [provider]: id }));
  }, [provider]);
  const markInstalled = useCallback((id: string) => {
    setInstalledIds((current) => new Set(current).add(id));
  }, []);

  return {
    providers,
    provider,
    setProvider,
    query,
    setQuery,
    browsing,
    results: decorated,
    loading,
    error,
    selected,
    select,
    markInstalled,
  };
}
