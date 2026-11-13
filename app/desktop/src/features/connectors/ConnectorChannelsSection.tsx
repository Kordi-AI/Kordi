import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/errors';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { settingsType } from '@/kordi-app/components/settingsType';
import { cn } from '@/lib/utils';

import { channelChoices, filterChannelChoices, MAX_CHOSEN_CHANNELS, toggleChannel } from './connectorChannels';
import type { ConnectorsClient } from './connectorsClient';
import { isConnectorNeedsReconnect } from './connectorsErrors';
import type { ConnectorChannelOption, ConnectorDefinition, ConnectorState } from './connectorsModel';

type ChannelsClient = Required<Pick<ConnectorsClient, 'listChannels' | 'saveChannels'>>;

function channelsClient(client: ConnectorsClient): ChannelsClient | null {
  if (!client.listChannels || !client.saveChannels) return null;
  const unsupported = () => new Error('Channels cannot be chosen here.');
  return {
    listChannels: (providerId) => client.listChannels?.(providerId) ?? Promise.reject(unsupported()),
    saveChannels: (providerId, channels) => client.saveChannels?.(providerId, channels) ?? Promise.reject(unsupported()),
  };
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'reconnect'; message: string; shownFor: ConnectorState }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; options: ConnectorChannelOption[] };

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * The searchable channel list for a connected Slack connector. Renders
 * nothing for other connectors or clients without channel choices.
 */
export function ConnectorChannelsSection(props: {
  definition: ConnectorDefinition;
  state: ConnectorState | undefined;
  client: ConnectorsClient;
  busy: boolean;
  onSaved: (state: ConnectorState) => void;
  onReconnect: () => void;
}) {
  const { definition, state, client } = props;
  const channels = useMemo(() => channelsClient(client), [client]);
  if (definition.providerId !== 'slack' || state?.status !== 'connected' || !channels) return null;
  return <ChannelList {...props} state={state} client={channels} />;
}

function ChannelList({
  definition,
  state,
  client,
  busy,
  onSaved,
  onReconnect,
}: {
  definition: ConnectorDefinition;
  state: ConnectorState;
  client: ChannelsClient;
  busy: boolean;
  onSaved: (state: ConnectorState) => void;
  onReconnect: () => void;
}) {
  const providerId = definition.providerId;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestRef = useRef(0);

  // `forState` is the connector state the list is loaded for; a reconnect
  // prompt shown for an older state loads again once the state changes.
  const load = useCallback(async (forState: ConnectorState) => {
    const request = ++requestRef.current;
    setLoaded({ kind: 'loading' });
    try {
      const options = await client.listChannels(providerId);
      if (request === requestRef.current) setLoaded({ kind: 'ready', options });
    } catch (caught) {
      if (request !== requestRef.current) return;
      setLoaded(isConnectorNeedsReconnect(caught)
        ? { kind: 'reconnect', message: message(caught, `Reconnect ${definition.name} to choose channels.`), shownFor: forState }
        : { kind: 'error', message: message(caught, 'Could not load channels.') });
    }
  }, [client, definition.name, providerId]);

  const initialStateRef = useRef(state);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load(initialStateRef.current);
    });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    if (loaded.kind !== 'reconnect' || loaded.shownFor === state) return;
    queueMicrotask(() => { void load(state); });
  }, [load, loaded, state]);

  const chosen = useMemo(() => state.channels ?? [], [state.channels]);
  const chosenIds = useMemo(() => new Set(chosen.map((channel) => channel.id)), [chosen]);
  const choices = useMemo(
    () => (loaded.kind === 'ready' ? filterChannelChoices(channelChoices(loaded.options, chosen), query) : []),
    [loaded, chosen, query],
  );
  const atLimit = chosen.length >= MAX_CHOSEN_CHANNELS;

  const toggle = async (option: ConnectorChannelOption, on: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await client.saveChannels(providerId, toggleChannel(chosen, option, on)));
    } catch (caught) {
      setSaveError(message(caught, 'Could not save channels.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Channels">
      {loaded.kind === 'loading' ? (
        <p className={cn('m-0 py-2', settingsType.description)} role="status">Loading channels…</p>
      ) : loaded.kind === 'reconnect' ? (
        <SettingsRow
          title={loaded.message}
          control={(
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={busy} onClick={onReconnect}>
              Reconnect
            </Button>
          )}
        />
      ) : loaded.kind === 'error' ? (
        <ErrorLine className="my-0 py-2" action={{ label: 'Try again', onClick: () => { void load(state); } }}>
          {loaded.message}
        </ErrorLine>
      ) : (
        <div className="py-2">
          <label className="relative block">
            <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              aria-label="Search channels"
              placeholder="Search channels"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="app-input-shell app-flat-input h-8 w-full rounded-lg pl-8 pr-2.5 text-[13px] text-white outline-none placeholder:text-slate-500"
            />
          </label>
          <div className="mt-2 max-h-72 overflow-y-auto" role="group" aria-label={`${definition.name} channels`}>
            {choices.length === 0 ? (
              <p className={cn('m-0 px-2 py-2', settingsType.description)}>No channels found.</p>
            ) : choices.map((option) => {
              const checked = chosenIds.has(option.id);
              return (
                <label
                  key={option.id}
                  data-channel-id={option.id}
                  className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-[color:var(--app-quiet-control-hover-bg)]"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-[color:var(--app-sidebar-accent)]"
                    checked={checked}
                    disabled={busy || saving || (!checked && atLimit)}
                    onChange={(event) => { void toggle(option, event.target.checked); }}
                  />
                  <span className={cn('min-w-0 flex-1 truncate', settingsType.rowTitle)}>#{option.name}</span>
                  {option.isPrivate ? <Lock aria-label="Private" className="h-3 w-3 shrink-0 text-slate-500" /> : null}
                </label>
              );
            })}
          </div>
          {saveError ? <ErrorLine className="mt-2">{saveError}</ErrorLine> : null}
        </div>
      )}
    </SettingsSection>
  );
}
