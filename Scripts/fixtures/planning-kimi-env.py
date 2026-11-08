"""Inject an existing provider identity only into the native CLI process."""
import argparse
import json
import os
from pathlib import Path
import sys
import tomllib
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("--source-config", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--binary", required=True)
parser.add_argument("--node-preload")
parser.add_argument("--network-trace")
parser.add_argument("native_args", nargs=argparse.REMAINDER)
args = parser.parse_args()
config = tomllib.loads(Path(args.source_config).read_text())
selected = config["models"][args.model]
provider = config["providers"][selected["provider"]]
if urllib.parse.urlparse(provider["base_url"]).scheme != "https":
    raise RuntimeError("The original configured provider must use HTTPS")
key = provider.get("api_key")
if not isinstance(key, str) or not key:
    raise RuntimeError("The selected existing provider credential is unavailable")
env = os.environ.copy()
env["BLINKY_PLANNING_PROVIDER_KEY"] = key
if args.node_preload:
    env["NODE_OPTIONS"] = "--require=" + json.dumps(args.node_preload)
    env["BLINKY_GLM_NETWORK_TRACE"] = args.network_trace
native_args = args.native_args[1:] if args.native_args[:1] == ["--"] else args.native_args
os.execve(args.binary, [args.binary, *native_args], env)
