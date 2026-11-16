import { useEffect, useRef, useState, type RefObject } from 'react';
import { MessageCircle } from 'lucide-react';

import type { ArtifactThumbnailSource } from '@/pages/artifactThumbnail';
import { ArtifactThumbnailView } from '@/pages/ArtifactCard';
import type { CommonGroundClient } from './client';
import { galleryAuthor, galleryKind, galleryThumbnailKind } from './galleryFormat';
import { GalleryMenu, GalleryTypeTile } from './GalleryParts';
import { CgAvatar } from './parts';
import type { CgGalleryItem } from './types';
import { useGalleryThumbnailUrl } from './useGalleryContent';

/** Starts reading an image card's file once the card is near the viewport. */
function useNearViewport(ref: RefObject<HTMLElement | null>) {
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

/**
 * One Gallery card: a 4:3 thumbnail drawn from the preview text like the chat Artifacts cards (an
 * image reads its file; other files show their type tile), the title, who shared it and the comment
 * count. My own cards add More › Remove from gallery on hover.
 */
export function GalleryCard({ code, item, client, removing, onOpen, onRemove }: {
  code: string;
  item: CgGalleryItem;
  client: Pick<CommonGroundClient, 'galleryContent'>;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const near = useNearViewport(ref);
  const kind = galleryKind(item.fileName, item.contentType);
  const imageUrl = useGalleryThumbnailUrl(client, code, item.itemId, near && kind === 'image');
  const textKind = galleryThumbnailKind(item.fileName, kind);
  const thumbnail: ArtifactThumbnailSource | null = kind === 'image'
    ? (imageUrl ? { kind: 'image', source: imageUrl } : null)
    : textKind && item.preview ? { kind: textKind, source: item.preview } : null;
  const tile = { fileName: item.fileName, contentType: item.contentType };
  return (
    <div className="cg-gallery-card" data-cg-gallery-item={item.itemId}>
      <button ref={ref} type="button" className="cg-gallery-card-open" onClick={onOpen} title={item.title}>
        <span className="cg-gallery-thumb">
          {thumbnail ? (
            <>
              <ArtifactThumbnailView thumbnail={thumbnail} path={item.fileName} />
              <GalleryTypeTile {...tile} size="chip" />
            </>
          ) : <GalleryTypeTile {...tile} size="large" />}
        </span>
        <span className="cg-gallery-card-title">{item.title}</span>
        <span className="cg-gallery-card-meta">
          <CgAvatar person={item.person} size={14} />
          <span className="cg-gallery-card-who">{galleryAuthor(item)}</span>
          {item.commentCount > 0 ? (
            <span className="cg-gallery-count" aria-label={`${item.commentCount} ${item.commentCount === 1 ? 'comment' : 'comments'}`}>
              <MessageCircle className="h-3 w-3" aria-hidden="true" />
              {item.commentCount}
            </span>
          ) : null}
        </span>
      </button>
      {item.mine ? <GalleryMenu className="is-card" items={[{ label: 'Remove from gallery', onSelect: onRemove, disabled: removing }]} /> : null}
    </div>
  );
}
