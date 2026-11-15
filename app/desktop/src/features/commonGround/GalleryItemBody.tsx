import { lazy, Suspense } from 'react';

import { FileCard } from '@/features/documents/viewers/FileCard';
import { ImageViewer } from '@/features/documents/viewers/ImageViewer';
import { PdfViewer } from '@/features/documents/viewers/PdfViewer';
import { TableViewer } from '@/features/documents/viewers/TableViewer';
import { extensionOf } from '@/features/documents/viewers/viewerKind';
import { MarkdownContent } from '@/kordi-app/components';
import { artifactPreviewDocumentSource } from '@/pages/artifactPreviewDocument';
import { formatGallerySize, galleryTypeLabel, type CgGalleryKind } from './galleryFormat';
import { CgProgress } from './parts';
import type { CgGalleryItem } from './types';
import type { CgGalleryContent } from './useGalleryContent';

// The code viewer (CodeMirror and its grammars) loads in its own chunk, as in the companion pane.
const CodeViewer = lazy(() => import('@/features/documents/viewers/CodeViewer'));

/** A frame tall enough for short files and capped for long ones, so the page keeps scrolling. */
const fitHeight = (lines: number, lineHeight: number, padding: number, max: number) => Math.min(max, Math.max(96, lines * lineHeight + padding));

/**
 * The shared file, read-only: Markdown through the app's Markdown renderer, HTML in the sandboxed
 * preview the Artifacts tab uses, code and tables in the companion pane's viewers, images and PDFs
 * from the file's bytes, and anything else as a file card.
 */
export function GalleryItemBody({ item, kind, content }: { item: CgGalleryItem; kind: CgGalleryKind; content: CgGalleryContent }) {
  const name = item.fileName || item.title;
  if (kind === 'file') {
    const details = [galleryTypeLabel(name, kind), formatGallerySize(item.sizeBytes)].filter(Boolean).join(' · ');
    return <div className="cg-gallery-doc is-viewer"><FileCard name={name} details={details} note={null} /></div>;
  }
  if (content.status === 'loading') return <div className="cg-gallery-doc-state"><CgProgress inline line="Loading" /></div>;
  if (content.status === 'failed') return <div className="cg-gallery-doc-state cg-muted">Can’t open this file</div>;
  if (content.text !== null) {
    const text = content.text;
    if (kind === 'markdown') {
      return <div className="cg-gallery-doc is-paper"><MarkdownContent text={text} copySurface="document" className="cg-gallery-markdown" /></div>;
    }
    if (kind === 'html') {
      return (
        <div className="cg-gallery-doc is-web">
          <iframe title={item.title} srcDoc={artifactPreviewDocumentSource(text, 'panel')} sandbox="allow-scripts" className="cg-gallery-web" />
        </div>
      );
    }
    const lines = text.split('\n').length;
    if (kind === 'table') {
      return (
        <div className="cg-gallery-doc is-viewer" style={{ height: fitHeight(lines, 29, 40, 420) }}>
          <TableViewer text={text} delimiter={extensionOf(name) === 'tsv' ? '\t' : ','} />
        </div>
      );
    }
    return (
      <div className="cg-gallery-doc is-viewer" style={{ height: fitHeight(lines, 21.25, 44, 480) }}>
        <Suspense fallback={<pre className="app-code-viewer-fallback">{text}</pre>}>
          <CodeViewer text={text} path={name} wrap={false} />
        </Suspense>
      </div>
    );
  }
  if (kind === 'pdf') return <div className="cg-gallery-doc is-viewer is-pdf"><PdfViewer src={content.url} name={name} /></div>;
  return <div className="cg-gallery-doc is-viewer is-image"><ImageViewer src={content.url} name={name} /></div>;
}
