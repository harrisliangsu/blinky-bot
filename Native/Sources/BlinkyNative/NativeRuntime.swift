import Foundation

enum NativeRuntimeError: LocalizedError {
    case unavailable, uncertain, malformed, remote(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: "智能层连接不可用。"
        case .uncertain: "消息的接收状态未确认，请检查聊天后再决定是否重发。"
        case .malformed: "智能层返回了无法读取的数据。"
        case .remote(let message): message
        }
    }
}

/// A private child with inherited pipes. No network or public socket is opened.
@MainActor
final class NativeRuntime {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var buffer = Data()
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var readyContinuation: CheckedContinuation<Void, Error>?
    private var handshakeTimeout: Task<Void, Never>?
    private(set) var ready = false
    var onEvent: (([String: Any]?) -> Void)?

    func start(executable: String, project: String?, dataDirectory: String) async throws {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = project.map { [$0] } ?? []
        var environment = ProcessInfo.processInfo.environment
        environment["BLINKY_NATIVE_RUNTIME"] = "1"
        environment["BLINKY_NATIVE_DATA_DIR"] = dataDirectory
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor [weak self] in self?.receive(data) }
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.disconnected() }
        }
        try process.run()
        handshakeTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self, !self.ready else { return }
            if self.process.isRunning { self.process.terminate() }
            self.disconnected()
        }
        try await withCheckedThrowingContinuation { continuation in
            readyContinuation = continuation
        }
    }

    func request<T: Decodable>(_ channel: String, args: [Any], as: T.Type) async throws -> T {
        guard ready, process.isRunning else { throw NativeRuntimeError.unavailable }
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "channel": channel, "args": args])
        let reply: Data = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) }
            catch { pending.removeValue(forKey: id); continuation.resume(throwing: NativeRuntimeError.uncertain) }
        }
        return try JSONDecoder().decode(T.self, from: reply)
    }

    private func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard let text = String(data: line, encoding: .utf8), text.hasPrefix("@@BLINKY_NATIVE@@"),
                  let json = String(text.dropFirst("@@BLINKY_NATIVE@@".count)).data(using: .utf8),
                  let frame = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else { continue }
            if frame["ready"] as? Bool == true {
                ready = true
                handshakeTimeout?.cancel()
                handshakeTimeout = nil
                readyContinuation?.resume()
                readyContinuation = nil
            } else if let event = frame["event"] as? [String: Any] {
                onEvent?(event)
            } else if let id = frame["id"] as? String, let continuation = pending.removeValue(forKey: id) {
                if let message = frame["error"] as? String {
                    continuation.resume(throwing: NativeRuntimeError.remote(message))
                } else if let value = frame["result"], let result = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(throwing: NativeRuntimeError.malformed)
                }
            }
        }
    }

    private func disconnected() {
        handshakeTimeout?.cancel()
        handshakeTimeout = nil
        ready = false
        output.fileHandleForReading.readabilityHandler = nil
        readyContinuation?.resume(throwing: NativeRuntimeError.unavailable)
        readyContinuation = nil
        for continuation in pending.values { continuation.resume(throwing: NativeRuntimeError.uncertain) }
        pending.removeAll()
        onEvent?(nil)
    }
}
