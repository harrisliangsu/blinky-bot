"""Prepare a minimal temporary CLI profile; never print credential values."""
import argparse
import json
import os
from pathlib import Path
import tomllib
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("--kind", choices=["codex", "kimi"], required=True)
parser.add_argument("--dest", required=True)
parser.add_argument("--source-home", required=True)
parser.add_argument("--model", help="An already configured alias; never supplies a credential")
args = parser.parse_args()
source = Path(args.source_home)
dest = Path(args.dest)
dest.mkdir(mode=0o700, parents=True, exist_ok=True)

def scalar(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(scalar(item) for item in value) + "]"
    raise TypeError("Unsupported minimal profile field")

def table_lines(name, fields):
    return ["[" + ".".join(json.dumps(part) for part in name) + "]"] + [
        json.dumps(key) + " = " + scalar(value)
        for key, value in fields.items()
        if not isinstance(value, dict)
    ]

if args.kind == "codex":
    config = tomllib.loads((source / ".codex/config.toml").read_text())
    model = config.get("model", "default")
    provider = config.get("model_provider", "openai")
    lines = ['model = ' + scalar(model), 'cli_auth_credentials_store = "file"']
    if provider != "openai":
        lines.append("model_provider = " + scalar(provider))
        lines += table_lines(["model_providers", provider], config["model_providers"][provider])
    # No user hooks, plugins, project instructions, global MCPs or sessions.
    auth = source / ".codex/auth.json"
    if auth.is_file():
        target = dest / "auth.json"
        target.write_bytes(auth.read_bytes())
        target.chmod(0o600)
    (dest / "config.toml").write_text("\n".join(lines) + "\n")
else:
    config = tomllib.loads((source / ".kimi-code/config.toml").read_text())
    model = args.model or config["default_model"]
    selected = config["models"][model]
    provider = selected["provider"]
    settings = config["providers"][provider]
    lines = ["default_model = " + scalar(model)]
    oauth = settings.get("oauth", {})
    if oauth.get("storage") == "file" and oauth.get("key"):
        # Only non-secret credential references are materialized. Match the
        # existing, independently verified managed Kimi CLI setup.
        public_settings = {key: value for key, value in settings.items() if key != "api_key"}
        lines += table_lines(["providers", provider], public_settings)
        lines += table_lines(["providers", provider, "oauth"], oauth)
        credential_source = source / ".kimi-code/credentials"
        if not credential_source.is_dir():
            raise RuntimeError("The configured OAuth credential store is unavailable")
        (dest / "credentials").symlink_to(credential_source, target_is_directory=True)
        credential_mode = "existing-oauth-reference"
    elif settings.get("api_key") and not oauth:
        # The launcher loads the existing value only into the native child's
        # environment. The profile stores a variable name, never its value.
        observation_url = os.environ.get("BLINKY_PLANNING_OBSERVER_BASE_URL")
        observation = urllib.parse.urlparse(observation_url or "")
        if observation_url and (observation.scheme != "http" or observation.hostname != "127.0.0.1" or not observation.port or observation.query or observation.fragment):
            raise RuntimeError("The diagnostic observer must be this task's loopback endpoint")
        lines += table_lines(["providers", provider], {
            "type": settings["type"], "base_url": settings["base_url"],
            "api_key_env": "BLINKY_PLANNING_PROVIDER_KEY"
        } if not observation_url else {
            "type": settings["type"], "base_url": observation_url,
            "api_key": "synthetic-placeholder-not-a-credential"
        })
        credential_mode = "existing-api-key-environment-reference" if not observation_url else "synthetic-placeholder-with-original-provider-observer"
    else:
        raise RuntimeError("The selected model has no supported existing credential reference")
    lines += table_lines(["models", model], selected)
    (dest / "config.toml").write_text("\n".join(lines) + "\n")
(dest / "config.toml").chmod(0o600)
print(json.dumps({"kind": args.kind, "model": model, "provider": provider, "profile": str(dest), "credentialMode": credential_mode if args.kind == "kimi" else "existing-codex-auth", "credentialValuesCopied": args.kind == "codex"}))
