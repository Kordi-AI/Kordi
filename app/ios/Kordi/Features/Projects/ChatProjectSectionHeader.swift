import SwiftUI

/// Header of one project in the Agents list. A project that only offline Macs
/// publish can be removed with a swipe or the context menu.
struct ChatProjectSectionHeader: View {
    @EnvironmentObject private var model: AppModel
    let section: ChatProjectSessionSection
    let project: ChatProject
    @Binding var isCollapsed: Bool
    @Binding var activeSwipeRowID: String?
    @State private var confirmsRemove = false

    var body: some View {
        Group {
            if section.removable {
                header
                    .contextMenu {
                        Button("Remove", systemImage: "trash", role: .destructive) { confirmsRemove = true }
                    }
                    .circularChatSwipeActions(
                        rowID: section.id,
                        activeRowID: $activeSwipeRowID,
                        trailing: [
                            ChatCircularSwipeAction(id: "remove", label: "Remove", systemImage: "trash", color: .red, role: .destructive) {
                                confirmsRemove = true
                            },
                        ]
                    )
                    .accessibilityAction(named: "Remove") { confirmsRemove = true }
            } else {
                header
            }
        }
        .confirmationDialog("Remove \(project.name)?", isPresented: $confirmsRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { remove() }
        } message: {
            Text("Its files stay on that Mac.")
        }
    }

    private var header: some View {
        Button {
            isCollapsed.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary).frame(width: 16)
                Image(systemName: "folder").font(.system(size: 20)).foregroundStyle(.tint)
                Text(project.name).font(.body.weight(.semibold)).lineLimit(1)
                Spacer()
                if !section.online { Text("Offline").font(.footnote).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
    }

    private func remove() {
        let section = section
        Task {
            do {
                try await model.removeOfflineProject(section)
            } catch {
                model.projectError = error.localizedDescription
            }
        }
    }
}
