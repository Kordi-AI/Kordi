import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { fetchDocumentTitleFromServer } from '@/features/documents/documentPreviewTitles';
import { documentDisplayName, useDocumentTitle, type DocumentTitleFetch } from '@/features/documents/documentTitles';
import { MarkdownContent } from '@/kordi-app/components';
import type { ConversationParticipant, SessionArtifact } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

import { extensionLabel, fileNameFromPath } from './artifactPreviewFormat';
import { formattedJsonSource } from './artifactPreviewText';
import { PersonAvatar } from './ArtifactListRow';
import { artifactFileBadge, artifactPeople } from './artifactRowModel';
import { useArtifactThumbnail, type ArtifactThumbnailContext, type ArtifactThumbnailSource } from './artifactThumbnail';

/** Width each kind is laid out at before it is scaled to the card. */
const LAYOUT_WIDTH: Record<string, number> = { markdown: 520, html: 1024, svg: 640, table: 460, source: 460, json: 460, mermaid: 460 };
const CODE_LINES = 32;
const TABLE_ROWS = 9;
const TABLE_COLUMNS = 5;

/** Scales a fixed-width layout down to the card, so text wraps the way it does in the reader. */
function ScaledPage({ layoutWidth, className, children }: { layoutWidth: number; className?: string; children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    // Only a real change re-renders: a page frame redrawn under a new transform can stay blank.
    const measure = () => setSize((current) => (
      current && current.width === frame.clientWidth && current.height === frame.clientHeight
        ? current
        : { width: frame.clientWidth, height: frame.clientHeight }
    ));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const scale = size && size.width > 0 ? size.width / layoutWidth : 0;
  return (
    <div ref={frameRef} className={cn('app-artifact-card-page', className)}>
      {scale > 0 ? (
        <div style={{ width: layoutWidth, height: Math.ceil((size?.height ?? 0) / scale), transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function tableRows(source: string, delimiter: string) {
  return source.split('\n').filter((line) => line.trim()).slice(0, TABLE_ROWS)
    .map((line) => line.split(delimiter).slice(0, TABLE_COLUMNS).map((cell) => cell.replace(/^"|"$/g, '')));
}

export function ArtifactThumbnailView({ thumbnail, path }: { thumbnail: ArtifactThumbnailSource; path: string }) {
  const { kind, source } = thumbnail;
  if (kind === 'markdown') {
    return (
      <ScaledPage layoutWidth={LAYOUT_WIDTH.markdown} className="app-artifact-card-paper">
        <MarkdownContent text={source} className="app-artifact-card-markdown" />
      </ScaledPage>
    );
  }
  if (kind === 'image') {
    return <img className="app-artifact-card-image" src={source} alt="" draggable={false} />;
  }
  if (kind === 'html' || kind === 'svg') {
    return (
      <ScaledPage layoutWidth={LAYOUT_WIDTH[kind]} className="app-artifact-card-web">
        {/* Scripts may run so styled pages look right; the frame gets no same-origin access and no input. */}
        <iframe title="" aria-hidden="true" tabIndex={-1} sandbox="allow-scripts" srcDoc={source} className="block h-full w-full border-0 bg-white" />
      </ScaledPage>
    );
  }
  if (kind === 'table') {
    const rows = tableRows(source, extensionLabel(path).toLowerCase() === 'tsv' ? '\t' : ',');
    return (
      <ScaledPage layoutWidth={LAYOUT_WIDTH.table} className="app-artifact-card-paper">
        <table className="app-artifact-card-table">
          <tbody>
            {rows.map((cells, rowIndex) => (
              <tr key={rowIndex}>{cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </ScaledPage>
    );
  }
  const code = (kind === 'json' ? formattedJsonSource(source) : source).split('\n').slice(0, CODE_LINES).join('\n');
  return (
    <ScaledPage layoutWidth={LAYOUT_WIDTH.source} className="app-artifact-card-code">
      <pre>{code}</pre>
    </ScaledPage>
  );
}

/** The file's own extension, short enough for the type pill; none for a bare name. */
function fileExtension(path: string) {
  const name = fileNameFromPath(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = extensionLabel(path);
  return extension.length <= 5 ? extension : '';
}

/** Starts loading a card's thumbnail once it is near the viewport. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

export function ArtifactCard({ artifact, isActive, participants, thumbnailContext, onOpen, onOpenExternal, fetchTitle = fetchDocumentTitleFromServer }: {
  artifact: SessionArtifact;
  isActive: boolean;
  participants: ConversationParticipant[];
  thumbnailContext: ArtifactThumbnailContext;
  onOpen: () => void;
  /** Opens the file in its default app; the arrow shows on hover when given. */
  onOpenExternal?: () => void;
  fetchTitle?: DocumentTitleFetch;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const near = useNearViewport(cardRef);
  const thumbnail = useArtifactThumbnail(artifact, thumbnailContext, near);
  const title = useDocumentTitle(artifact.attachmentId, artifact.name, fetchTitle);
  const label = documentDisplayName(artifact.name, title);
  const badge = artifactFileBadge(artifact);
  const BadgeIcon = badge.icon;
  const extension = fileExtension(artifact.path);
  const { creator } = artifactPeople(artifact, participants);
  const creatorName = creator ? creator.publicName?.trim() || creator.name : null;
  const time = artifact.live ? null : artifact.timeLabel;
  // A changed project file says how it changed, since it shares the grid with created files.
  const change = artifact.category === 'related' ? artifact.summary?.trim() || null : null;

  return (
    <div className="app-artifact-card-shell">
      <button
        ref={cardRef}
        type="button"
        data-artifact-card="true"
        aria-current={isActive ? 'true' : undefined}
        onClick={onOpen}
        className="app-artifact-card"
        title={label === artifact.name ? artifact.path : artifact.name}
      >
        <span className="app-artifact-card-thumb" data-thumbnail-status={thumbnail.status}>
          {thumbnail.status === 'ready' ? (
            <ArtifactThumbnailView thumbnail={thumbnail.thumbnail} path={artifact.path} />
          ) : (
            <span className={cn('app-artifact-card-glyph', badge.className)} aria-hidden="true">
              <BadgeIcon className="h-4 w-4" strokeWidth={1.75} />
            </span>
          )}
          {extension ? <span className={cn('app-artifact-card-type', badge.className)} title={badge.label}>{extension.toUpperCase()}</span> : null}
          {artifact.live ? <span className="app-artifact-card-live">Live</span> : null}
          {artifact.pinned ? <span className="app-artifact-card-pinned">Pinned</span> : null}
        </span>
        <span data-artifact-card-title="" className="app-artifact-card-title">{label}</span>
        <span className="app-artifact-card-meta">
          {change ? (
            <>
              <span data-artifact-card-change="" className="shrink-0">{change}</span>
              {creatorName || time ? <span aria-hidden="true">·</span> : null}
            </>
          ) : null}
          {creator && creatorName ? (
            <>
              <PersonAvatar participant={creator} className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{creatorName}</span>
              {time ? <span aria-hidden="true">·</span> : null}
            </>
          ) : null}
          {time ? <span className="shrink-0">{time}</span> : null}
          {!change && !creator && !time && artifact.summary ? <span className="min-w-0 truncate">{artifact.summary}</span> : null}
        </span>
      </button>
      {onOpenExternal ? (
        <button
          type="button"
          data-artifact-open-external=""
          className="app-artifact-card-open"
          aria-label={`Open ${label} in its default app`}
          title="Open in default app"
          onClick={onOpenExternal}
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
