import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import type { Contact, DesktopCollaborationHost } from '@/kordi-app/types';
import { getInitials } from '@/kordi-app/utils';

import { collaborationProfileImageUrl, sanitizeRemotePeerName } from './collaborationLabels';
import { collaborationPeerIsApprovedContact, collaborationPeerIsReachableAgent } from './helpers';

/**
 * Adds a collaboration host's approved peers to the contact directory: one entry per person
 * and per reachable agent, plus an owner entry for each agent with an owner name.
 */
export function addCollaborationPeerContacts(
  byId: Map<string, Contact>,
  host: DesktopCollaborationHost,
  label: string,
) {
  for (const peer of host.visiblePeers) {
    if (!collaborationPeerIsApprovedContact(peer)) continue;
    const isAgent = isCollaborationAgentRuntime(peer.runtime);
    const contactStatus = peer.isContact ? 'contact' : (peer.contactRequestStatus?.trim() || 'none');
    const contactRequestDirection = peer.contactRequestDirection?.trim() || null;
    if (!isAgent || collaborationPeerIsReachableAgent(peer)) {
      const id = isAgent
        ? `collaboration-peer-agent:${peer.nodeId}:${peer.agentId ?? peer.runtime}`
        : `collaboration-peer-person:${peer.nodeId}:${peer.humanId ?? 'person'}`;
      const existing = byId.get(id);
      const nextDiscoveryLabels = Array.from(new Set([...(existing?.collaborationSources ?? []), label])).sort();
      const peerName = sanitizeRemotePeerName(peer.displayName, peer.ownerName, peer.humanId, peer.nodeId);
      byId.set(id, {
        id,
        name: peerName,
        initials: getInitials(peerName),
        classType: isAgent ? 'other-users-agents' : 'other-users',
        entityType: isAgent ? 'External agent' : 'Person',
        subtitle: peer.sharedProjects.length > 0 ? `${peer.runtime} • ${peer.sharedProjects.length} shared project${peer.sharedProjects.length === 1 ? '' : 's'}` : peer.runtime,
        collaborationSources: nextDiscoveryLabels,
        status: host.connected ? 'Reachable' : 'Offline',
        discoverableOn: nextDiscoveryLabels,
        detail: [peer.nodeId, peer.endpoint, peer.sharedProjects.length > 0 ? `Shared projects: ${peer.sharedProjects.join(' • ')}` : null].filter(Boolean).join(' • '),
        owner: peer.ownerName || 'Unknown',
        sourceHostId: host.id,
        sourceParticipantId: peer.nodeId,
        sourceRuntime: peer.runtime,
        sourceHumanId: peer.humanId,
        sourceAgentId: peer.agentId,
        contactStatus,
        contactRequestDirection,
        avatarSeed: isAgent ? (peer.agentId || peer.nodeId) : (peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId),
        profileImageUrl: collaborationProfileImageUrl(peer.profileImageUrl),
      });
    }

    if (isAgent && peer.ownerName && (collaborationPeerIsReachableAgent(peer) || peer.isDefaultAgent)) {
      const personId = `collaboration-peer-person:${peer.nodeId}:${peer.humanId ?? peer.ownerName}`;
      const existingPerson = byId.get(personId);
      const personDiscoveryLabels = Array.from(new Set([...(existingPerson?.collaborationSources ?? []), label])).sort();
      const personName = sanitizeRemotePeerName(peer.ownerName, peer.humanId, peer.nodeId);
      byId.set(personId, {
        id: personId,
        name: personName,
        initials: getInitials(personName),
        classType: 'other-users',
        entityType: 'Person',
        subtitle: `Owner of ${peer.displayName || 'external agent'}`,
        collaborationSources: personDiscoveryLabels,
        status: host.connected ? 'Reachable' : 'Offline',
        discoverableOn: personDiscoveryLabels,
        detail: [peer.humanId ? `Human ID: ${peer.humanId}` : null, peer.nodeId, peer.displayName ? `Agent: ${peer.displayName}` : null].filter(Boolean).join(' • '),
        owner: peer.ownerName,
        sourceHostId: host.id,
        sourceParticipantId: peer.nodeId,
        sourceRuntime: 'person',
        sourceHumanId: peer.humanId,
        sourceAgentId: peer.agentId,
        contactStatus,
        contactRequestDirection,
        // The peer is the agent, so its picture and seed belong to the agent. Keep the owner's
        // own picture from their person peer, or none.
        avatarSeed: existingPerson?.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId,
        profileImageUrl: existingPerson?.profileImageUrl ?? null,
      });
    }
  }
}
