import type { ReactNode } from 'react';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { useBrowserChatProjects } from '@web/app/browserChatProjects';
import { ChatProjectsProvider } from './ChatProjectsProvider';
import { ChatProjectsContext, type ChatProjects } from './chatProjects';

// Only the web build carries the browser project catalog.
const useShellBrowserChatProjects = import.meta.env?.VITE_KORDI_WEB_APP === '1' ? useBrowserChatProjects : () => null;

/** The browser app lists the account's Mac projects; the Mac lists its own project folders. */
export function ShellChatProjects({ value, children }: { value: ChatProjects; children: ReactNode }) {
  const browser = useShellBrowserChatProjects(isBrowserAppRuntime());
  return browser ? <ChatProjectsContext value={browser}>{children}</ChatProjectsContext>
    : <ChatProjectsProvider value={value}>{children}</ChatProjectsProvider>;
}
