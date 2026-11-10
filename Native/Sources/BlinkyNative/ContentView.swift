import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @Bindable var store: ConversationStore
    @State private var drafts: [String: String] = [:]
    @State private var attachments: [String: [[String: String]]] = [:]
    @State private var selectingFiles = false
    @State private var showBotDetails = false
    @State private var editBot = false
    @State private var reviewInterrupted = false
    @State private var creatingBot = false
    @State private var botName = ""
    @State private var savingBot = false
    @State private var showMemory = false
    @State private var memoryText = ""
    @State private var removingMemory: MemoryRecord?
    @State private var removingBot = false

    private var selectedBot: Bot? { store.bots.first { $0.id == store.selectedBotID } }
    private var messages: [Message] {
        guard let bot = selectedBot else { return [] }
        return store.messages(for: bot)
    }

    var body: some View {
        NavigationSplitView {
            List(store.bots, selection: $store.selectedBotID) { bot in
                Label(bot.name, systemImage: "person.crop.circle")
                    .tag(bot.id)
            }
            .navigationTitle("Bot")
            .navigationSplitViewColumnWidth(min: 160, ideal: 220, max: 400)
            .toolbar {
                ToolbarItem {
                    Button("创建 Bot", systemImage: "plus") { botName = ""; creatingBot = true }
                        .disabled(!store.connected)
                }
            }
        } detail: {
            if let bot = selectedBot {
                VStack(spacing: nil) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading) {
                            ForEach(messages) { message in
                            VStack(alignment: .leading) {
                                Text(message.role == "user" ? "你" : message.role == "system" ? "系统" : bot.name)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if !message.content.isEmpty {
                                    Text((try? AttributedString(markdown: message.content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(message.content))
                                        .textSelection(.enabled)
                                }
                                ForEach(message.attachments ?? []) { attachment in
                                    if attachment.kind == "image", let mime = attachment.mime,
                                       ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime),
                                       let raw = attachment.data, raw.utf8.count <= 7_500_000,
                                       let data = Data(base64Encoded: raw), let image = NSImage(data: data) {
                                        Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 300)
                                            .accessibilityLabel(attachment.name)
                                    } else {
                                        Label(attachment.name, systemImage: "paperclip")
                                    }
                                }
                                if let error = message.error, error != message.content { Text(error).foregroundStyle(.secondary) }
                            }
                            .id(message.id)
                            Divider()
                            }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .defaultScrollAnchor(.bottom)
                        .onAppear { if let id = messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                        .onChange(of: messages.count) { _, _ in
                            guard let id = messages.last?.id else { return }
                            Task { @MainActor in await Task.yield(); proxy.scrollTo(id, anchor: .bottom) }
                        }
                    }
                    VStack(alignment: .leading) {
                        TextField("给 \(bot.name) 发消息", text: Binding(
                            get: { drafts[bot.id, default: ""] },
                            set: { drafts[bot.id] = $0 }
                        ), axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { send(bot) }
                            .onKeyPress("v", phases: .down) { event in
                                guard event.modifiers == .command else { return .ignored }
                                return pasteImage(botID: bot.id) ? .handled : .ignored
                            }
                        ForEach(attachments[bot.id, default: []], id: \.self) { attachment in
                            HStack {
                                Label(attachment["name"] ?? "附件", systemImage: "paperclip")
                                Button("移除", systemImage: "xmark") {
                                    attachments[bot.id]?.removeAll { $0["id"] == attachment["id"] }
                                }.labelStyle(.iconOnly)
                            }
                        }
                        HStack {
                            Button("添加附件", systemImage: "paperclip") { selectingFiles = true }
                                .labelStyle(.iconOnly)
                            if let error = store.error {
                                Text(error).foregroundStyle(.secondary)
                            } else if let id = bot.activeConversationId, store.deliveryStates[id]?.paused == true {
                                Text("消息处理已暂停").foregroundStyle(.secondary)
                                Button("检查并继续") { reviewInterrupted = true }
                            } else if let id = bot.activeConversationId, let error = store.runErrors[id],
                                      !messages.contains(where: { $0.content == error || $0.error == error }) {
                                Text(error).foregroundStyle(.secondary)
                            } else if !store.connected {
                                Text("智能层未连接，当前仅查看隔离副本。")
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("发送", systemImage: "arrow.up") { send(bot) }
                                .disabled(!store.connected || (drafts[bot.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments[bot.id, default: []].isEmpty))
                        }
                    }
                    .padding()
                }
                .navigationTitle(bot.name)
                .fileImporter(isPresented: $selectingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    addAttachments(result, botID: bot.id)
                }
                .task(id: store.selectedBotID) { await store.refresh() }
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Button(bot.name, systemImage: "person.crop.circle") { showBotDetails.toggle() }
                            .help("查看并管理 Bot")
                    }
                    if let sessionID = bot.activeConversationId, store.runningSessions.contains(sessionID) {
                        ToolbarItem {
                            ProgressView().controlSize(.small).accessibilityLabel("正在处理")
                        }
                        ToolbarItem {
                            Menu("任务", systemImage: "ellipsis.circle") {
                                Button("停止当前任务") { Task { await store.stop(bot) } }
                            }
                        }
                    }
                }
                .inspector(isPresented: $showBotDetails) {
                    Form {
                        LabeledContent("名称", value: bot.name)
                        LabeledContent("会话", value: bot.activeConversationId == nil ? "未绑定" : "已绑定")
                        LabeledContent("连接", value: bot.backendId ?? "默认")
                        LabeledContent("模型", value: bot.modelId ?? "默认")
                        Button("管理 Bot") { editBot = true }
                            .disabled(!store.connected)
                        Button("查看记忆") { showMemory = true }
                            .disabled(!store.connected)
                        Button("移除 Bot", role: .destructive) { removingBot = true }
                            .disabled(!store.connected)
                    }
                    .formStyle(.grouped)
                }
                .sheet(isPresented: $editBot) { BotEditor(store: store, bot: bot) }
                .alert("移除 \(bot.name)？", isPresented: $removingBot) {
                    Button("取消", role: .cancel) { }
                    Button("移除", role: .destructive) {
                        Task { if await store.removeBot(bot) { showBotDetails = false } }
                    }
                } message: {
                    Text("这会停止相关任务、移除 Bot 的关联及浏览器数据；如果配置了虚拟机，也会尝试销毁虚拟机。")
                }
                .sheet(isPresented: $showMemory) {
                    Form {
                        Section("记忆") {
                            Text("共享偏好会用于其他 Bot；Bot 记忆仅属于当前 Bot。")
                                .foregroundStyle(.secondary)
                            ForEach((store.memories[bot.id] ?? []).reversed()) { entry in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(entry.text).textSelection(.enabled)
                                        Text(entry.botId == "__blinky_user_preferences__" ? "共享偏好" : "Bot 记忆")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("移除", role: .destructive) { removingMemory = entry }
                                }
                            }
                        }
                        Section("添加记忆") {
                            TextField("希望这个 Bot 记住什么", text: $memoryText, axis: .vertical)
                            Button("添加") {
                                let value = memoryText.trimmingCharacters(in: .whitespacesAndNewlines)
                                Task { if await store.addMemory(botID: bot.id, text: value) { memoryText = "" } }
                            }.disabled(memoryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        Button("完成") { showMemory = false }.keyboardShortcut(.cancelAction)
                    }
                    .formStyle(.grouped)
                    .task { await store.refreshMemory(botID: bot.id) }
                    .alert("移除这条记忆？", isPresented: Binding(get: { removingMemory != nil }, set: { if !$0 { removingMemory = nil } })) {
                        Button("取消", role: .cancel) { removingMemory = nil }
                        Button("移除", role: .destructive) {
                            guard let entry = removingMemory else { return }
                            removingMemory = nil
                            Task { await store.removeMemory(entry, viewing: bot.id) }
                        }
                    } message: { Text(removingMemory?.botId == "__blinky_user_preferences__" ? "这条共享偏好对所有 Bot 都会移除。" : "这条记忆将从当前 Bot 移除。") }
                }
                .sheet(isPresented: $reviewInterrupted) {
                    if let sessionID = bot.activeConversationId {
                        VStack(alignment: .leading) {
                            Text("检查中断的消息").font(.headline)
                            Text("这些消息可能已经执行。确认状态后可继续处理后续消息，不会自动重发中断的消息。")
                            ForEach(store.deliveryStates[sessionID]?.items.filter { $0.status == "interrupted" } ?? []) { item in
                                HStack {
                                    Text(item.text.isEmpty ? "附件消息" : item.text).textSelection(.enabled)
                                    Spacer()
                                    Button("已检查") { Task { await store.acknowledgeInterrupted(item, sessionID: sessionID) } }
                                }
                            }
                            HStack {
                                Button("关闭") { reviewInterrupted = false }.keyboardShortcut(.cancelAction)
                                Spacer()
                                Button("继续处理") {
                                    Task { await store.resumeDelivery(sessionID: sessionID); reviewInterrupted = false }
                                }.disabled(store.deliveryStates[sessionID]?.items.contains { $0.status == "interrupted" } == true)
                            }
                        }.padding()
                    }
                }
            } else {
                ContentUnavailableView("没有可显示的 Bot", systemImage: "bubble.left.and.bubble.right", description: Text(store.error ?? "隔离副本中没有 Bot。"))
            }
        }
        .onChange(of: store.showCreateBot) { _, requested in
            if requested { botName = ""; creatingBot = true; store.showCreateBot = false }
        }
        .onChange(of: store.showSelectedBot) { _, requested in
            if requested { showBotDetails = true; store.showSelectedBot = false }
        }
        .sheet(item: Binding(
            get: { store.approvals.first },
            set: { _ in }
        )) { approval in
            VStack(alignment: .leading) {
                Text("需要你的确认").font(.headline)
                Text(approval.summary)
                ScrollView {
                    Text(approval.detail).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    if let encoded = approval.preview, let data = Data(base64Encoded: encoded), let image = NSImage(data: data) {
                        Image(nsImage: image).resizable().scaledToFit().accessibilityLabel("操作预览")
                    }
                }
                HStack {
                    Spacer()
                    Button("拒绝") { Task { await store.decideApproval(approval, allow: false) } }
                        .keyboardShortcut(.cancelAction)
                    Button("允许一次") { Task { await store.decideApproval(approval, allow: true) } }
                }
            }
            .padding()
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $creatingBot) {
            Form {
                TextField("Bot 名称", text: $botName)
                if let error = store.error { Text(error).foregroundStyle(.secondary) }
                HStack {
                    Button("取消") { creatingBot = false }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("创建") {
                        savingBot = true
                        Task {
                            if await store.createBot(name: botName.trimmingCharacters(in: .whitespacesAndNewlines)) {
                                creatingBot = false
                                showBotDetails = true
                                editBot = true
                            }
                            savingBot = false
                        }
                    }.disabled(savingBot || botName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.formStyle(.grouped)
        }
    }

    private func send(_ bot: Bot) {
        let text = drafts[bot.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments[bot.id, default: []]
        guard store.connected, !text.isEmpty || !files.isEmpty else { return }
        drafts[bot.id] = ""
        attachments[bot.id] = []
        Task {
            if !(await store.send(text, attachments: files, botID: bot.id)) {
                let newer = drafts[bot.id, default: ""]
                drafts[bot.id] = newer.isEmpty ? text : text + "\n" + newer
                attachments[bot.id, default: []].insert(contentsOf: files, at: 0)
            }
        }
    }

    private func addAttachments(_ result: Result<[URL], Error>, botID: String) {
        do {
            for url in try result.get() {
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                var attachment = ["id": UUID().uuidString, "name": url.lastPathComponent, "kind": "file", "path": url.path]
                if let type = UTType(filenameExtension: url.pathExtension), let mime = type.preferredMIMEType,
                   ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime) {
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 5_625_000 else { store.reportError("图片过大，请选择较小的图片。"); continue }
                    attachment["kind"] = "image"
                    attachment["mime"] = mime
                    attachment["data"] = try Data(contentsOf: url).base64EncodedString()
                }
                let total = attachments[botID, default: []].reduce(0) { $0 + ($1["data"]?.utf8.count ?? 0) } + (attachment["data"]?.utf8.count ?? 0)
                guard total <= 15_000_000 else { store.reportError("附件总大小过大，请分开发送。"); break }
                attachments[botID, default: []].append(attachment)
            }
        } catch { store.reportError(error.localizedDescription) }
    }

    private func pasteImage(botID: String) -> Bool {
        let clipboard = NSPasteboard.general
        let data: Data
        if let png = clipboard.data(forType: .png) { data = png }
        else if let tiff = clipboard.data(forType: .tiff),
                let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) { data = png }
        else { return false }
        guard data.count <= 5_625_000 else { store.reportError("图片过大，请选择较小的图片。"); return true }
        let encoded = data.base64EncodedString()
        let total = attachments[botID, default: []].reduce(0) { $0 + ($1["data"]?.utf8.count ?? 0) } + encoded.utf8.count
        guard total <= 15_000_000 else { store.reportError("附件总大小过大，请分开发送。"); return true }
        attachments[botID, default: []].append(["id": UUID().uuidString, "name": "image.png", "kind": "image", "mime": "image/png", "data": encoded])
        return true
    }
}
