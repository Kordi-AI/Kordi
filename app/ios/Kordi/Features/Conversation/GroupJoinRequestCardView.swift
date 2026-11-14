import SwiftUI

/// "<Name> asked to join" in a group started from a Grounding room. Approvers
/// answer here; everyone else sees where the request stands. The card loads
/// the current state when shown and keeps the newest revision it has seen.
struct GroupJoinRequestCardView: View {
    let snapshot: GroupJoinRequestCard
    let accountId: String?
    /// A member's name for an account id, when the group lists them.
    let memberName: (String) -> String?
    let request: (String, String?) async throws -> GroupJoinRequestCard

    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var response: GroupJoinRequestCard?
    @State private var viewerId: String?
    @State private var busy = false
    @State private var failure: String?

    private struct RefreshKey: Equatable {
        let requestId: String
        let revision: Int
        let accountId: String?
        let active: Bool
    }

    private var latest: GroupJoinRequestCard? {
        guard viewerId == accountId, let response, response.id == snapshot.id else { return nil }
        return response
    }

    private var card: GroupJoinRequestCard {
        guard let latest, latest.revision >= snapshot.revision else { return snapshot }
        return latest
    }

    private var requesterName: String { card.requester?.displayName ?? "Someone" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IdentityAvatar(
                    name: requesterName,
                    imageSource: card.requester?.avatarUrl,
                    kind: .person,
                    size: 30,
                    seed: card.requester?.accountId
                )
                .clipShape(Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(requesterName) asked to join")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    if let room = card.roomName.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
                        Text("From \(room)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            footer
                .frame(maxWidth: .infinity, alignment: .trailing)
            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: 270)
        .background(chatTheme.peerBubble, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .task(id: RefreshKey(requestId: snapshot.id, revision: snapshot.revision, accountId: accountId, active: scenePhase == .active)) {
            guard accountId != nil, scenePhase == .active else { return }
            await refresh()
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch card.status {
        case "pending":
            if card.canDecide(accountId: accountId) {
                HStack(spacing: 8) {
                    Button("Decline") { perform("decline") }
                        .buttonStyle(.bordered)
                        .tint(Color.primary)
                    Button("Approve") { perform("approve") }
                        .buttonStyle(.borderedProminent)
                }
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(busy)
            } else {
                state(waitingLine)
            }
        case "approved":
            state(card.decidedBy.map { "Approved by \($0.firstName)" } ?? "Approved", color: .green)
        case "declined":
            state("Declined")
        case "cancelled":
            state("Withdrawn")
        default:
            EmptyView()
        }
    }

    /// "Waiting for Alex" when one member approves, "Waiting for a member"
    /// when any member can.
    private var waitingLine: String {
        let approvers = card.approverIds.filter { $0 != card.requester?.accountId }
        if approvers.count > 1 { return "Waiting for a member" }
        if let only = approvers.first, let name = memberName(only)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            return "Waiting for \(name.split(separator: " ").first.map(String.init) ?? name)"
        }
        return "Waiting for approval"
    }

    private func state(_ text: String, color: Color = .secondary) -> some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(color)
            .accessibilityIdentifier("group-join-request-status")
    }

    private func refresh() async {
        guard let accountId, let latest = try? await request(snapshot.id, nil), !Task.isCancelled else { return }
        accept(latest, for: accountId)
    }

    private func perform(_ action: String) {
        guard !busy, let accountId else { return }
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                accept(try await request(snapshot.id, action), for: accountId)
            } catch is CancellationError {
                return
            } catch {
                let message = error.localizedDescription
                await refresh()
                // An answer someone else already gave is shown by the card itself.
                if card.isPending { failure = message }
            }
        }
    }

    private func accept(_ next: GroupJoinRequestCard, for accountId: String) {
        guard next.id == snapshot.id, next.revision >= (latest?.revision ?? 0) else { return }
        viewerId = accountId
        response = next
    }
}
