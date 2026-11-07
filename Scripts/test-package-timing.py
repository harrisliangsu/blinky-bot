#!/usr/bin/env python3
"""Real elapsed-time and failure-code proof; never builds or launches an App."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class PackageTiming(unittest.TestCase):
    def test_same_process_clock_brackets_child_and_preserves_failure(self):
        with tempfile.TemporaryDirectory(prefix='blinky-package-time-') as name:
            output = Path(name) / 'stages.jsonl'
            script = Path(__file__).with_name('package-timing.sh').resolve()
            code = 'source "$1"; export BLINKY_PACKAGE_TIMINGS="$2"; shift 2; package_step fixture "$@"'
            passed = subprocess.run(['bash', '-c', code, '_', str(script), str(output), '/bin/sleep', '0.2'], capture_output=True, text=True)
            failed = subprocess.run(['bash', '-c', code, '_', str(script), str(output), '/bin/sh', '-c', 'exit 7'], capture_output=True, text=True)
            self.assertEqual(passed.returncode, 0)
            self.assertEqual(failed.returncode, 7)
            values = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertGreaterEqual(values[0]['seconds'], .18)
            self.assertEqual(values[0]['exitCode'], 0)
            self.assertEqual(values[1]['exitCode'], 7)


if __name__ == '__main__':
    unittest.main()
