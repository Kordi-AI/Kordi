import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, Laptop, LoaderCircle, Search, X } from 'lucide-react';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { latestAgentRequestStopTarget } from '@/features/chat/agentRequestStop';
import type { Conversation } from '@/kordi-app/types';
import {
  assignBrowserProject, browserProjectPicker, canChooseBrowserProject, chatProjectSessionId, projectDeviceForSession,
  projectGroupForSession, refreshBrowserProjects, useBrowserProjectCatalog,
} from '@web/runtime/browserProjectCatalog';

/** The composer row of a browser app chat: its project picker and the Mac that holds the project. Only the web build renders it. */
export function BrowserChatWorkspaceRow({ conversation, disabled }: { conversation: Conversation; disabled: boolean }) {
  const catalog = useBrowserProjectCatalog(true);
  const sessionId = chatProjectSessionId(conversation);
  const choosable = canChooseBrowserProject(conversation);
  const group = projectGroupForSession(catalog.groups, sessionId);
  const device = group ? projectDeviceForSession(catalog.devices, sessionId) : null;
  const running = disabled || Boolean(latestAgentRequestStopTarget(conversation.messages));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const busy = busyId !== null;
  const picker = browserProjectPicker(catalog.devices, sessionId, query);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const onPointer = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!choosable && !group) return null;
  const deviceLabel = device ? (device.online ? device.name : `${device.name} · Offline`) : '';
  const assign = async (key: string, deviceId: string, projectId: string | null) => {
    setBusyId(key); setError(null);
    try {
      await assignBrowserProject({ deviceId, projectId, sessionId });
      await refreshBrowserProjects();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to change the project.');
      void refreshBrowserProjects();
    } finally { setBusyId(null); }
  };
  const optionIcon = (key: string, icon: ReactNode) => (busyId === key ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : icon);

  return <div className="chat-workspace-controls">
    <div className="chat-workspace-selector-row" aria-label="Chat workspace">
      {choosable ? <button ref={trigger} type="button" className="chat-project-trigger" disabled={running && !busy}
        aria-label={group ? `Project: ${group.project.name}` : 'Choose project'} aria-busy={busy}
        aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        onClick={() => {
          if (open) { setOpen(false); return; }
          const rect = trigger.current!.getBoundingClientRect();
          setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), bottom: Math.max(8, Math.min(window.innerHeight - rect.top + 6, window.innerHeight - 340)) });
          setLight(Boolean(trigger.current?.closest('.theme-light')));
          if (!busy) { setQuery(''); setError(null); }
          setOpen(true);
          void refreshBrowserProjects();
        }}>
        {busy ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
        <span>{group?.project.name ?? 'Choose project'}</span>
      </button> : <span className="chat-workspace-pill chat-workspace-project"><Folder size={13} aria-hidden="true" /><span>{group?.project.name}</span></span>}
      {device ? <span className="chat-workspace-pill" title={deviceLabel}><Laptop size={14} aria-hidden="true" />{deviceLabel}</span> : null}
    </div>
    {error && !open ? <ErrorLine>{error}</ErrorLine> : null}
    {open ? createPortal(<div ref={surface} id={id} role="dialog" aria-label="Choose project" aria-busy={busy}
      className={`chat-project-menu app-dense-menu app-composer-model-menu-layer${light ? ' app-compact-model-menu-light' : ''}`} style={position}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button[data-project-option]:not(:disabled)') ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {picker.hasProjects ? <div className="chat-project-search"><Search size={13} aria-hidden="true" />
        <input ref={search} aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} /></div> : null}
      <div className="chat-project-options">
        {picker.noProjectDeviceId ? <button data-project-option type="button" disabled={busy} className="chat-project-option"
          onClick={() => void assign('none', picker.noProjectDeviceId!, null)}>{optionIcon('none', <X size={13} aria-hidden="true" />)}<span>No project</span></button> : null}
        {picker.sections.map(({ device: mac, options }) => <div key={mac.id} role="group" aria-label={mac.name}>
          <div className="chat-workspace-menu-heading">{mac.online ? mac.name : `${mac.name} · Offline`}</div>
          {options.map(({ project, selected, disabled: offline }) => <button data-project-option type="button" key={project.id}
            disabled={busy || offline} className="chat-project-option" aria-pressed={selected}
            onClick={() => (selected ? setOpen(false) : void assign(project.id, mac.id, project.id))}>
            {optionIcon(project.id, <Folder size={13} aria-hidden="true" />)}<span>{project.name}</span>{selected ? <Check size={13} aria-hidden="true" /> : null}
          </button>)}
        </div>)}
        {!catalog.loaded ? <p className="chat-project-empty">Loading…</p>
          : !picker.hasProjects ? <p className="chat-project-empty">Open Kordi on your Mac to use its projects here.</p>
            : !picker.sections.length ? <p className="chat-project-empty">No matching projects</p> : null}
      </div>
      {error ?? catalog.error ? <ErrorLine className="m-0 p-2">{error ?? catalog.error}</ErrorLine> : null}
    </div>, document.body) : null}
  </div>;
}
