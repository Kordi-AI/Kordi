// Slack channel choices: reading the chosen channels from connector settings
// and building the settings the server stores. Settings keep
// `{ channels: [ids] }` and add `channelNames: { id: name }` so the agent and
// the apps can show names.

import type { ConnectorChannel, ConnectorChannelOption } from './connectorsModel';

/** Most channels the server accepts. */
export const MAX_CHOSEN_CHANNELS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The chosen channels in stored order, with names when the settings have them. */
export function chosenChannelsFromSettings(settings: unknown): ConnectorChannel[] {
  if (!isRecord(settings) || !Array.isArray(settings.channels)) return [];
  const names = isRecord(settings.channelNames) ? settings.channelNames : {};
  return settings.channels
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => {
      const name = names[id];
      return { id, name: typeof name === 'string' && name ? name : null };
    });
}

/** The settings body for `PUT /:id/settings`. */
export function channelSettings(channels: ConnectorChannel[]): { channels: string[]; channelNames: Record<string, string> } {
  const channelNames: Record<string, string> = {};
  for (const channel of channels) {
    if (channel.name) channelNames[channel.id] = channel.name;
  }
  return { channels: channels.map((channel) => channel.id), channelNames };
}

/** Listed options plus chosen channels Slack no longer lists, so they can be turned off. */
export function channelChoices(options: ConnectorChannelOption[], chosen: ConnectorChannel[]): ConnectorChannelOption[] {
  const listed = new Set(options.map((option) => option.id));
  const missing = chosen
    .filter((channel) => !listed.has(channel.id))
    .map((channel) => ({ id: channel.id, name: channel.name ?? channel.id, isPrivate: channel.id.startsWith('G') }));
  return [...missing, ...options];
}

/** Choices whose name contains `query`, ignoring case and a leading `#`. */
export function filterChannelChoices(choices: ConnectorChannelOption[], query: string): ConnectorChannelOption[] {
  const needle = query.trim().replace(/^#/, '').toLowerCase();
  if (!needle) return choices;
  return choices.filter((choice) => choice.name.toLowerCase().includes(needle));
}

/** `chosen` with `option` turned on or off, keeping the chosen order. */
export function toggleChannel(chosen: ConnectorChannel[], option: ConnectorChannelOption, on: boolean): ConnectorChannel[] {
  const rest = chosen.filter((channel) => channel.id !== option.id);
  return on ? [...rest, { id: option.id, name: option.name }] : rest;
}

/** Normalizes the server's option list, dropping malformed entries. */
export function channelOptionsFromServer(value: unknown): ConnectorChannelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return [];
    const name = typeof item.name === 'string' && item.name ? item.name : item.id;
    return [{ id: item.id, name, isPrivate: item.isPrivate === true }];
  });
}
