import { ArrowLeft, CheckCheck } from 'lucide-react';

import {
  SEEN_BY_LIST_LIMIT,
  seenRowState,
  type MessageReader,
  type MessageReadersRequest,
  type MessageSeenBySource,
  type MessageSeenByTarget,
} from '@/features/chat/messageSeenBy';
import { useMessageReaders } from '@/features/chat/messageSeenByContext';
import { formatDesktopTranscriptTimeLabel } from '@/lib/time';
import { IdentityAvatar } from './IdentityAvatar';

function ReaderAvatar({ source, reader, className }: { source: MessageSeenBySource; reader: MessageReader; className: string }) {
  const person = source.person(reader.accountId);
  return (
    <IdentityAvatar
      kind="human"
      seed={person.avatarSeed ?? person.id}
      name={person.name}
      imageUrl={person.profileImageUrl}
      className={className}
    />
  );
}

function Faces({ source, readers }: { source: MessageSeenBySource; readers: MessageReader[] }) {
  return (
    <span className="app-message-seen-faces" aria-hidden="true">
      {readers.map((reader) => (
        <ReaderAvatar key={reader.accountId} source={source} reader={reader} className="h-4.5 w-4.5" />
      ))}
    </span>
  );
}

/** The last row of the message menu: loading, "Not seen yet", one reader, or "N Seen". */
export function MessageSeenByRow({
  source,
  request,
  autoFocus = false,
  onOpen,
}: {
  source: MessageSeenBySource;
  request: MessageReadersRequest | null;
  autoFocus?: boolean;
  onOpen: () => void;
}) {
  const state = seenRowState(request);
  const icon = <CheckCheck aria-hidden="true" />;
  if (state.kind === 'hidden') return null;
  if (state.kind === 'loading') {
    return (
      <div className="app-message-context-menu-seen app-dense-menu-label" data-message-context-menu-seen-row="loading" role="status" aria-label="Loading who has seen this">
        {icon}
        <span className="app-message-seen-skeleton app-message-seen-skeleton-text" />
        <span className="app-message-seen-faces" aria-hidden="true">
          <span className="app-message-seen-skeleton app-message-seen-skeleton-face" />
          <span className="app-message-seen-skeleton app-message-seen-skeleton-face" />
        </span>
      </div>
    );
  }
  if (state.kind === 'none') {
    return (
      <div className="app-message-context-menu-seen app-dense-menu-label" data-message-context-menu-seen-row="none">
        {icon}
        <span className="app-message-seen-label">Not seen yet</span>
      </div>
    );
  }
  const readers = state.kind === 'one' ? [state.reader] : state.readers;
  const names = readers.map((reader) => source.person(reader.accountId).name);
  const label = state.kind === 'one' ? names[0] : `${state.total} Seen`;
  return (
    <button
      type="button"
      role="menuitem"
      className="app-message-context-menu-seen app-dense-menu-label"
      data-message-context-menu-seen-row={state.kind}
      title={names.length > 0 ? `Seen by ${names.join(', ')}` : undefined}
      autoFocus={autoFocus}
      onClick={onOpen}
    >
      {icon}
      <span className="app-message-seen-label">{label}</span>
      {readers.length > 0 ? <Faces source={source} readers={readers} /> : null}
    </button>
  );
}

function readTimeLabel(readAt: string | null) {
  const timestampMs = readAt ? Date.parse(readAt) : Number.NaN;
  return Number.isFinite(timestampMs) ? formatDesktopTranscriptTimeLabel(timestampMs) : null;
}

/** Full readers list, a detail view of the same menu surface. It loads when opened. */
export function MessageSeenByReaders({
  source,
  target,
  placeholder,
  onBack,
}: {
  source: MessageSeenBySource;
  target: MessageSeenByTarget;
  /** Readers already shown in the row, kept while the full list loads or if it fails. */
  placeholder: MessageReader[];
  onBack: () => void;
}) {
  const request = useMessageReaders(source, target, SEEN_BY_LIST_LIMIT);
  const readers = request?.status === 'ready' ? request.page.readers : placeholder;
  return (
    <div data-message-context-menu-seen-list={request?.status ?? 'loading'}>
      <div className="app-dense-menu-header">
        <button type="button" aria-label="Back to message actions" autoFocus onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <strong className="app-dense-menu-title">Seen by</strong>
      </div>
      <div className="app-message-seen-readers" role="list" aria-label="Seen by">
        {readers.map((reader) => {
          const time = readTimeLabel(reader.readAt);
          return (
            <div key={reader.accountId} className="app-dense-menu-row" role="listitem" data-message-seen-reader={reader.accountId}>
              <ReaderAvatar source={source} reader={reader} className="h-5 w-5" />
              <span className="app-message-seen-label">{source.person(reader.accountId).name}</span>
              {time ? <span className="app-dense-menu-meta">{time}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
