import type { ChatSidebarRow } from './chatSidebarRows';

export const CHANNEL_HEIGHT = 46;
export const HEADER_HEIGHT = 64;
export const OVERSCAN = 4;

export type ParticipantSpaceBlock = {
  /** Null for rows listed before the first heading, such as personal agent rows. */
  header: Extract<ChatSidebarRow, { kind: 'space' }> | null;
  channels: ChatSidebarRow[];
};

/** Key for the block of rows listed before the first heading. */
export const LEADING_BLOCK_KEY = 'leading-rows';

export function participantSpaceBlockKey(block: ParticipantSpaceBlock) {
  return block.header?.key ?? LEADING_BLOCK_KEY;
}

export function participantSpaceBlocks(rows: readonly ChatSidebarRow[], compactChannels = false): ParticipantSpaceBlock[] {
  const blocks: ParticipantSpaceBlock[] = [];
  for (const row of rows) {
    if (row.kind === 'space' && !(compactChannels && row.key.startsWith('project-more:'))) blocks.push({ header: row, channels: [] });
    else if (blocks.length) blocks[blocks.length - 1].channels.push(row);
    else blocks.push({ header: null, channels: [row] });
  }
  return blocks;
}

export function visibleChannelRange(count: number, offset: number, viewportHeight: number) {
  const start = Math.max(0, Math.min(count, Math.floor(offset / CHANNEL_HEIGHT) - OVERSCAN));
  const end = Math.max(start, Math.min(count, Math.ceil((offset + viewportHeight) / CHANNEL_HEIGHT) + OVERSCAN));
  return { start, end };
}
