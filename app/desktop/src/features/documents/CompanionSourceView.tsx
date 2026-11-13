import { ArrowUpRight, Copy, WrapText } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { DesktopArtifactPreview } from '@/kordi-app/types';
import type { ArtifactImage } from './artifactPreviewLoader';

import { ImageViewer } from './viewers/ImageViewer';
import { parseDelimited } from './viewers/delimitedText';
import { companionViewerKind, extensionOf, NO_PREVIEW } from './viewers/viewerKind';
import { TableViewer } from './viewers/TableViewer';

// The code viewer (CodeMirror and its grammars) loads in its own chunk the first time a file opens.
const CodeViewer = lazy(() => import('./viewers/CodeViewer'));

// What the toolbar calls a file: a plain name in sentence case, never a shouted extension.
const FORMAT_NAMES: Record<string, string> = {
  txt: 'Plain text', text: 'Plain text', log: 'Log', md: 'Markdown', markdown: 'Markdown',
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', swift: 'Swift', kt: 'Kotlin', java: 'Java', c: 'C', h: 'C header',
  cpp: 'C++', cs: 'C#', php: 'PHP', sh: 'Shell', zsh: 'Shell', bash: 'Shell', sql: 'SQL',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', csv: 'CSV', tsv: 'TSV',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', svg: 'SVG', mmd: 'Mermaid', mermaid: 'Mermaid',
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', avif: 'AVIF image', heic: 'HEIC image',
};
function indentedJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function lineLabel(count: number) {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useCopied() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, setCopied] as const;
}

/**
 * A file in the companion pane, filling it edge to edge under one quiet toolbar line: code and
 * text in the read-only code viewer, CSV and TSV as a table, SVG and images in the image viewer.
 * Tables and SVG switch to their source. Never executes a file or renders source as HTML.
 */
export function CompanionSourceView({ preview, path, image, onReload, onOpenExternal }: {
  preview: DesktopArtifactPreview | null;
  /** The file's path, for the type and the empty state when it could not be read. */
  path?: string | null;
  /** A raster image, read as bytes rather than text. */
  image?: ArtifactImage | null;
  onReload: () => void;
  /** Opens the file in its default app; shown when given. */
  onOpenExternal?: () => void;
}) {
  const filePath = preview?.path ?? path ?? '';
  const extension = extensionOf(filePath);
  const kind = companionViewerKind(filePath);
  const [wrapPreference, setWrapPreference] = useState<boolean | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useCopied();
  const plainText = extension === 'txt' || extension === 'text' || extension === 'log';
  const wrap = wrapPreference ?? plainText;
  const format = FORMAT_NAMES[extension] ?? (extension ? extension.toUpperCase() : 'Source');
  const name = filePath.split(/[\\/]/).pop() ?? filePath;

  const openButton = onOpenExternal ? (
    <button type="button" onClick={onOpenExternal}><ArrowUpRight size={14} aria-hidden="true" />Open in default app</button>
  ) : null;

  if (kind === 'image') {
    if (!image) return <EmptyState noPreview={false} format={format} onReload={onReload} openButton={openButton} />;
    const details = [format, imageSize ? `${imageSize.width} × ${imageSize.height}` : null, image.sizeBytes ? formatBytes(image.sizeBytes) : null].filter(Boolean).join(' · ');
    return <>
      <Toolbar info={details}>{openButton}</Toolbar>
      <ImageViewer src={image.src} name={name} onSize={setImageSize} />
    </>;
  }
  if (!preview) return <EmptyState noPreview={NO_PREVIEW.has(extension)} format={format} onReload={onReload} openButton={openButton} />;

  const text = preview.lines.map((line) => line.text).join('\n');
  // Valid JSON reads indented; Copy still copies the file as written.
  const shownText = extension === 'json' ? indentedJson(text) : text;
  const delimiter = extension === 'tsv' ? '\t' : ',';
  // A table counts its data rows (the first row is the header); other files count lines.
  const rowCount = kind === 'table' ? Math.max(0, parseDelimited(text, delimiter).length - 1) : 0;
  const lineCount = kind === 'table'
    ? `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
    : lineLabel(shownText.split('\n').length);
  const switchable = kind === 'table' || kind === 'svg';
  const sourceShown = !switchable || showSource;
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => undefined); };
  const viewSwitch = switchable ? (
    <span className="app-viewer-switch" role="group" aria-label="View">
      <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{kind === 'table' ? 'Table' : 'Image'}</button>
      <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>Source</button>
    </span>
  ) : null;

  return <>
    <Toolbar info={`${format} · ${lineCount}`}>
      {viewSwitch}
      {sourceShown ? <button type="button" aria-pressed={wrap} onClick={() => setWrapPreference(!wrap)}><WrapText size={14} aria-hidden="true" />Wrap lines</button> : null}
      <button type="button" onClick={copy}><Copy size={13} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
      {openButton}
    </Toolbar>
    <div className="app-companion-viewer" aria-label="File source">
      {sourceShown ? (
        <Suspense fallback={<pre className="app-code-viewer-fallback">{shownText}</pre>}>
          <CodeViewer text={shownText} path={filePath} wrap={wrap} />
        </Suspense>
      ) : kind === 'table' ? (
        <TableViewer text={text} delimiter={delimiter} />
      ) : (
        <ImageViewer src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} name={name} />
      )}
      {preview.truncated ? <p className="app-viewer-note">Preview truncated.</p> : null}
    </div>
  </>;
}

function Toolbar({ info, children }: { info: string; children: ReactNode }) {
  return <div className="app-document-source-toolbar">
    <span className="app-document-source-info">{info}</span>
    <span className="app-document-source-actions">{children}</span>
  </div>;
}

function EmptyState({ noPreview, format, onReload, openButton }: { noPreview: boolean; format: string; onReload: () => void; openButton: ReactNode }) {
  return <div className="app-companion-status" role="status">
    <p>{noPreview ? `No preview for ${format} files yet.` : 'This file is unavailable on this device.'}</p>
    <div className="app-companion-status-actions">
      {openButton}
      {noPreview ? null : <button type="button" onClick={onReload}>Retry</button>}
    </div>
  </div>;
}
