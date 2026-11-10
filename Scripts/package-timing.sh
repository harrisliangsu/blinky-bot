#!/usr/bin/env bash
# Shared stage timing. No source, settings or credentials are recorded.
package_timing_init() {
    BLINKY_PACKAGE_TIMINGS="${BLINKY_PACKAGE_TIMINGS:-$PWD/release/package-timings-$(date +%Y%m%d-%H%M%S)-$$.jsonl}"
    export BLINKY_PACKAGE_TIMINGS
    mkdir -p "$(dirname "$BLINKY_PACKAGE_TIMINGS")"
}

package_step() {
    local name="$1"
    shift
    # macOS Python 3.9 may use a process-relative monotonic origin. The same
    # process must bracket the actual child, rather than subtracting two CLIs.
    python3 - "$BLINKY_PACKAGE_TIMINGS" "$name" "$@" <<'PY'
import datetime, json, subprocess, sys, time
started = time.monotonic()
try:
    result = subprocess.run(sys.argv[3:]).returncode
    if result < 0:
        result = 128 - result
except KeyboardInterrupt:
    result = 130
except OSError as error:
    print(str(error), file=sys.stderr)
    result = 127
value = {'stage': sys.argv[2], 'seconds': round(time.monotonic() - started, 3),
         'exitCode': result, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(sys.argv[1], 'a') as f:
    f.write(json.dumps(value) + '\n')
print('[package] ' + json.dumps(value))
sys.exit(result)
PY
}
