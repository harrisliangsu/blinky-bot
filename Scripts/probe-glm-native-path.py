"""Observe a real native request, retaining only safe metadata.

The CLI receives a synthetic placeholder credential. A loopback observer uses
the existing configured credential only in memory, only at its original HTTPS
endpoint. Neither request/response bodies nor headers are logged.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--max-tokens", type=int)
parser.add_argument("--transport", choices=["observer", "direct"], default="observer")
parser.add_argument("--agent", choices=["minimal", "default"], default="minimal")
parser.add_argument("--skip-model-option", action="store_true")
parser.add_argument("--serve-only", action="store_true")
parser.add_argument("--max-requests", type=int, default=2)
args = parser.parse_args()
root = Path(args.root).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
source_home = Path.home()
source = source_home / ".kimi-code/config.toml"
original = source.read_bytes()
config = tomllib.loads(original.decode())
alias = config["default_model"]
model = config["models"][alias]
provider_name = model["provider"]
provider = config["providers"][provider_name]
key = provider.get("api_key")
upstream = provider["base_url"].rstrip("/")
url = urllib.parse.urlparse(upstream)
if not key or url.scheme != "https" or url.query or url.fragment:
    raise RuntimeError("An existing HTTPS provider and credential are required")
start = time.monotonic()
result = {"alias": alias, "provider": provider_name, "providerType": provider["type"], "upstreamHost": url.hostname, "transport": args.transport, "agent": args.agent, "explicitModelOption": not args.skip_model_option, "credentialValuesRecorded": False, "nativeHasRealCredential": args.transport == "direct", "networkProxiesInherited": False, "requests": [], "acp": [], "publicChars": 0, "thoughtChars": 0, "readySeen": False}


def elapsed():
    return round(time.monotonic() - start, 3)


class Observer(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *unused):
        pass

    def do_POST(self):
        observation = {"atSeconds": elapsed(), "path": self.path}
        result["requests"].append(observation)
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            packet = json.loads(body)
            observation["request"] = {
                "keys": list(packet), "model": packet.get("model"),
                "stream": packet.get("stream"), "max_tokens": packet.get("max_tokens"),
                "max_completion_tokens": packet.get("max_completion_tokens"),
                "messageCount": len(packet.get("messages", [])),
                "messageChars": sum(len(json.dumps(m)) for m in packet.get("messages", [])),
                "toolCount": len(packet.get("tools", [])),
                "reasoning_effort": packet.get("reasoning_effort"),
                "thinkingType": (packet.get("thinking") or {}).get("type") if isinstance(packet.get("thinking"), dict) else None,
                "stream_options": packet.get("stream_options")
            }
            observation["nativeUsesSyntheticPlaceholder"] = self.headers.get("Authorization") == "Bearer synthetic-placeholder-not-a-credential"
            if packet.get("model") != model["model"] or self.path != url.path.rstrip("/") + "/chat/completions" or len(result["requests"]) > args.max_requests:
                observation["blockedUnexpectedRequest"] = True
                self.send_error(400)
                return
            if args.max_tokens is not None:
                packet["max_tokens"] = args.max_tokens
                observation["overrideMaxTokens"] = args.max_tokens
                body = json.dumps(packet).encode()
            headers = {"Content-Type": "application/json", "Authorization": "Bearer " + key}
            for name in ["Accept", "User-Agent"]:
                if self.headers.get(name):
                    headers[name] = self.headers[name]
            request = urllib.request.Request(upstream + "/chat/completions", data=body, headers=headers, method="POST")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                response = opener.open(request, timeout=35)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                observation["httpStatus"] = response.status
                observation["headersSeconds"] = elapsed()
                observation["responseType"] = response.headers.get("Content-Type", "").split(";")[0]
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                if response.status != 200:
                    error_bytes = response.read()
                    try:
                        detail = json.loads(error_bytes).get("error", {})
                        code = detail.get("code")
                        if isinstance(code, int) or isinstance(code, str) and len(code) <= 40 and code.replace("_", "").isalnum():
                            observation["providerErrorCode"] = code
                        message = str(detail.get("message", "")).lower()
                        observation["errorClass"] = "tools" if "tool" in message or "工具" in message else "context" if "context" in message or "token" in message or "上下文" in message else "authentication" if "key" in message or "auth" in message or "鉴权" in message else "quota" if "quota" in message or "余额" in message or "额度" in message else "provider_http_error"
                    except (ValueError, AttributeError):
                        pass
                    self.wfile.write(error_bytes.replace(key.encode(), b"[redacted]"))
                    self.wfile.flush()
                    return
                public = ""
                for line in response:
                    observation.setdefault("firstByteSeconds", elapsed())
                    if response.status == 200 and line.startswith(b"data:"):
                        value = line[5:].strip()
                        if value == b"[DONE]":
                            observation["doneSeen"] = True
                        else:
                            event = json.loads(value)
                            observation["dataEvents"] = observation.get("dataEvents", 0) + 1
                            for choice in event.get("choices", []):
                                delta = choice.get("delta", {})
                                text = delta.get("content") or ""
                                public += text
                                observation["publicChars"] = observation.get("publicChars", 0) + len(text)
                                observation["reasoningChars"] = observation.get("reasoningChars", 0) + len(delta.get("reasoning_content") or "")
                                if choice.get("finish_reason"):
                                    observation["finishReason"] = choice["finish_reason"]
                            if event.get("error"):
                                observation["streamError"] = True
                    # Defensive redaction before the synthetic CLI sees errors.
                    self.wfile.write(line.replace(key.encode(), b"[redacted]"))
                    self.wfile.flush()
                observation["readySeen"] = "READY" in public
                observation["finishedSeconds"] = elapsed()
        except Exception as error:
            observation["failureClass"] = type(error).__name__
            try:
                self.send_error(502)
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            self.close_connection = True
            if args.serve_only:
                (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Observer)
threading.Thread(target=server.serve_forever, daemon=True).start()
if args.serve_only:
    endpoint = {"base_url": "http://127.0.0.1:" + str(server.server_port) + url.path, "upstreamHost": url.hostname, "credentialValuesRecorded": False}
    (root / "endpoint.json").write_text(json.dumps(endpoint, indent=2) + "\n")
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        stopped.wait(900)
    finally:
        server.shutdown()
        server.server_close()
        result["elapsedSeconds"] = elapsed()
        result["sourceConfigurationUnchanged"] = source.read_bytes() == original
        result["credentialValuesFoundOnDisk"] = any(key.encode() in file.read_bytes() for file in root.rglob("*") if file.is_file())
        (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    raise SystemExit(0)
profile = root / "home/.kimi-code"
profile.mkdir(parents=True, mode=0o700)
local = "http://127.0.0.1:" + str(server.server_port) + url.path if args.transport == "observer" else upstream
credential_line = 'api_key = "synthetic-placeholder-not-a-credential"' if args.transport == "observer" else 'api_key_env = "BLINKY_GLM_PROVIDER_KEY"'
lines = ["default_model = " + json.dumps(alias), "[providers." + json.dumps(provider_name) + "]", "type = " + json.dumps(provider["type"]), "base_url = " + json.dumps(local), credential_line, "[models." + json.dumps(alias) + "]"]
for name, value in model.items():
    if isinstance(value, (str, int, float, list, bool)):
        lines.append(json.dumps(name) + " = " + json.dumps(value))
(profile / "config.toml").write_text("\n".join(lines) + "\n")
agent = root / "synthetic.md"
agent.write_text('---\nname: glm-transport-probe\ndescription: Synthetic transport diagnosis\ntools: []\nsubagents: []\n---\nReply exactly READY. Do not use tools.\n')
(root / "empty-skills").mkdir()
(root / "tmp").mkdir()
env = {name: os.environ[name] for name in ["__CF_USER_TEXT_ENCODING", "SystemRoot"] if name in os.environ}
env.update({"HOME": str(root / "home"), "KIMI_CODE_HOME": str(profile), "KIMI_DISABLE_TELEMETRY": "1", "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin", "SHELL": "/bin/sh", "TMPDIR": str(root / "tmp"), "XDG_CONFIG_HOME": str(root / "home/.config"), "XDG_CACHE_HOME": str(root / "home/.cache")})
if args.transport == "direct":
    env["BLINKY_GLM_PROVIDER_KEY"] = key
agent_args = ["--agent-file", str(agent)] if args.agent == "minimal" else []
child = subprocess.Popen([str(source_home / ".kimi-code/bin/kimi"), *agent_args, "--skills-dir", str(root / "empty-skills"), "acp"], cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
incoming = queue.Queue()
stderr_bytes = [0]


def pump():
    for line in child.stdout:
        try:
            incoming.put(json.loads(line))
        except json.JSONDecodeError:
            pass
    incoming.put(None)


def discard_stderr():
    for line in child.stderr:
        stderr_bytes[0] += len(line)


threading.Thread(target=pump, daemon=True).start()
threading.Thread(target=discard_stderr, daemon=True).start()
sequence = 0


def rpc(method, params):
    global sequence
    sequence += 1
    request_id = sequence
    child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
    child.stdin.flush()
    deadline = time.monotonic() + 85
    while time.monotonic() < deadline:
        packet = incoming.get(timeout=max(0.1, deadline - time.monotonic()))
        if packet is None:
            raise RuntimeError("NativeExited")
        update = packet.get("params", {}).get("update", {})
        kind = update.get("sessionUpdate")
        result["acp"].append({"atSeconds": elapsed(), "method": packet.get("method"), "id": packet.get("id"), "updateType": kind, "errorCode": packet.get("error", {}).get("code")})
        content = update.get("content", {})
        if kind == "agent_message_chunk":
            result["publicChars"] += len(content.get("text", ""))
            result["readySeen"] = result["readySeen"] or "READY" in content.get("text", "")
        elif kind == "agent_thought_chunk":
            result["thoughtChars"] += len(content.get("text", ""))
        if packet.get("method") == "session/request_permission":
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": packet["id"], "result": {"outcome": {"outcome": "cancelled"}}}) + "\n")
            child.stdin.flush()
        if packet.get("id") == request_id:
            if packet.get("error"):
                raise RuntimeError("AcpRpcError")
            return packet.get("result", {})
    raise TimeoutError()


try:
    rpc("initialize", {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "Synthetic GLM diagnosis", "version": "1"}})
    session = rpc("session/new", {"cwd": str(root), "mcpServers": []})
    result["sessionModel"] = next((o.get("currentValue") for o in session.get("configOptions", []) if o.get("id") == "model"), None)
    if not args.skip_model_option:
        selected = rpc("session/set_config_option", {"sessionId": session["sessionId"], "configId": "model", "value": alias})
        result["confirmedModel"] = next((o.get("currentValue") for o in selected.get("configOptions", []) if o.get("id") == "model"), None)
    reply = rpc("session/prompt", {"sessionId": session["sessionId"], "prompt": [{"type": "text", "text": "Reply exactly READY. Do not use tools."}]})
    result["stopReason"] = reply.get("stopReason")
except Exception as error:
    result["failureClass"] = type(error).__name__
finally:
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    server.shutdown()
    server.server_close()
    result["elapsedSeconds"] = elapsed()
    result["stderrBytesDiscarded"] = stderr_bytes[0]
    result["sourceConfigurationUnchanged"] = source.read_bytes() == original
    result["credentialValuesFoundOnDisk"] = any(key.encode() in file.read_bytes() for file in root.rglob("*") if file.is_file())
    shutil.rmtree(profile)
    result["temporaryProfileRemoved"] = not profile.exists()
    (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "acp"}))
