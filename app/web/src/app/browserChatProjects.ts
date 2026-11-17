import { useMemo } from 'react';
import type { ChatProjects } from '@/features/projects/chatProjects';
import { useBrowserProjectCatalog } from '@web/runtime/browserProjectCatalog';
import { BrowserChatWorkspaceRow } from '@/features/projects/BrowserChatWorkspaceRow';

const unavailable = () => Promise.reject(new Error('Projects are managed in Kordi on your Mac.'));

/** Projects in the browser come from the account catalog that Macs publish; folders stay on those Macs. */
export function useBrowserChatProjects(enabled: boolean): ChatProjects | null {
  const catalog = useBrowserProjectCatalog(enabled);
  return useMemo(() => (enabled ? {
    // The sidebar lists Projects only when some Mac publishes one.
    enabled: catalog.groups.length > 0,
    projects: catalog.groups.map(({ project }) => ({ id: project.id, name: project.name, sessions: project.sessions.map((id) => ({ id })) })),
    assign: unavailable,
    create: unavailable,
    WorkspaceRow: BrowserChatWorkspaceRow,
  } : null), [catalog.groups, enabled]);
}
