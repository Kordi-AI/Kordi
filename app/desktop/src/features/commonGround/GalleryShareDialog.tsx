import { useId, useState } from 'react';
import { Check, Search } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { GalleryTypeTile } from './GalleryParts';
import { CgButton, CgNotice, CgProgress } from './parts';
import { GALLERY_SHARE_MAX } from './storeGallery';
import type { CgGalleryCandidate } from './types';
import { shortDay } from './wallet';

function matches(candidate: CgGalleryCandidate, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = `${candidate.title} ${candidate.fileName}`.toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * "Share to Build night": my own artifacts with search, up to eight picked (those already in the
 * Gallery show Shared), a room topic or None, then Share (Share 2 for two). `candidates` is
 * undefined while they load.
 */
export function GalleryShareDialog({ roomName, topics, candidates, loading, busy, notice, onCancel, onShare }: {
  roomName: string;
  topics: string[];
  candidates: CgGalleryCandidate[] | undefined;
  loading: boolean;
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onShare: (attachmentIds: string[], topic: string | null) => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const all = candidates ?? [];
  const shown = all.filter((candidate) => matches(candidate, query));
  const full = picked.length >= GALLERY_SHARE_MAX;
  const toggle = (id: string) => setPicked((current) => (
    current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= GALLERY_SHARE_MAX ? current : [...current, id]
  ));
  const submit = () => { if (picked.length && !busy) onShare(picked, topic || null); };

  let list;
  if (loading && candidates === undefined) list = <CgProgress line="Loading" inline />;
  else if (!shown.length) list = <div className="cg-pick-empty cg-muted">{all.length ? 'No matches' : 'No artifacts yet'}</div>;
  else {
    list = (
      <div className="cg-pick-list cg-gallery-picks" role="group" aria-label="Your artifacts">
        {shown.map((candidate) => {
          const on = picked.includes(candidate.attachmentId);
          return (
            <button
              key={candidate.attachmentId}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={candidate.shared || busy || (full && !on)}
              className={cn('cg-pick', on && 'is-on')}
              onClick={() => toggle(candidate.attachmentId)}
            >
              <GalleryTypeTile fileName={candidate.fileName} contentType={candidate.contentType} />
              <span className="cg-row-text">
                <span className="cg-row-title">{candidate.title}</span>
                <span className="cg-row-sub">{shortDay(candidate.updatedAt)}</span>
              </span>
              {candidate.shared
                ? <span className="cg-pick-state">Shared</span>
                : <span className="cg-check" aria-hidden="true">{on ? <Check className="h-3.5 w-3.5" /> : null}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>{`Share to ${roomName}`}</AppDialogTitle>
      <form className="cg-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="cg-gallery-search">
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <input type="search" value={query} placeholder="Search" aria-label="Search your artifacts" onChange={(event) => setQuery(event.target.value)} />
        </label>
        {list}
        <label className="cg-gallery-topic">
          <span>Topic</span>
          <select className="cg-gallery-select" value={topic} aria-label="Topic" onChange={(event) => setTopic(event.target.value)}>
            <option value="">None</option>
            {topics.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        <CgNotice text={notice} />
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !picked.length}>{picked.length > 1 ? `Share ${picked.length}` : 'Share'}</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
