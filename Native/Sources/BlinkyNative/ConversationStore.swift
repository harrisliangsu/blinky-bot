import Foundation
import Observation

struct Bot: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let systemPrompt: String?
    let emoji: String?
    let activeConversationId: String?
    let backendId: String?
    let modelId: String?
    let thinking: String?
    let executionAgent: ExecutionAgent?
    let tools: [String]?
}

struct ExecutionAgent: Decodable, Hashable {
    let backendId: String
    let modelId: String
    let thinking: String?
}

struct ModelOption: Decodable, Identifiable {
    let id: String
    let label: String
    let supportedThinking: [String]?
}

struct BackendOption: Decodable, Identifiable {
    let id: String
    let label: String
    let status: String
    let kind: String
    let models: [ModelOption]
}

struct BackendConfiguration: Decodable {
    let enabled: Bool?
    let added: Bool?
    let baseUrl: String?
    let command: String?
    let providerName: String?
    let providerProtocol: String?
    let hasApiKey: Bool?
    let defaultModelId: String?
}

struct ProviderPreset: Decodable, Identifiable {
    let id: String
    let label: String
    let baseUrl: String
    let `protocol`: String
}

struct NativeSettings: Decodable {
    let notifications: Bool?
    let approvalPolicy: String?
    let memoryExtraction: String?
    let defaultBackendId: String?
    let backends: [String: BackendConfiguration]
}

struct Conversation: Decodable {
    let id: String
    let messages: [Message]
}

struct Message: Decodable, Identifiable {
    let id: String
    let role: String
    var content: String
    let `internal`: Bool?
    let attachments: [MessageAttachment]?
    let error: String?
    let createdAt: Double?
}

struct MessageAttachment: Decodable, Identifiable {
    let id: String
    let kind: String
    let name: String
    let mime: String?
    let data: String?
}

struct Approval: Decodable, Identifiable {
    let id: String
    let sessionId: String
    let summary: String
    let detail: String
    let preview: String?
}

struct MemoryRecord: Decodable, Identifiable {
    let id: String
    let botId: String
    let text: String
    let source: String
    let createdAt: Double
}

struct DeliveryState: Decodable {
    struct Item: Decodable, Identifiable {
        let id: String
        let text: String
        let attachments: [MessageAttachment]
        let status: String
        let createdAt: Double
    }
    let paused: Bool
    let items: [Item]
}

@MainActor @Observable
final class ConversationStore {
    private(set) var bots: [Bot] = []
    private(set) var conversations: [String: Conversation] = [:]
    private(set) var error: String?
    var selectedBotID: String?
    private(set) var connected = false
    private(set) var approvals: [Approval] = []
    private(set) var runningSessions: Set<String> = []
    private(set) var runErrors: [String: String] = [:]
    private(set) var liveMessages: [String: [Message]] = [:]
    private(set) var pendingMessages: [String: [PendingMessage]] = [:]
    private(set) var deliveryStates: [String: DeliveryState] = [:]
    private(set) var backends: [BackendOption] = []
    private(set) var settings: NativeSettings?
    private(set) var providerPresets: [ProviderPreset] = []
    private(set) var memories: [String: [MemoryRecord]] = [:]
    var showCreateBot = false
    var showSelectedBot = false
    private let runtime = NativeRuntime()
    private var refreshTask: Task<Void, Never>?
    private var refreshRequested = false
    private var refreshGeneration = 0

    struct PendingMessage: Identifiable {
        let id: String
        let message: Message
        var serverID: String?
    }

    func messages(for bot: Bot) -> [Message] {
        guard let id = bot.activeConversationId else { return [] }
        let saved = conversations[id]?.messages ?? []
        let known = Set(saved.map(\.id))
        let live = (liveMessages[id] ?? []).filter { !known.contains($0.id) }
        let visibleIDs = known.union(live.map(\.id))
        let queued = (deliveryStates[id]?.items ?? []).filter { !visibleIDs.contains($0.id) }.map {
            Message(id: $0.id, role: "user", content: $0.text, internal: nil, attachments: $0.attachments, error: nil, createdAt: $0.createdAt)
        }
        let representedIDs = visibleIDs.union(queued.map(\.id))
        let pending = (pendingMessages[id] ?? []).filter { item in
            item.serverID.map { !representedIDs.contains($0) } ?? true
        }.map(\.message)
        // Persisted order is authoritative: an assistant message may have
        // started before a later user message but committed after it.
        let transient = (live + queued + pending).sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
        return (saved + transient).filter { $0.internal != true && $0.role != "tool" }
    }

    private func option(_ name: String, environment: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: name), args.indices.contains(index + 1) { return args[index + 1] }
        return ProcessInfo.processInfo.environment[environment]
    }

    func start() async {
        let bundled = Bundle.main.infoDictionary?["BlinkyNativeBundledRuntime"] as? Bool == true
        let helper = Bundle.main.privateFrameworksURL?.appending(path: "BlinkyBot Preview Runtime.app/Contents/MacOS/BlinkyBot Preview").path(percentEncoded: false)
        let executable = bundled ? helper : option("--electron", environment: "BLINKY_NATIVE_ELECTRON")
        let project = bundled ? nil : option("--project", environment: "BLINKY_NATIVE_PROJECT")
        let previewData = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appending(path: "BlinkyBot Preview").path(percentEncoded: false)
        let dataDirectory = option("--snapshot", environment: "BLINKY_NATIVE_SNAPSHOT") ?? (bundled ? previewData : nil)
        guard let executable, let dataDirectory, bundled || project != nil else {
            load()
            return
        }
        do {
            runtime.onEvent = { [weak self] event in self?.handleEvent(event) }
            try await runtime.start(executable: executable, project: project, dataDirectory: dataDirectory)
            connected = true
            await refresh()
        } catch {
            connected = false
            self.error = error.localizedDescription
        }
    }

    func refresh() async {
        guard runtime.ready else { connected = false; return }
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let loaded: [Bot] = try await runtime.request("openbot:bots:list", args: [], as: [Bot].self)
            guard generation == refreshGeneration else { return }
            bots = loaded.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            if !bots.contains(where: { $0.id == selectedBotID }) { selectedBotID = bots.first?.id }
            // Fresh stores and newly imported Bots may not have a home yet.
            // Reuse the backend's idempotent home-creation path.
            if let bot = bots.first(where: { $0.id == selectedBotID }), bot.activeConversationId == nil {
                let home: Conversation = try await runtime.request("openbot:sessions:create", args: [[bot.id]], as: Conversation.self)
                guard generation == refreshGeneration, !home.id.isEmpty else { return }
                let refreshed: [Bot] = try await runtime.request("openbot:bots:list", args: [], as: [Bot].self)
                guard generation == refreshGeneration else { return }
                bots = refreshed.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            }
            if let id = bots.first(where: { $0.id == selectedBotID })?.activeConversationId {
                let conversation: Conversation? = try await runtime.request("openbot:sessions:get", args: [id], as: Conversation?.self)
                guard generation == refreshGeneration else { return }
                if let conversation { conversations[id] = conversation }
                if let conversation {
                    let savedIDs = Set(conversation.messages.map(\.id))
                    liveMessages[id]?.removeAll { savedIDs.contains($0.id) }
                    pendingMessages[id]?.removeAll { $0.serverID.map(savedIDs.contains) == true }
                }
                let running: Bool = try await runtime.request("openbot:agent:isRunning", args: [id], as: Bool.self)
                guard generation == refreshGeneration else { return }
                if running { runningSessions.insert(id) } else { runningSessions.remove(id) }
                let delivery: DeliveryState = try await runtime.request("openbot:agent:queue", args: [id], as: DeliveryState.self)
                guard generation == refreshGeneration else { return }
                deliveryStates[id] = delivery
            }
        } catch { self.error = error.localizedDescription }
    }

    func send(_ text: String, attachments: [[String: String]], botID: String) async -> Bool {
        guard let sessionID = bots.first(where: { $0.id == botID })?.activeConversationId else {
            error = "该 Bot 没有主聊天。"
            return false
        }
        let localID = UUID().uuidString
        let localAttachments = attachments.compactMap { value -> MessageAttachment? in
            guard let id = value["id"], let kind = value["kind"], let name = value["name"] else { return nil }
            return MessageAttachment(id: id, kind: kind, name: name, mime: value["mime"], data: value["data"])
        }
        let optimistic = Message(id: localID, role: "user", content: text, internal: nil,
            attachments: localAttachments, error: nil, createdAt: Date().timeIntervalSince1970 * 1000)
        pendingMessages[sessionID, default: []].append(PendingMessage(id: localID, message: optimistic, serverID: nil))
        do {
            struct Accepted: Decodable {
                struct Item: Decodable { let id: String }
                let paused: Bool
                let items: [Item]
            }
            let result: Accepted = try await runtime.request("openbot:agent:enqueue", args: [sessionID, text, attachments], as: Accepted.self)
            if let index = pendingMessages[sessionID]?.firstIndex(where: { $0.id == localID }) {
                pendingMessages[sessionID]?[index].serverID = result.items.last?.id
            }
            if let serverID = result.items.last?.id,
               (liveMessages[sessionID]?.contains(where: { $0.id == serverID }) == true ||
                conversations[sessionID]?.messages.contains(where: { $0.id == serverID }) == true) {
                pendingMessages[sessionID]?.removeAll { $0.id == localID }
            }
            if result.paused { runErrors[sessionID] = "消息已保存，但处理已暂停；请先处理之前未确认的消息。" }
            error = nil
            scheduleRefresh()
            return true
        } catch NativeRuntimeError.unavailable {
            pendingMessages[sessionID]?.removeAll { $0.id == localID }
            self.error = NativeRuntimeError.unavailable.localizedDescription
            return false
        } catch {
            // The runtime may have accepted the message before its reply was
            // lost. Keep it visible and never put it back as an automatic retry.
            self.error = "消息接收状态未确认，请检查聊天后再决定是否重发。"
            return true
        }
    }

    func reportError(_ message: String) { error = message }

    func refreshMemory(botID: String) async {
        do { memories[botID] = try await runtime.request("openbot:bots:memory", args: [botID], as: [MemoryRecord].self) }
        catch { self.error = error.localizedDescription }
    }

    func addMemory(botID: String, text: String) async -> Bool {
        do {
            let _: MemoryRecord = try await runtime.request("openbot:bots:addMemory", args: [botID, text], as: MemoryRecord.self)
            await refreshMemory(botID: botID)
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    func removeMemory(_ entry: MemoryRecord, viewing botID: String) async {
        do {
            // The IPC accepts a real Bot id; the store resolves shared entries
            // by entry id and removes them from the shared preference document.
            let _: Bool? = try await runtime.request("openbot:bots:removeMemory", args: [botID, entry.id], as: Bool?.self)
            await refreshMemory(botID: botID)
        } catch { self.error = error.localizedDescription }
    }

    func createBot(name: String) async -> Bool {
        struct Result: Decodable { let ok: Bool; let bot: Bot?; let error: String? }
        do {
            let result: Result = try await runtime.request("openbot:bots:create", args: [["name": name]], as: Result.self)
            guard result.ok, let bot = result.bot else { error = result.error ?? "无法创建 Bot。"; return false }
            let conversation: Conversation = try await runtime.request("openbot:sessions:create", args: [[bot.id]], as: Conversation.self)
            guard !conversation.id.isEmpty else { throw NativeRuntimeError.malformed }
            selectedBotID = bot.id
            await refresh()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    func removeBot(_ bot: Bot) async -> Bool {
        do {
            let _: Bool? = try await runtime.request("openbot:bots:remove", args: [bot.id], as: Bool?.self)
            selectedBotID = nil
            await refresh()
            return !bots.contains { $0.id == bot.id }
        } catch { self.error = error.localizedDescription; return false }
    }

    func acknowledgeInterrupted(_ item: DeliveryState.Item, sessionID: String) async {
        do {
            let state: DeliveryState = try await runtime.request("openbot:agent:removeQueued", args: [sessionID, item.id], as: DeliveryState.self)
            deliveryStates[sessionID] = state
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func resumeDelivery(sessionID: String) async {
        do {
            let state: DeliveryState = try await runtime.request("openbot:agent:pauseQueue", args: [sessionID, false], as: DeliveryState.self)
            deliveryStates[sessionID] = state
            runErrors.removeValue(forKey: sessionID)
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func decideApproval(_ approval: Approval, allow: Bool) async {
        do {
            let _: Bool? = try await runtime.request("openbot:agent:respondToApproval", args: [approval.id, allow ? "approve" : "reject"], as: Bool?.self)
            approvals.removeAll { $0.id == approval.id }
        } catch { self.error = error.localizedDescription }
    }

    func stop(_ bot: Bot) async {
        guard let id = bot.activeConversationId else { return }
        do {
            let stopped: Bool = try await runtime.request("openbot:agent:stop", args: [id], as: Bool.self)
            if !stopped { error = "当前任务未能停止。" }
        } catch { self.error = error.localizedDescription }
    }

    func refreshBackends() async {
        guard connected else { return }
        do { backends = try await runtime.request("openbot:backends:refresh", args: [], as: [BackendOption].self) }
        catch { self.error = error.localizedDescription }
    }

    func refreshSettings() async {
        guard connected else { return }
        do {
            settings = try await runtime.request("openbot:settings:get", args: [], as: NativeSettings.self)
            providerPresets = try await runtime.request("native:catalog:providers", args: [], as: [ProviderPreset].self)
        }
        catch { self.error = error.localizedDescription }
    }

    func saveSettings(_ patch: [String: Any]) async -> Bool {
        do {
            settings = try await runtime.request("openbot:settings:update", args: [patch], as: NativeSettings.self)
            await refreshBackends()
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func updateBot(_ bot: Bot, name: String, description: String, prompt: String, tools: [String], backendID: String, modelID: String, thinking: String, execution: [String: String]?) async -> Bool {
        struct SaveResult: Decodable { let ok: Bool; let error: String? }
        do {
            var patch: [String: Any] = ["name": name, "description": description, "systemPrompt": prompt,
                                        "tools": tools, "backendId": backendID, "modelId": modelID,
                                        "thinking": thinking, "followsDefault": false]
            patch["executionAgent"] = execution ?? NSNull()
            let result: SaveResult = try await runtime.request("openbot:bots:update", args: [bot.id, patch], as: SaveResult.self)
            guard result.ok else { error = result.error ?? "无法保存 Bot 配置。"; return false }
            await refresh()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func handleEvent(_ event: [String: Any]?) {
        guard let event else { connected = false; error = "智能层连接已断开。"; return }
        if event["type"] as? String == "run-started", let sessionID = event["sessionId"] as? String {
            runningSessions.insert(sessionID)
            runErrors.removeValue(forKey: sessionID)
        } else if event["type"] as? String == "error", let sessionID = event["sessionId"] as? String,
                  let message = event["message"] as? String {
            runErrors[sessionID] = message
        } else if event["type"] as? String == "message-start", let sessionID = event["sessionId"] as? String,
                  let raw = event["message"], let data = try? JSONSerialization.data(withJSONObject: raw),
                  let message = try? JSONDecoder().decode(Message.self, from: data) {
            if !(liveMessages[sessionID]?.contains(where: { $0.id == message.id }) ?? false) {
                liveMessages[sessionID, default: []].append(message)
            }
            pendingMessages[sessionID]?.removeAll { $0.serverID == message.id }
        } else if event["type"] as? String == "text-delta", let sessionID = event["sessionId"] as? String,
                  let messageID = event["messageId"] as? String, let delta = event["delta"] as? String,
                  let index = liveMessages[sessionID]?.firstIndex(where: { $0.id == messageID }) {
            liveMessages[sessionID]?[index].content += delta
        } else if event["type"] as? String == "message-end", let sessionID = event["sessionId"] as? String,
                  let messageID = event["messageId"] as? String, let content = event["content"] as? String,
                  let index = liveMessages[sessionID]?.firstIndex(where: { $0.id == messageID }) {
            liveMessages[sessionID]?[index].content = content
        } else if event["type"] as? String == "approval-request", let request = event["request"],
           let data = try? JSONSerialization.data(withJSONObject: request),
           let approval = try? JSONDecoder().decode(Approval.self, from: data),
           !approvals.contains(where: { $0.id == approval.id }) {
            approvals.append(approval)
        } else if event["type"] as? String == "done", let sessionID = event["sessionId"] as? String {
            runningSessions.remove(sessionID)
            approvals.removeAll { $0.sessionId == sessionID }
        }
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        refreshRequested = true
        guard refreshTask == nil else { return }
        refreshTask = Task { @MainActor [weak self] in
            while let self, self.refreshRequested {
                self.refreshRequested = false
                try? await Task.sleep(for: .milliseconds(150))
                await self.refresh()
            }
            self?.refreshTask = nil
        }
    }

    // Native development uses a user-supplied snapshot, never the live store.
    func load() {
        guard let path = option("--snapshot", environment: "BLINKY_NATIVE_SNAPSHOT"), !path.isEmpty else {
            error = "请通过 BLINKY_NATIVE_SNAPSHOT 指定隔离的历史数据副本。"
            bots = []
            conversations = [:]
            return
        }
        load(snapshot: URL(fileURLWithPath: path, isDirectory: true))
    }

    func load(snapshot root: URL) {
        do {
            let loadedBots: [Bot] = try readCollection(root.appending(path: "bots", directoryHint: .isDirectory))
            let loadedConversations: [Conversation] = try readCollection(root.appending(path: "sessions", directoryHint: .isDirectory))
            bots = loadedBots.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            conversations = Dictionary(loadedConversations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            if !bots.contains(where: { $0.id == selectedBotID }) { selectedBotID = bots.first?.id }
            error = nil
        } catch {
            self.error = "无法读取历史数据副本：\(error.localizedDescription)"
        }
    }

    private func readCollection<T: Decodable>(_ directory: URL) throws -> [T] {
        let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        return try urls.filter { $0.pathExtension == "json" }.map {
            try JSONDecoder().decode(T.self, from: Data(contentsOf: $0))
        }
    }
}
