import SwiftUI

/// A calendar event the System agent wrote for a confirmed plan; its id names the plan card.
enum DigestPlanEvent {
    static let prefix = "plan:"

    static func cardId(_ event: DigestCalendarEvent) -> String? {
        guard event.id.hasPrefix(prefix) else { return nil }
        let id = String(event.id.dropFirst(prefix.count))
        return id.isEmpty ? nil : id
    }
}

extension AppModel {
    /// The live plan behind a card event, or nil when it cannot be read: signed out, offline,
    /// or no longer in the chat. The server answers only for active members.
    func digestPlanCard(_ cardId: String) async -> PlanCard? {
        guard !isPreviewMode, let (api, token, _) = try? digestContext() else { return nil }
        return try? await api.planCard(token: token, eventID: cardId)
    }

    /// Answers the plan as the signed-in member and returns the updated card.
    func answerDigestPlan(_ card: PlanCard, going: Bool) async throws -> PlanCard {
        let (api, token, accountId) = try digestContext()
        return try await api.planCardAction(token: token, action: .rsvp(card, accountId: accountId, going: going))
    }

    /// Answers "Can't make it", then drops the row at once. The server removes it too when it
    /// applies the answer, so a row that is already gone is not an error.
    func beginDecliningDigestPlan(_ event: DigestCalendarEvent, card: PlanCard) throws -> Task<Void, Error> {
        let (api, token, accountId) = try digestContext()
        return try beginDigestMutation(.removal(key: "event:\(event.id)", eventIDs: [event.id]), token: token, accountId: accountId) {
            _ = try await api.planCardAction(token: token, action: .rsvp(card, accountId: accountId, going: false))
            do { try await api.removeDigestEvent(token: token, event: event) } catch let error as CloudAPIError where error.statusCode == 409 {}
        }
    }
}

/// Who is going, who can't make it and who has not replied, with the member's own answer.
struct DigestPlanPeopleSection: View {
    let card: PlanCard
    let accountId: String
    let busy: Bool
    let onYes: () -> Void
    let onNo: () -> Void

    var body: some View {
        let (going, declined, waiting) = card.attendance
        let me = card.participant(accountId)
        Section {
            ForEach([("Going", going), ("Can't make it", declined), ("No reply", waiting)], id: \.0) { title, people in
                if !people.isEmpty {
                    Text(title).font(.caption).foregroundStyle(.secondary)
                    ForEach(people) { person in row(person) }
                }
            }
            if let me, !me.organizer, card.state != .canceled {
                HStack(spacing: 10) {
                    answer("Can't make it", systemImage: "xmark", selected: me.rsvp == .no, action: onNo)
                    answer("I'm in", systemImage: "checkmark", selected: me.rsvp == .yes) { if me.rsvp != .yes { onYes() } }
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("People").foregroundStyle(.primary)
                Text(PlanCard.countsLine(going: going.count, declined: declined.count, waiting: waiting.count)).foregroundStyle(.secondary)
            }
            .font(SettingsFont.sectionTitle)
            .textCase(nil)
        }
    }

    private func row(_ person: PlanCardParticipant) -> some View {
        HStack(spacing: 10) {
            IdentityAvatar(name: person.displayName, imageSource: person.avatarUrl?.nonEmpty, kind: .person, size: 28, seed: person.participantId)
            Text(person.participantId == accountId ? "\(person.displayName) (you)" : person.displayName).lineLimit(1)
            Spacer(minLength: 8)
            if person.organizer { Text("Organizer").font(.caption).foregroundStyle(.secondary) }
        }
    }

    /// Selected answers use a neutral fill, never the accent.
    private func answer(_ title: String, systemImage: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(selected ? Color(uiColor: .systemGray5) : .clear, in: Capsule())
                .overlay(Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: selected ? 0 : 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
