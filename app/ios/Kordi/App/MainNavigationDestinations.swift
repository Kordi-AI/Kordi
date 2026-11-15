import SwiftUI

enum MainNavigationRoute: Hashable {
    case conversation(ConversationSummary)
    case group(GroupSpaceSummary)
    case message(KordiMessageNotificationRoute)
    case sessionDetails(ConversationSummary)
    case newChat(NewChatMode)
    case archived(ChatChannel)
    /// Always discoverable from Contacts; service availability is checked on entry.
    case commonGround
}

struct MainNavigationDestination: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.kordiChatTheme) private var chatTheme
    @Binding var path: [MainNavigationRoute]
    let route: MainNavigationRoute
    let selectedTab: MainTab

    var body: some View {
        if route == .commonGround {
            commonGround
        } else {
            standardScreen
        }
    }

    /// Common ground brings its own stack and round glass back button.
    @ViewBuilder private var commonGround: some View {
        CommonGroundDestinationView(
            appModel: model,
            onClose: { if path.last == .commonGround { path.removeLast() } },
            onOpenConversation: { path.append(.conversation($0)) }
        )
    }

    private var standardScreen: some View {
        NavigationStack {
            screen
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left") {
                            if !path.isEmpty { path.removeLast() }
                        }
                        .labelStyle(.iconOnly)
                    }
                }
        }
        .background {
            switch route {
            case .conversation, .message:
                KordiChatWallpaper(theme: chatTheme).ignoresSafeArea()
            default:
                Color.clear
            }
        }
    }

    @ViewBuilder private var screen: some View {
        switch route {
        case .conversation(let conversation):
            ConversationView(conversation: conversation, onOpenSessionDetails: openSessionDetails,
                onClosedChatDeleted: closeRoute)
                .task {
                    if selectedTab == .contacts {
                        _ = await model.restoreConversationIfNeeded(conversation)
                    }
                }
        case .group(let space):
            GroupSessionListView(space: space, onOpenConversation: { path.append(.conversation($0)) })
        case .message(let route):
            ConversationView(conversation: route.conversation, initialMessageID: route.messageID,
                onOpenSessionDetails: openSessionDetails, onClosedChatDeleted: closeRoute)
        case .sessionDetails(let conversation):
            ConversationDetailsPage(conversation: conversation) {
                if path.last == route { path.removeLast() }
            }
        case .newChat(.addContact):
            AddContactSearchView(onRequestSent: { if !path.isEmpty { path.removeLast() } })
                .navigationTitle(NewChatMode.addContact.navigationTitle)
                .navigationBarTitleDisplayMode(.inline)
        case .newChat(let mode):
            NewChatView(mode: mode) { path.append(.conversation($0)) }
        case .archived(let channel):
            ArchivedChatsView(channel: channel, onOpenConversation: { path.append(.conversation($0)) })
        case .commonGround:
            EmptyView()
        }
    }

    /// Pops this screen after Delete chat, and the group page under it when the group was left.
    private func closeRoute(_ deleted: ClosedChatDeleteTarget) {
        guard let index = path.lastIndex(of: route) else { return }
        var remaining = Array(path[..<index])
        if case .group = deleted, case .group? = remaining.last { remaining.removeLast() }
        path = remaining
    }

    private func openSessionDetails(_ conversation: ConversationSummary) {
        if case .sessionDetails(let current)? = path.last,
           current.sessionId == conversation.sessionId { return }
        path.append(.sessionDetails(conversation))
    }
}
