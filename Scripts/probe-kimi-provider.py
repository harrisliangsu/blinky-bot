"""One diagnostic request to an existing provider; credentials stay in memory."""
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
before = source.read_bytes()
config = tomllib.loads(before.decode())
alias = config["default_model"]
model = config["models"][alias]
provider = config["providers"][model["provider"]]
key = provider.get("api_key")
if not key:
    raise RuntimeError("The selected API-key provider has no existing credential")
endpoint = provider["base_url"].rstrip("/") + "/chat/completions"
url = urllib.parse.urlparse(endpoint)
if url.scheme != "https" and url.hostname not in ("localhost", "127.0.0.1"):
    raise RuntimeError("The configured credential endpoint is not protected")
result = {"modelAlias": alias, "provider": model["provider"], "host": url.hostname, "credentialValuesCopied": False, "mcp": False}
body = json.dumps({"model": model["model"], "messages": [{"role": "user", "content": "Reply exactly READY. Do not use tools."}], "max_tokens": 256, "stream": False}).encode()
request = urllib.request.Request(endpoint, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
started = time.monotonic()
try:
    with urllib.request.urlopen(request, timeout=35) as response:
        result["httpStatus"] = response.status
        packet = json.load(response)
        choice = next(iter(packet.get("choices", [])), {})
        message = choice.get("message", {})
        result.update({"publicReplySeen": bool(message.get("content")), "readySeen": "READY" in (message.get("content") or ""), "reasoningSeen": bool(message.get("reasoning_content")), "finishReason": choice.get("finish_reason")})
except urllib.error.HTTPError as error:
    result["httpStatus"] = error.code
    try:
        packet = json.loads(error.read())
        detail = packet.get("error", packet)
        code = str(detail.get("code", ""))
        if code != key and len(code) < 80:
            result["providerCode"] = code
        text = str(detail.get("message", "")).lower()
        result["failureClass"] = "authentication" if any(word in text for word in ["api key", "apikey", "unauthorized", "认证", "鉴权", "令牌"]) else "quota" if any(word in text for word in ["balance", "quota", "余额", "用完", "次数"]) else "rate_limit" if any(word in text for word in ["limit", "速率", "频率", "并发"]) else "model" if "model" in text or "模型" in text else "provider_error"
    except Exception:
        result["failureClass"] = "provider_http_error"
except Exception as error:
    result["failureClass"] = type(error).__name__
finally:
    result["elapsedSeconds"] = round(time.monotonic() - started, 2)
    result["sourceConfigurationUnchanged"] = source.read_bytes() == before
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))
