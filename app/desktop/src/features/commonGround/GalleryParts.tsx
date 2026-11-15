import { useCallback, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

import { useOutsideDismiss } from '@/features/documents/useOutsideDismiss';
import { cn } from '@/lib/utils';
import { galleryKind, galleryTypeLabel } from './galleryFormat';

/** The coloured type tile (MD, HTML, TS, CSV, PDF, PNG) for a file; `size` picks the chip, row or header size. */
export function GalleryTypeTile({ fileName, contentType, size = 'row', className }: {
  fileName: string;
  contentType: string | null;
  size?: 'chip' | 'row' | 'large';
  className?: string;
}) {
  const kind = galleryKind(fileName, contentType);
  return (
    <span className={cn('cg-type', `is-${kind}`, size !== 'row' && `is-${size}`, className)} aria-hidden="true">
      {galleryTypeLabel(fileName, kind)}
    </span>
  );
}

export type GalleryMenuItem = { label: string; onSelect: () => void; disabled?: boolean };

/** The ellipsis button with a small menu, on my own cards, the item header and comment rows. */
export function GalleryMenu({ items, className }: { items: GalleryMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(ref, open, close);
  return (
    <div ref={ref} className={cn('cg-gallery-more', open && 'is-open', className)}>
      <button
        type="button"
        className="cg-gallery-more-button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" className="app-transient-surface app-dense-menu app-dense-menu-items cg-gallery-menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="app-dense-menu-row app-dense-menu-danger"
              disabled={item.disabled}
              onClick={() => { close(); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
