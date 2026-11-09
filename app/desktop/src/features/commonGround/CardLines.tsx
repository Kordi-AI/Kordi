import { useState } from 'react';
import { ArrowUpRight, Eye, EyeOff, Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { openExternalMessageLink, safeExternalHttpHref } from '@/kordi-app/components/messageLinks';
import { topicTone } from './format';
import { cardAnchor, isNotesSource, refMeta, seenLine, sourceLook, topicRefs, type CardRef } from './cardReferences';
import { CgTag } from './parts';
import type { CgEvidence, CgOwnCard } from './types';

export const TOPIC_MAX_CHARS = 40;

/** The words on a reference's chip: its title, or for a note its own words. */
function chipLabel(item: CgEvidence): string {
  const title = item.title.trim();
  if (title && !isNotesSource(item.source)) return title;
  return item.snippet.trim() || title || item.source;
}

/** One reference opened under the chips: title, where and when, its words, and Open for a web page. */
function RefDetail({ id, item, panelId }: CardRef & { panelId: string }) {
  const { title, rest } = refMeta(item);
  const words = item.snippet.trim();
  const href = item.url ? safeExternalHttpHref(item.url) : null;
  return (
    <div className="cg-ref-detail" id={panelId} data-ref={id}>
      {title ? <div className="cg-ref-detail-title">{title}</div> : null}
      {rest ? <div className="cg-ref-detail-meta">{rest}</div> : null}
      {words && words !== title ? <p className="cg-ref-detail-words">{words}</p> : null}
      {href ? (
        <a className="cg-ref-link" href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={(event) => openExternalMessageLink(event, href)}>
          Open
          <ArrowUpRight className="cg-ref-arrow" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

/** A topic's references as chips; clicking one opens its detail below, clicking it again closes it. */
function RefChips({ topic, refs }: { topic: string; refs: CardRef[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const panelId = `${cardAnchor('topic', topic)}-ref`;
  const open = refs.find((ref) => ref.id === openId) ?? null;
  return (
    <div className="cg-line-refs">
      <div className="cg-ref-chips">
        {refs.map(({ id, item }) => {
          const { Icon } = sourceLook(item.source);
          const label = chipLabel(item);
          const expanded = id === openId;
          return (
            <button
              key={id}
              type="button"
              className="cg-ref-chip"
              title={label}
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              onClick={() => setOpenId(expanded ? null : id)}
            >
              <Icon className="cg-ref-glyph" aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      {open ? <RefDetail {...open} panelId={panelId} /> : null}
    </div>
  );
}

/** One topic: its tag, when it was seen, Hide and Remove on hover, then its references. */
export function CardLine({ card, topic, onHide, onRemove }: {
  card: CgOwnCard;
  topic: string;
  onHide: () => void;
  onRemove: () => void;
}) {
  const hidden = card.hidden.includes(topic);
  const refs = topicRefs(card, topic);
  const seen = seenLine(card, topic);
  return (
    <div className={cn('cg-line', hidden && 'is-off')} id={cardAnchor('topic', topic)}>
      <div className="cg-line-head">
        <CgTag topic={topic} muted={hidden} small />
        {seen ? <span className="cg-line-seen">{seen}</span> : <span className="cg-line-seen" />}
        <button type="button" className="cg-line-act" aria-pressed={hidden} aria-label={hidden ? `Show ${topic}` : `Hide ${topic}`} onClick={onHide}>
          {hidden ? <Eye className="h-[13px] w-[13px]" aria-hidden="true" /> : <EyeOff className="h-[13px] w-[13px]" aria-hidden="true" />}
          {hidden ? 'Show' : 'Hide'}
        </button>
        <button type="button" className="cg-line-act is-icon" aria-label={`Remove ${topic}`} onClick={onRemove}>
          <X className="h-[13px] w-[13px]" aria-hidden="true" />
        </button>
      </div>
      {refs.length ? <RefChips topic={topic} refs={refs} /> : null}
    </div>
  );
}

/** "+ Add" at the end of a section: type a topic, Enter adds it. */
export function AddTopic({ onAdd }: { onAdd: (topic: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (!editing) {
    return (
      <button type="button" className="cg-line-add" onClick={() => setEditing(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add
      </button>
    );
  }
  const commit = () => {
    const topic = text.replace(/\s+/g, ' ').trim();
    setEditing(false);
    setText('');
    if (topic) onAdd(topic);
  };
  return (
    <span className={cn('cg-line-add is-editing', `tone-${topicTone(text || 'x')}`)}>
      <input
        autoFocus
        value={text}
        maxLength={TOPIC_MAX_CHARS}
        placeholder="New topic"
        aria-label="New topic"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            event.stopPropagation();
            setEditing(false);
            setText('');
          }
        }}
      />
      {text.length >= TOPIC_MAX_CHARS - 10 ? <span className="cg-count">{text.length}/{TOPIC_MAX_CHARS}</span> : null}
    </span>
  );
}
