import SwiftUI

struct FacilitatorCardView: View {
    let snapshot: FacilitatorCard
    let accountId: String?
    let request: (UUID, FacilitatorCardAction?) async throws -> FacilitatorCard

    @Environment(\.scenePhase) private var scenePhase
    @State private var response: FacilitatorCard?
    @State private var viewerId: String?
    @State private var busy = false
    @State private var failure: String?

    private struct RefreshKey: Equatable {
        let cardId: UUID
        let revision: Int
        let accountId: String?
        let active: Bool
    }

    private var personal: FacilitatorCard? {
        guard viewerId == accountId, let response, response.id == snapshot.id else { return nil }
        return response
    }

    private var card: FacilitatorCard {
        guard let personal, personal.revision >= snapshot.revision else { return snapshot }
        return personal
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card.kind.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Text(card.title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            if let detail = card.detail?.nonEmpty {
                Text(detail).font(.subheadline)
            }
            if let name = card.assigneeName, card.kind == .task {
                Text("Assigned to \(name)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let status = card.status {
                Text(status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("facilitator-card-status")
            }
            actions
                .disabled(busy)
            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(card.kind.label)
        .task(id: RefreshKey(cardId: snapshot.id, revision: snapshot.revision, accountId: accountId, active: scenePhase == .active)) {
            guard accountId != nil, scenePhase == .active else { return }
            await refresh()
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch card.kind {
        case .decision:
            ForEach(card.options.indices, id: \.self) { index in
                let count = card.counts.indices.contains(index) ? card.counts[index] : 0
                let selected = personal?.myVote == index
                Button {
                    perform(.init(action: "vote", revision: card.revision, option: index))
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Text(card.options[index])
                            .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .trailing, spacing: 2) {
                            if selected { Text("Your vote") }
                            Text(count == 1 ? "1 vote" : "\(count) votes")
                        }
                        .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.bordered)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .disabled(accountId == nil || card.result != nil)
            }
            if card.result == nil, let accountId, card.managerIds.contains(accountId), let winner = card.winningOption {
                Button("Confirm decision") {
                    perform(.init(action: "confirm", revision: card.revision, option: winner))
                }
                .buttonStyle(.borderedProminent)
            }
        case .memory:
            if accountId != nil, card.result == nil {
                Button("Save to group Memory") {
                    perform(.init(action: "save_memory", revision: card.revision))
                }
                .buttonStyle(.borderedProminent)
            }
        case .task:
            if card.canApprove(accountId: accountId) {
                Button("Approve and run my agent") { perform(.init(action: "approve")) }
                    .buttonStyle(.borderedProminent)
                Button("Decline assignment") { perform(.init(action: "decline")) }
                    .buttonStyle(.bordered)
            }
        }
    }

    private func refresh() async {
        guard let accountId, let latest = try? await request(snapshot.id, nil), !Task.isCancelled else { return }
        accept(latest, for: accountId)
    }

    private func perform(_ action: FacilitatorCardAction) {
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
                failure = error.localizedDescription
                await refresh()
            }
        }
    }

    private func accept(_ latest: FacilitatorCard, for accountId: String) {
        guard latest.id == snapshot.id, latest.revision >= (personal?.revision ?? 0) else { return }
        viewerId = accountId
        response = latest
    }
}
