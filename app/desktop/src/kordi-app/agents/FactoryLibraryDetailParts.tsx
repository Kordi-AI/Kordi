import { useMemo, type ComponentType, type ReactNode } from 'react';
import { LoaderCircle, MoreHorizontal, ShieldAlert } from 'lucide-react';

import { handleDocumentCopySurfaceKeyDown } from '@/features/contentSelection';
import { MarkdownContent } from '@/kordi-app/components/markdown';
import { cn } from '@/lib/utils';
import { isMarkdownPath, OVERVIEW_TAB, splitFrontMatter } from './factoryLibraryUtils';
import { useDismissibleDetails } from './useDismissibleDetails';

export type FactoryDocMode = 'rendered' | 'source';

type IconComponent = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;

/** Name on the first line, "Kind · source · version" under it, actions on the right. */
export function FactoryDetailHeader({ icon: Icon, name, meta, children }: {
  icon: IconComponent;
  name: string;
  meta: string;
  children?: ReactNode;
}) {
  return (
    <header className="app-agent-studio-header app-factory-detail-header">
      <div className="flex min-w-0 items-center gap-3">
        <span className="app-agent-studio-factory-mark" aria-hidden="true"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0"><h2>{name}</h2><p>{meta}</p></div>
      </div>
      {children ? <div className="app-agent-studio-header-actions app-factory-detail-actions">{children}</div> : null}
    </header>
  );
}

export function FactoryEnabledSwitch({ enabled, disabled, onChange }: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className={cn('app-factory-enabled', disabled && 'is-disabled')}>
      Enabled
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Enabled"
        disabled={disabled}
        className="app-factory-switch"
        onClick={() => onChange(!enabled)}
      />
    </label>
  );
}

export type FactoryMenuItem = {
  label: string;
  icon: IconComponent;
  onSelect: () => void;
  danger?: boolean;
};

export function FactoryMoreMenu({ items }: { items: FactoryMenuItem[] }) {
  const { open: menuOpen, close: closeMenu, detailsRef: menuDetailsRef, summaryRef: menuSummaryRef, onToggle: onMenuToggle } = useDismissibleDetails();
  if (items.length === 0) return null;
  return (
    <details ref={menuDetailsRef} className="app-factory-more-menu" onToggle={onMenuToggle}>
      <summary
        ref={menuSummaryRef}
        className="app-button-quiet app-agent-studio-icon-button app-factory-icon-button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div className="app-factory-menu-panel app-factory-more-panel" role="menu">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="contents">
              {item.danger && index > 0 ? <hr /> : null}
              <button
                type="button"
                role="menuitem"
                className={cn(item.danger && 'is-danger')}
                onClick={() => {
                  closeMenu(true);
                  item.onSelect();
                }}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Overview plus one tab per file; Markdown files get a Rendered and Source switch. */
export function FactoryDetailTabs({ files, active, onChange, docMode, onDocModeChange }: {
  files: string[];
  active: string;
  onChange: (tab: string) => void;
  docMode: FactoryDocMode;
  onDocModeChange: (mode: FactoryDocMode) => void;
}) {
  const showDocMode = active !== OVERVIEW_TAB && isMarkdownPath(active);
  return (
    <nav className="app-factory-detail-tabs" aria-label="Sections">
      <div className="app-factory-detail-tab-list" role="tablist">
        {[OVERVIEW_TAB, ...files].map((tab) => (
          <button key={tab || 'overview'} type="button" role="tab" aria-selected={tab === active} className={cn(tab === active && 'is-active')} onClick={() => onChange(tab)}>
            {tab || 'Overview'}
          </button>
        ))}
      </div>
      {showDocMode ? (
        <div className="app-factory-doc-mode" role="group" aria-label="View">
          {(['rendered', 'source'] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={docMode === mode} className={cn(docMode === mode && 'is-active')} onClick={() => onDocModeChange(mode)}>
              {mode === 'rendered' ? 'Rendered' : 'Source'}
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}

export function FactoryFileView({ path, text, loading, mode }: {
  path: string;
  text: string | null;
  loading: boolean;
  mode: FactoryDocMode;
}) {
  const rendered = mode === 'rendered' && isMarkdownPath(path) && text !== null;
  const markdown = useMemo(() => (rendered && text !== null ? splitFrontMatter(text) : null), [rendered, text]);
  if (loading) return <div className="app-skill-library-loading"><LoaderCircle className="h-4 w-4 animate-spin" />Loading file…</div>;
  if (text === null) return <div className="app-skill-library-state"><strong>No text preview</strong></div>;
  if (markdown) {
    return (
      <div className="app-factory-file-view app-scroll-area">
        <article className="app-factory-markdown">
          {markdown.fields.length > 0 ? (
            <dl className="app-factory-front-matter">
              {markdown.fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
            </dl>
          ) : null}
          <MarkdownContent text={markdown.body} copySurface="document" />
        </article>
      </div>
    );
  }
  return (
    <div className="app-factory-file-view app-scroll-area is-source">
      <pre data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown}>{text}</pre>
    </div>
  );
}

export function FactoryOverview({ about, notice, details }: {
  about: string;
  notice?: string | null;
  details: Array<[string, ReactNode]>;
}) {
  return (
    <div className="app-factory-file-view app-scroll-area">
      <div className="app-factory-overview">
        <section>
          <h3>About</h3>
          <p>{about || 'No description.'}</p>
          {notice ? <div className="app-factory-security-notice" role="note"><ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /><span>{notice}</span></div> : null}
        </section>
        <section>
          <h3>Details</h3>
          <dl>
            {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      </div>
    </div>
  );
}
