import { Braces, FileText, Globe2, type LucideIcon } from 'lucide-react';

import type { ConversationParticipant, SessionArtifact } from '@/kordi-app/types';

export type FileBadge = { icon: LucideIcon; label: string; className: string };

function extensionOf(path: string) {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return extension === 'markdown' ? 'md' : extension;
}

/** The colored file-type mark at the start of a row. */
export function artifactFileBadge(artifact: Pick<SessionArtifact, 'kind' | 'path'>): FileBadge {
  const extension = extensionOf(artifact.path);
  if (extension === 'html' || extension === 'htm') return { icon: Globe2, label: 'HTML', className: 'bg-orange-500/15 text-orange-500' };
  if (extension === 'md' || extension === 'mdx') return { icon: FileText, label: 'Markdown', className: 'bg-sky-500/15 text-sky-500' };
  if (artifact.kind === 'code') return { icon: Braces, label: 'Code', className: 'bg-violet-500/15 text-violet-500' };
  return { icon: FileText, label: 'File', className: 'bg-slate-500/15 text-[color:var(--utility-muted-text)]' };
}

function isPerson(participant: ConversationParticipant) {
  return participant.kind !== 'agent';
}

function matchesAccount(participant: ConversationParticipant, accountId: string) {
  return participant.id === accountId || participant.humanId === accountId || participant.sourceIdentityId === accountId;
}

/** The creator first, then the other people of the conversation. */
export function artifactPeople(artifact: Pick<SessionArtifact, 'createdByAccountId'>, participants: ConversationParticipant[]) {
  const people = participants.filter(isPerson);
  const accountId = artifact.createdByAccountId?.trim();
  const creator = accountId ? people.find((participant) => matchesAccount(participant, accountId)) ?? null : null;
  return { creator, others: creator ? people.filter((participant) => participant !== creator) : [] };
}
