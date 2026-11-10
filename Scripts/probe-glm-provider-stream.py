"""One minimal SSE comparison; never retain credentials or raw response bodies."""
import argparse
import json
from pathlib import Path
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args()
source = Path.home() / ".kimi-code/config.toml"
original = source.read_bytes()
config = tomllib.loads(original.decode())
alias = config["default_model"]
model = config["models"][alias]
provider = config["providers"][model["provider"]]
key = provider.get("api_key")
endpoint = provider["base_url"].rstrip("/") + "/chat/completions"
if not key or urllib.parse.urlparse(endpoint).scheme != "https":
    raise RuntimeError("An existing key and HTTPS endpoint are required")
body = {"model": model["model"], "messages": [{"role": "user", "content": "Reply exactly READY. Do not use tools."}], "max_tokens": 256, "stream": True}
request = urllib.request.Request(endpoint, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
start = time.monotonic()
result = {"modelAlias": alias, "provider": model["provider"], "host": urllib.parse.urlparse(endpoint).hostname, "request": {"stream": True, "max_tokens": 256}, "credentialValuesRecorded": False, "dataEvents": 0, "reasoningChars": 0, "publicChars": 0, "readySeen": False, "doneSeen": False}
try:
    with urllib.request.urlopen(request, timeout=35) as response:
        result["httpStatus"] = response.status
        for line in response:
            if time.monotonic() - start > 60:
                result["deadlineExceeded"] = True
                break
            if not line.startswith(b"data:"):
                continue
            if "firstDataSeconds" not in result:
                result["firstDataSeconds"] = round(time.monotonic() - start, 3)
            data = line[5:].strip()
            if data == b"[DONE]":
                result["doneSeen"] = True
                break
            event = json.loads(data)
            result["dataEvents"] += 1
            for choice in event.get("choices", []):
                delta = choice.get("delta", {})
                text = delta.get("content") or ""
                result["publicChars"] += len(text)
                result["reasoningChars"] += len(delta.get("reasoning_content") or "")
                result["readySeen"] = result["readySeen"] or "READY" in text
                if choice.get("finish_reason"):
                    result["finishReason"] = choice["finish_reason"]
            if event.get("error"):
                result["streamError"] = True
except urllib.error.HTTPError as error:
    result["httpStatus"] = error.code
except Exception as error:
    result["failureClass"] = type(error).__name__
finally:
    result["elapsedSeconds"] = round(time.monotonic() - start, 3)
    result["sourceConfigurationUnchanged"] = source.read_bytes() == original
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
