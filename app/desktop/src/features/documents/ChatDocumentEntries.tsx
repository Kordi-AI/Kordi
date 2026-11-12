import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { FilePlus2, FolderOpen, LayoutGrid, List, Paperclip, Plus, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { Message, SessionArtifact } from '@/kordi-app/types';
import type { ArtifactLayout } from '@/pages/artifactLayoutPreference';

import { ADD_DOCUMENT_ACCEPT } from './chatDocuments';
import { useDocumentReaderHost } from './documentReaderHost';
import { useChatDocumentEntries, type ChatDocumentEntriesOptions } from './useChatDocumentEntries';
import { useOutsideDismiss } from './useOutsideDismiss';

// The empty state uses the Memory tab's outlined buttons; with artifacts, they move into the New menu.
const EMPTY_ENTRY_CLASS = 'h-8 gap-1.5 rounded-lg px-3 text-[12px]';
const FORMAT_HELP = 'Markdown and HTML documents';

type ChatDocumentEntriesProps = Pick<ChatDocumentEntriesOptions, 'store' | 'open' | 'timeoutMs'> & {
  conversationId: string;
  messages: Message[];
  artifacts: SessionArtifact[];
  /** Shown in the centered empty state while the chat has no artifacts. */
  emptyLabel?: string;
  /** Search text of the toolbar; the search field shows when `onQueryChange` is given. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Cards or list; the switch shows when `onLayoutChange` is given. */
  layout?: ArtifactLayout;
  onLayoutChange?: (layout: ArtifactLayout) => void;
  /** The artifacts, under the toolbar. */
  children?: ReactNode;
};

function LayoutSwitch({ layout, onChange }: { layout: ArtifactLayout; onChange: (layout: ArtifactLayout) => void }) {
  const option = (value: ArtifactLayout, label: string, Icon: typeof List) => (
    <button
      type="button"
      aria-pressed={layout === value}
      aria-label={label}
      title={label}
      className="app-artifact-layout-option"
      onClick={() => onChange(value)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
  return (
    <div role="group" aria-label="Layout" data-artifact-layout-switch="true" className="app-artifact-layout-switch">
      {option('cards', 'Cards', LayoutGrid)}
      {option('list', 'List', List)}
    </div>
  );
}

/**
 * "New document" and "Add file" of the chat Artifacts tab. Without artifacts, the tab shows a
 * centered icon, one line, and the two buttons, like the Memory tab. With artifacts, a toolbar
 * holds the search field, the cards/list switch, and a New menu with the two entries, and the
 * artifacts render under it. The entries are left out where the chat cannot take an attachment.
 * One instance serves both states, so a document sent from the empty state still opens once the
 * chat lists it.
 */
export function ChatDocumentEntries({
  conversationId,
  messages,
  artifacts,
  emptyLabel = 'No artifacts yet',
  query = '',
  onQueryChange,
  layout = 'cards',
  onLayoutChange,
  children,
  ...overrides
}: ChatDocumentEntriesProps) {
  const { addDocument } = useDocumentReaderHost();
  const entries = useChatDocumentEntries({ conversationId, messages, artifacts, addDocument, ...overrides });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useOutsideDismiss(menuRef, menuOpen, closeMenu);
  const formatHelpId = useId();
  const empty = artifacts.length === 0;
  const createDocument = () => { void entries.createDocument(); };
  const pickFile = () => inputRef.current?.click();

  const fileInput = entries.available ? (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ADD_DOCUMENT_ACCEPT}
        className="hidden"
        aria-label="Add file"
        aria-describedby={formatHelpId}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void entries.addFile(file);
          event.currentTarget.value = '';
        }}
      />
      <span id={formatHelpId} className="sr-only">{FORMAT_HELP}</span>
    </>
  ) : null;
  const error = entries.error ? (
    <ErrorLine className={empty ? 'mt-3' : 'mt-2'} align={empty ? 'center' : 'start'}>{entries.error}</ErrorLine>
  ) : null;

  if (empty) {
    const actions = entries.available ? (
      <div data-chat-document-entries="true" className="mt-4 flex items-center gap-2">
        <Button type="button" variant="outline" className={EMPTY_ENTRY_CLASS} disabled={entries.busy} onClick={createDocument}>
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
          New document
        </Button>
        <Button type="button" variant="outline" className={EMPTY_ENTRY_CLASS} disabled={entries.busy} title={FORMAT_HELP} aria-describedby={formatHelpId} onClick={pickFile}>
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          Add file
        </Button>
        {fileInput}
      </div>
    ) : null;
    return (
      <div data-chat-artifacts-empty="" className="flex min-h-[14rem] shrink-0 flex-col items-center justify-center px-6 py-6 text-center">
        <FolderOpen aria-hidden="true" className="h-5 w-5 text-[color:var(--utility-muted-text)] opacity-70" strokeWidth={1.75} />
        <p className="m-0 mt-2.5 text-[13px] leading-5 text-[color:var(--utility-muted-text)]">{emptyLabel}</p>
        {actions}
        {error}
      </div>
    );
  }

  const hasToolbar = Boolean(onQueryChange || onLayoutChange || entries.available);
  const toolbar = hasToolbar ? (
    <div className="shrink-0 pb-3">
      <div data-chat-document-entries="true" className="app-artifact-toolbar">
        {onQueryChange ? (
          <label className="app-artifact-search">
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <input type="search" value={query} placeholder="Search" aria-label="Search artifacts" onChange={(event) => onQueryChange(event.target.value)} />
          </label>
        ) : <span className="flex-1" />}
        {onLayoutChange ? <LayoutSwitch layout={layout} onChange={onLayoutChange} /> : null}
        {entries.available ? (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              className="app-artifact-toolbar-button"
              aria-label="New"
              title="New"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={entries.busy}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div role="menu" className="app-transient-surface app-dense-menu app-dense-menu-items absolute right-0 top-9 z-30 w-[200px]">
                <button type="button" role="menuitem" onClick={() => { closeMenu(); createDocument(); }}>
                  <FilePlus2 aria-hidden="true" />
                  New document
                </button>
                <button type="button" role="menuitem" title={FORMAT_HELP} aria-describedby={formatHelpId} onClick={() => { closeMenu(); pickFile(); }}>
                  <Paperclip aria-hidden="true" />
                  Add file
                </button>
              </div>
            ) : null}
            {fileInput}
          </div>
        ) : null}
      </div>
      {error}
    </div>
  ) : null;

  if (!children) return toolbar;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
