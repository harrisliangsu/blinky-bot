import SwiftUI

private struct ConnectionDraft: Identifiable {
    var id: String
    var creating: Bool
    var name: String
    var protocolName: String
    var baseURL: String
    var command: String
    var defaultModel: String
    var apiKey = ""
    var originalURL: String
    var hadKey: Bool
    var isCustom: Bool { id.hasPrefix("custom-") }
}

struct NativeSettingsView: View {
    @Bindable var store: ConversationStore
    @State private var draft: ConnectionDraft?
    @State private var deleting: BackendOption?

    private var listed: [BackendOption] {
        store.backends.filter { backend in
            let config = store.settings?.backends[backend.id]
            if config?.added == false { return false }
            return config?.added == true || config?.hasApiKey == true || (backend.kind == "agent-cli" && backend.status == "available")
        }
    }

    var body: some View {
        TabView {
            Form {
                Section("连接") {
                    ForEach(listed) { backend in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(backend.label)
                                Text(backend.status == "available" ? "可用" : "需要配置")
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("编辑") { draft = editDraft(backend) }
                            Button("移除", role: .destructive) {
                                if store.settings?.defaultBackendId == backend.id || store.bots.contains(where: { $0.backendId == backend.id || $0.executionAgent?.backendId == backend.id }) {
                                    store.reportError("此连接仍被默认配置或 Bot 使用，请先更换后再移除。")
                                } else { deleting = backend }
                            }
                        }
                    }
                    Button("添加连接", systemImage: "plus") {
                        draft = ConnectionDraft(id: "custom-" + UUID().uuidString.lowercased(), creating: true,
                            name: "", protocolName: "openai", baseURL: "", command: "", defaultModel: "default", originalURL: "", hadKey: false)
                    }
                }
                if let error = store.error { Text(error).foregroundStyle(.secondary) }
            }
            .formStyle(.grouped)
            .tabItem { Label("连接", systemImage: "network") }

            Form {
                Toggle("通知", isOn: Binding(
                    get: { store.settings?.notifications ?? true },
                    set: { value in Task { _ = await store.saveSettings(["notifications": value]) } }
                ))
                Picker("操作权限", selection: Binding(
                    get: { store.settings?.approvalPolicy ?? "ask-every-time" },
                    set: { value in Task { _ = await store.saveSettings(["approvalPolicy": value]) } }
                )) {
                    Text("每次询问").tag("ask-every-time")
                    Text("首次询问").tag("ask-first-time")
                    Text("允许列表").tag("allowlist")
                    Text("自动运行").tag("auto-run")
                }
                Text("CLI 自带工具由各 CLI 执行。Codex 依据沙箱和自身规则请求确认；Kimi 和 Grok 的部分本地操作目前不会向 BlinkyBot 请求确认。")
                    .foregroundStyle(.secondary)
            }
            .formStyle(.grouped)
            .tabItem { Label("通用", systemImage: "gear") }
        }
        .task { await store.refreshSettings(); await store.refreshBackends() }
        .sheet(item: $draft) { current in
            ConnectionEditor(store: store, initial: current)
        }
        .alert("移除连接？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("取消", role: .cancel) { deleting = nil }
            Button("移除", role: .destructive) {
                guard let backend = deleting else { return }
                deleting = nil
                Task {
                    var patch: [String: Any] = ["enabled": false, "added": false]
                    if backend.kind != "agent-cli" { patch["clearApiKey"] = true }
                    _ = await store.saveSettings(["backends": [backend.id: patch]])
                }
            }
        } message: {
            Text(deleting?.kind == "agent-cli" ? "只从 BlinkyBot 移除，不会卸载本机 CLI。" : "连接及其保存的 API Key 将被移除。")
        }
    }

    private func editDraft(_ backend: BackendOption) -> ConnectionDraft {
        let config = store.settings?.backends[backend.id]
        let preset = store.providerPresets.first { $0.id == backend.id }
        let baseURL = config?.baseUrl ?? preset?.baseUrl ?? ""
        return ConnectionDraft(id: backend.id, creating: false, name: config?.providerName ?? backend.label,
            protocolName: config?.providerProtocol ?? preset?.`protocol` ?? "openai", baseURL: baseURL,
            command: config?.command ?? "", defaultModel: config?.defaultModelId ?? "default",
            originalURL: baseURL, hadKey: config?.hasApiKey == true)
    }
}

private struct ConnectionEditor: View {
    @Bindable var store: ConversationStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ConnectionDraft
    @State private var saving = false

    init(store: ConversationStore, initial: ConnectionDraft) {
        self.store = store
        _draft = State(initialValue: initial)
    }

    private var backend: BackendOption? { store.backends.first { $0.id == draft.id } }
    private var isCLI: Bool { backend?.kind == "agent-cli" }
    private var needsNewKey: Bool {
        guard draft.isCustom, draft.hadKey, !draft.originalURL.isEmpty,
              let old = URLComponents(string: draft.originalURL), let new = URLComponents(string: draft.baseURL) else { return false }
        return old.scheme != new.scheme || old.host != new.host || old.port != new.port
    }
    private var valid: Bool {
        if isCLI { return true }
        guard let url = URLComponents(string: draft.baseURL), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return false }
        return (!draft.isCustom || !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && (!needsNewKey || !draft.apiKey.isEmpty)
    }

    var body: some View {
        Form {
            if draft.creating {
                Picker("类型", selection: $draft.id) {
                    Text("自定义 API 供应商").tag(draft.id.hasPrefix("custom-") ? draft.id : "custom-new")
                    ForEach(store.backends.filter { $0.kind == "agent-cli" }) { backend in
                        Text(backend.label).tag(backend.id)
                    }
                    ForEach(store.providerPresets) { preset in Text(preset.label).tag(preset.id) }
                }
                .onChange(of: draft.id) { _, value in
                    if value == "custom-new" { draft.id = "custom-" + UUID().uuidString.lowercased() }
                    let config = store.settings?.backends[draft.id]
                    draft.command = config?.command ?? ""
                    draft.defaultModel = config?.defaultModelId ?? "default"
                    if let preset = store.providerPresets.first(where: { $0.id == draft.id }) {
                        draft.name = preset.label
                        draft.protocolName = preset.`protocol`
                        draft.baseURL = config?.baseUrl ?? preset.baseUrl
                        draft.originalURL = draft.baseURL
                        draft.hadKey = config?.hasApiKey == true
                    }
                }
            }
            if isCLI {
                TextField("命令", text: $draft.command)
            } else {
                if draft.isCustom {
                    TextField("名称", text: $draft.name)
                    Picker("协议", selection: $draft.protocolName) {
                        Text("OpenAI 兼容").tag("openai")
                        Text("Anthropic 兼容").tag("anthropic")
                    }
                }
                TextField("API 地址", text: $draft.baseURL)
                SecureField(draft.hadKey ? "API Key（留空保持原值）" : "API Key", text: $draft.apiKey)
                if needsNewKey { Text("地址来源已改变，请重新输入 API Key。") }
            }
            if let models = backend?.models, !models.isEmpty {
                Picker("默认模型", selection: $draft.defaultModel) {
                    Text("连接默认模型").tag("default")
                    if draft.defaultModel != "default", !models.contains(where: { $0.id == draft.defaultModel }) {
                        Text(draft.defaultModel).tag(draft.defaultModel)
                    }
                    ForEach(models.filter { $0.id != "default" }) { model in Text(model.label).tag(model.id) }
                }
            }
            if let error = store.error { Text(error).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") { save() }.disabled(saving || !valid)
            }
        }
        .formStyle(.grouped)
    }

    private func save() {
        var config: [String: Any] = ["enabled": true, "added": true]
        config["defaultModelId"] = draft.defaultModel
        if isCLI { config["command"] = draft.command }
        else {
            config["baseUrl"] = draft.baseURL
            if draft.isCustom { config["providerName"] = draft.name; config["providerProtocol"] = draft.protocolName }
            if !draft.apiKey.isEmpty { config["apiKey"] = draft.apiKey }
        }
        saving = true
        Task {
            if await store.saveSettings(["backends": [draft.id: config]]) { dismiss() }
            saving = false
        }
    }
}
