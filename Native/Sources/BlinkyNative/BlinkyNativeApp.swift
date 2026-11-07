import SwiftUI

@main
struct BlinkyNativeApp: App {
    @State private var store = ConversationStore()

    var body: some Scene {
        Window("BlinkyBot", id: "main") {
            ContentView(store: store)
                .task { await store.start() }
        }
        .commands {
            SidebarCommands()
            CommandGroup(after: .newItem) {
                Button("创建 Bot") { store.showCreateBot = true }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                    .disabled(!store.connected)
                Button("管理当前 Bot") { store.showSelectedBot = true }
                    .keyboardShortcut("i", modifiers: .command)
                    .disabled(!store.connected || store.selectedBotID == nil)
            }
            CommandGroup(after: .sidebar) {
                Button("重新读取") { Task { await store.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
        Settings { NativeSettingsView(store: store) }
    }
}
