import SwiftUI

/// Searchable list of time zones. "Automatic" (an empty selection) follows
/// this iPhone's time zone, which it names.
struct TimeZonePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private struct Zone: Identifiable {
        let id: String
        let name: String
        let offset: String
    }

    private static let zones: [Zone] = TimeZone.knownTimeZoneIdentifiers.compactMap { identifier in
        guard let zone = TimeZone(identifier: identifier) else { return nil }
        return Zone(id: identifier, name: ProfileFormatting.timeZoneName(zone), offset: ProfileFormatting.gmtOffset(zone))
    }

    private var filtered: [Zone] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return Self.zones }
        return Self.zones.filter {
            $0.id.localizedCaseInsensitiveContains(text)
                || $0.name.localizedCaseInsensitiveContains(text)
                || $0.offset.localizedCaseInsensitiveContains(text)
        }
    }

    var body: some View {
        List {
            if query.isEmpty {
                choice(id: "", selected: selection.isEmpty) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Automatic")
                            .font(SettingsFont.rowTitle)
                        Text(ProfileFormatting.timeZoneLabel(TimeZone.current.identifier) ?? TimeZone.current.identifier)
                            .font(SettingsFont.subtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            ForEach(filtered) { zone in
                choice(id: zone.id, selected: selection == zone.id) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(zone.name), \(zone.offset)")
                            .font(SettingsFont.rowTitle)
                        Text(zone.id)
                            .font(SettingsFont.subtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        .navigationTitle("Time zone")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func choice<Label: View>(id: String, selected: Bool, @ViewBuilder label: () -> Label) -> some View {
        Button {
            selection = id
            dismiss()
        } label: {
            HStack {
                label()
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(KordiTheme.profileAccent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
