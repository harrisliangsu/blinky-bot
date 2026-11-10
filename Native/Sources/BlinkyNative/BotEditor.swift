import SwiftUI

struct BotEditor: View {
    @Bindable var store: ConversationStore
    let bot: Bot
    @Environment(\.dismiss) private var dismiss
    @State private var backendID: String
    @State private var name: String
    @State private var description: String
    @State private var prompt: String
    @State private var selectedTools: Set<String>
    @State private var modelID: String
    @State private var thinking: String
    @State private var enableAgent: Bool
    @State private var agentBackendID: String
    @State private var agentModelID: String
    @State private var agentThinking: String
    @State private var saving = false

    init(store: ConversationStore, bot: Bot) {
        self.store = store
        self.bot = bot
        _name = State(initialValue: bot.name)
        _description = State(initialValue: bot.description ?? "")
        _prompt = State(initialValue: bot.systemPrompt ?? "")
        _selectedTools = State(initialValue: Set(bot.tools ?? []))
        _backendID = State(initialValue: bot.backendId ?? "")
        _modelID = State(initialValue: bot.modelId ?? "default")
        _thinking = State(initialValue: bot.thinking ?? "")
        _enableAgent = State(initialValue: bot.executionAgent != nil)
        _agentBackendID = State(initialValue: bot.executionAgent?.backendId ?? bot.backendId ?? "")
        _agentModelID = State(initialValue: bot.executionAgent?.modelId ?? "default")
        _agentThinking = State(initialValue: bot.executionAgent?.thinking ?? "")
    }

    private var currentBackend: BackendOption? { store.backends.first { $0.id == backendID } }
    private var currentModel: ModelOption? { currentBackend?.models.first { $0.id == modelID } }
    private var depths: [String] { currentModel?.supportedThinking ?? [] }
    private var agentBackend: BackendOption? { store.backends.first { $0.id == agentBackendID } }
    private var agentDepths: [String] { agentBackend?.models.first { $0.id == agentModelID }?.supportedThinking ?? [] }

    var body: some View {
        Form {
            Section("基本信息") {
                TextField("名称", text: $name)
                TextField("简介", text: $description)
                TextField("指令", text: $prompt, axis: .vertical)
            }
            Section("\(bot.name) 的模型") {
                Picker("连接", selection: $backendID) {
                    if !store.backends.contains(where: { $0.id == backendID }) {
                        Text(backendID.isEmpty ? "不可用" : backendID).tag(backendID)
                    }
                    ForEach(store.backends.filter { $0.status == "available" || $0.id == backendID }) { backend in
                        Text(backend.label).tag(backend.id)
                    }
                }
                .onChange(of: backendID) { _, _ in modelID = "default"; thinking = "" }
                Picker("模型", selection: $modelID) {
                    Text("连接默认模型").tag("default")
                    if modelID != "default", !(currentBackend?.models.contains { $0.id == modelID } ?? false) {
                        Text(modelID).tag(modelID)
                    }
                    ForEach((currentBackend?.models ?? []).filter { $0.id != "default" }) { model in
                        Text(model.label).tag(model.id)
                    }
                }
                .onChange(of: modelID) { _, _ in if !depths.contains(thinking) { thinking = "" } }
                if !depths.isEmpty {
                    Picker("思考深度", selection: $thinking) {
                        Text("默认").tag("")
                        ForEach(depths, id: \.self) { depth in Text(depth.capitalized).tag(depth) }
                    }
                }
            }
            Section("独立执行 Agent") {
                Toggle("允许派发后台任务", isOn: $enableAgent)
                    .onChange(of: enableAgent) { _, enabled in if enabled { selectedTools.insert("delegate_task") } }
                if enableAgent {
                    Picker("执行连接", selection: $agentBackendID) {
                        if !store.backends.contains(where: { $0.id == agentBackendID }) { Text(agentBackendID).tag(agentBackendID) }
                        ForEach(store.backends.filter { $0.status == "available" || $0.id == agentBackendID }) { backend in
                            Text(backend.label).tag(backend.id)
                        }
                    }
                    .onChange(of: agentBackendID) { _, _ in agentModelID = "default"; agentThinking = "" }
                    Picker("执行模型", selection: $agentModelID) {
                        Text("连接默认模型").tag("default")
                        if agentModelID != "default", !(agentBackend?.models.contains { $0.id == agentModelID } ?? false) { Text(agentModelID).tag(agentModelID) }
                        ForEach((agentBackend?.models ?? []).filter { $0.id != "default" }) { model in Text(model.label).tag(model.id) }
                    }
                    .onChange(of: agentModelID) { _, _ in if !agentDepths.contains(agentThinking) { agentThinking = "" } }
                    if !agentDepths.isEmpty {
                        Picker("执行思考深度", selection: $agentThinking) {
                            Text("默认").tag("")
                            ForEach(agentDepths, id: \.self) { depth in Text(depth.capitalized).tag(depth) }
                        }
                    }
                    if ["grok", "droid", "pi"].contains(backendID) { Text("当前对话 CLI 暂不支持自动派发后台任务。") }
                    if !selectedTools.contains("delegate_task") { Text("启用后台委派工具后才能派发任务。") }
                }
            }
            DisclosureGroup("工具权限") {
                Text("选择此 Bot 可调用的应用内工具。CLI 自带工具的权限由各 CLI 控制。")
                    .foregroundStyle(.secondary)
                ForEach(Self.toolGroups, id: \.0) { group in
                    Section(group.0) {
                        ForEach(group.1, id: \.0) { item in
                            Toggle(item.1, isOn: Binding(
                                get: { selectedTools.contains(item.0) },
                                set: { if $0 { selectedTools.insert(item.0) } else { selectedTools.remove(item.0) } }
                            ))
                        }
                    }
                }
            }
            if let error = store.error { Text(error).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    saving = true
                    Task {
                        var execution: [String: String]?
                        if enableAgent {
                            execution = ["backendId": agentBackendID, "modelId": agentModelID]
                            if !agentThinking.isEmpty { execution?["thinking"] = agentThinking }
                        }
                        if await store.updateBot(bot, name: name, description: description, prompt: prompt,
                                                 tools: selectedTools.sorted(), backendID: backendID, modelID: modelID,
                                                 thinking: thinking, execution: execution) { dismiss() }
                        saving = false
                    }
                }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || backendID.isEmpty || (enableAgent && agentBackendID.isEmpty))
            }
        }
        .formStyle(.grouped)
        .task { await store.refreshBackends() }
    }

    private static let toolGroups: [(String, [(String, String)])] = [
        ("文件与代码", [("read_file", "读取文件"), ("write_file", "写入文件"), ("edit_file", "编辑文件"), ("list_dir", "浏览目录"), ("glob", "查找文件"), ("grep", "搜索内容"), ("shell", "运行命令")]),
        ("网络", [("fetch", "读取网页"), ("web_search", "搜索网页")]),
        ("电脑", [("screenshot", "截取屏幕"), ("click", "点击"), ("type_text", "输入文字"), ("key_press", "按键"), ("scroll", "滚动"), ("drag", "拖动"), ("open_app", "打开应用"), ("navigate", "浏览页面")]),
        ("协作", [("todo_write", "管理待办"), ("remember", "保存记忆"), ("handoff", "交接任务"), ("delegate_task", "派发任务"), ("request_help", "请求协助"), ("visualize", "生成图表")])
    ]
}
