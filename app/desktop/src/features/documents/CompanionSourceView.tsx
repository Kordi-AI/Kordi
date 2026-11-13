import { ArrowUpRight, Copy, WrapText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DesktopArtifactPreview } from '@/kordi-app/types';

// What the toolbar calls a file: a plain name in sentence case, never a shouted extension.
const FORMAT_NAMES: Record<string, string> = {
  txt: 'Plain text', text: 'Plain text', log: 'Log', md: 'Markdown', markdown: 'Markdown',
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', swift: 'Swift', kt: 'Kotlin', java: 'Java', c: 'C', h: 'C header',
  cpp: 'C++', cs: 'C#', php: 'PHP', sh: 'Shell', zsh: 'Shell', bash: 'Shell', sql: 'SQL',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', csv: 'CSV', tsv: 'TSV',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', svg: 'SVG', mmd: 'Mermaid', mermaid: 'Mermaid',
};
// Files the source view cannot show; they get a way out instead of a misleading error.
const NO_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages', 'zip', 'gz', 'tar', 'mov', 'mp4', 'mp3', 'wav']);

function extensionOf(path: string | null | undefined) {
  return path?.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
}

/** Bounded native preview; never executes a file or renders source as HTML. */
export function CompanionSourceView({ preview, path, onReload, onOpenExternal }: {
  preview: DesktopArtifactPreview | null;
  /** The file's path, for the empty state when it could not be read. */
  path?: string | null;
  onReload: () => void;
  /** Opens the file in its default app; shown when given. */
  onOpenExternal?: () => void;
}) {
  const [wrapPreference, setWrapPreference] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const extension = extensionOf(preview?.path ?? path);
  const plainText = extension === 'txt' || extension === 'text';
  const wrap = wrapPreference ?? plainText;
  const format = FORMAT_NAMES[extension] ?? (extension ? extension.toUpperCase() : 'Source');
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const openButton = onOpenExternal ? (
    <button type="button" onClick={onOpenExternal}><ArrowUpRight size={14} aria-hidden="true" />Open in default app</button>
  ) : null;

  if (!preview) {
    const noPreview = NO_PREVIEW.has(extension);
    return <div className="app-companion-status" role="status">
      <p>{noPreview ? `No preview for ${format} files yet.` : 'This file is unavailable on this device.'}</p>
      <div className="app-companion-status-actions">
        {openButton}
        {noPreview ? null : <button type="button" onClick={onReload}>Retry</button>}
      </div>
    </div>;
  }
  const copy = () => {
    const text = preview.lines.map((line) => line.text).join('\n');
    void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => undefined);
  };
  return <>
    <div className="app-document-source-toolbar">
      <span>{format}<span aria-hidden="true">·</span>{preview.lines.length} {preview.lines.length === 1 ? 'line' : 'lines'}</span>
      <span className="app-document-source-actions">
        <button type="button" aria-pressed={wrap} onClick={() => setWrapPreference(!wrap)}><WrapText size={14} aria-hidden="true" />Wrap lines</button>
        <button type="button" onClick={copy}><Copy size={13} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
        {openButton}
      </span>
    </div>
    <div className="app-companion-source" data-wrap={wrap} tabIndex={0} aria-label="File source">
      {preview.lines.length ? <pre>{preview.lines.map(line => <span key={line.number} className="app-companion-source-line">
        <span aria-hidden="true">{line.number}</span><code>{line.text || ' '}</code>
      </span>)}</pre> : <p>This file is empty.</p>}
      {preview.truncated ? <p className="app-companion-status">Preview truncated.</p> : null}
    </div>
  </>;
}
