import Foundation
import Speech
import AVFoundation

// No network fallback. All results are from Apple's on-device recognizer.
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
}
let command = CommandLine.arguments.dropFirst().first ?? "status"
let language = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : Locale.current.identifier
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not-determined"
    }
}
func microphoneStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not-determined"
    }
}
if command == "status" {
    emit(["speech": speechStatus(), "microphone": microphoneStatus(), "onDevice": recognizer?.supportsOnDeviceRecognition ?? false, "language": language])
    exit(0)
}
guard command == "start" else { emit(["type": "error", "code": "unavailable"]); exit(1) }
if ["denied", "restricted"].contains(microphoneStatus()) {
    emit(["type": "error", "code": "microphone-permission"]); emit(["type": "end"]); exit(0)
}
if ["denied", "restricted"].contains(speechStatus()) {
    emit(["type": "error", "code": "speech-permission"]); emit(["type": "end"]); exit(0)
}
let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var tapped = false
var finished = false
var stopping = false
var latest = ""
func finish(_ code: String? = nil, cancelled: Bool = false) {
    guard !finished else { return }; finished = true
    engine.stop()
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    task?.cancel()
    if let code = code { emit(["type": "error", "code": code]) }
    else if !cancelled && !latest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { emit(["type": "result", "text": latest]) }
    else if !cancelled { emit(["type": "error", "code": "no-speech"]) }
    emit(["type": "end"])
    exit(0)
}
func stop() {
    guard !finished && !stopping else { return }; stopping = true
    engine.stop()
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    request?.endAudio()
    emit(["type": "stopping"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 12) { finish("recognition") }
}
func record() {
    guard !stopping && !finished else { finish(cancelled: true); return }
    guard let recognizer = recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { finish("unavailable"); return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = true
    request = req
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 && format.channelCount > 0 else { finish("microphone-unavailable"); return }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
    tapped = true
    task = recognizer.recognitionTask(with: req) { result, error in
        DispatchQueue.main.async {
            guard !finished else { return }
            if let result = result {
                latest = result.bestTranscription.formattedString
                emit(["type": "interim", "text": latest])
                if result.isFinal { finish(); return }
            }
            if error != nil { finish(stopping && !latest.isEmpty ? nil : "recognition") }
        }
    }
    do { engine.prepare(); try engine.start(); emit(["type": "listening"]) }
    catch { finish("microphone-unavailable") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 180) { stop() }
}
func authorizeSpeech() {
    guard !finished else { return }
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async {
            if status == .authorized { record() } else { finish("speech-permission") }
        }
    }
}
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        DispatchQueue.main.async { if line == "stop" { stop() } else if line == "cancel" { finish(cancelled: true) } }
    }
    DispatchQueue.main.async { finish(cancelled: true) }
}
AVCaptureDevice.requestAccess(for: .audio) { granted in
    DispatchQueue.main.async { if granted { authorizeSpeech() } else { finish("microphone-permission") } }
}
RunLoop.main.run()
