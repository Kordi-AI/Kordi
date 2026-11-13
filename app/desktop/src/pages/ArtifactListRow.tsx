
import { ArrowUpRight } from 'lucide-react';

import { fetchDocumentTitleFromServer } from '@/features/documents/documentPreviewTitles';
import { documentDisplayName, useDocumentTitle, type DocumentTitleFetch } from '@/features/documents/documentTitles';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { ConversationParticipant, SessionArtifact } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

import { artifactFileBadge, artifactPeople } from './artifactRowModel';

export function PersonAvatar({ participant, className }: { participant: ConversationParticipant; className: string }) {
  const name = participant.publicName?.trim() || participant.name;
  return <IdentityAvatar kind="human" seed={participant.avatarKey ?? participant.humanId ?? participant.id} name={name} imageUrl={participant.profileImageUrl} className={className} />;
}

export function ArtifactListRow({ artifact, location, isActive, participants, onSelect, onOpenExternal, fetchTitle = fetchDocumentTitleFromServer }: {
  artifact: SessionArtifact;
  location: string;
  isActive: boolean;
  participants: ConversationParticipant[];
  onSelect: () => void;
  /** Opens the file in its default app; the arrow shows on hover when given. */
  onOpenExternal?: () => void;
  /** Asks the server for the title of a cloud document none of the readers reported yet. */
  fetchTitle?: DocumentTitleFetch;
}) {
  // A renamed cloud document shows its title; the file name stays in the tooltip.
  const title = useDocumentTitle(artifact.attachmentId, artifact.name, fetchTitle);
  const label = documentDisplayName(artifact.name, title);
  const badge = artifactFileBadge(artifact);
  const BadgeIcon = badge.icon;
  const { creator, others } = artifactPeople(artifact, participants);
  const creatorName = creator ? creator.publicName?.trim() || creator.name : null;
  // Inside a conversation the creator says more than "Shared in <group>".
  const meta = [location, creator ? null : artifact.summary, artifact.live ? 'Live' : artifact.timeLabel].filter(Boolean).join(' · ');

  // One compact line: the name, the open arrow beside it, a muted detail, people on the right. The
  // name's button stretches a click area over the whole row, so clicking the detail or the people
  // still opens the artifact, and the arrow sits above that area. The row fills the column, so its
  // fill lines up with the toolbar above it.
  return (
    <div
      data-artifact-row-shell=""
      className={cn(
        'group relative flex min-w-0 items-center gap-1 rounded-md py-1.5 pr-2 pl-[9px] transition-colors',
        isActive ? 'bg-[color:var(--app-control-bg)]' : 'hover:bg-[color:var(--app-control-hover)]',
      )}
    >
      <button
        type="button"
        data-artifact-file-row="true"
        aria-current={isActive ? 'true' : undefined}
        onClick={onSelect}
        className="flex min-w-0 max-w-[65%] shrink items-center gap-2.5 text-left after:absolute after:inset-0 after:rounded-md after:content-['']"
      >
        <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-[5px]', badge.className)} title={badge.label}>
          <BadgeIcon className="h-3 w-3" aria-hidden="true" />
        </span>
        <span data-artifact-row-title="" className="min-w-0 truncate text-[13px] leading-5 text-[color:var(--utility-foreground)]" title={label === artifact.name ? undefined : artifact.name}>{label}</span>
      </button>
      {onOpenExternal ? (
        <button
          type="button"
          data-artifact-open-external=""
          aria-label={`Open ${label} in its default app`}
          title="Open in default app"
          onClick={onOpenExternal}
          className="relative z-10 -my-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-[color:var(--utility-muted-text)] opacity-0 transition-opacity hover:bg-[color-mix(in_srgb,var(--utility-foreground)_10%,transparent)] hover:text-[color:var(--utility-foreground)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {artifact.pinned ? <span className="shrink-0 rounded-[4px] bg-amber-400/15 px-1 text-[10.5px] leading-4 text-amber-600">Pinned</span> : null}
      <span data-artifact-row-meta="" className="min-w-0 flex-1 truncate pl-1.5 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">{meta}</span>
      {creator || others.length > 0 ? (
        <span className="flex min-w-0 shrink-[2] items-center gap-1.5 pl-2 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">
          {creator && creatorName ? (
            <span className="flex min-w-0 items-center gap-1.5" data-artifact-creator="true" title={`Created by ${creatorName}`}>
              <PersonAvatar participant={creator} className="h-4 w-4 shrink-0" />
              <span className="truncate">{creatorName}</span>
            </span>
          ) : null}
          {others.length > 0 ? (
            <span className="flex shrink-0 items-center" data-artifact-participants="true" title={others.map((person) => person.publicName?.trim() || person.name).join(', ')}>
              {others.slice(0, 3).map((person, index) => (
                <PersonAvatar key={person.id} participant={person} className={cn('h-3.5 w-3.5 opacity-80 ring-2 ring-[color:var(--app-shell-bg,transparent)]', index > 0 && '-ml-1')} />
              ))}
              {others.length > 3 ? <span className="pl-1">+{others.length - 3}</span> : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
