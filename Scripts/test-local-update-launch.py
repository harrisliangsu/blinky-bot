#!/usr/bin/env python3
"""Regression for Background installer -> normally scheduled GUI launch.
Only mocked processes and private synthetic paths; no installer is run.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('installer_launch', Path(__file__).with_name('local-update-install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ApplicationLaunch(unittest.TestCase):
    def setUp(self):
        listener = MagicMock()
        listener.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 62500)
        socket_patch = patch.object(installer.socket, 'socket', return_value=listener)
        socket_patch.start()
        self.addCleanup(socket_patch.stop)
        self.temp = tempfile.TemporaryDirectory(prefix='blinky-launch-contract-')
        self.addCleanup(self.temp.cleanup)
        self.helper = installer.Installer.__new__(installer.Installer)
        self.helper.root = Path(self.temp.name)
        self.helper.app = self.helper.root / 'App with spaces.app'
        self.helper.cfg = {}
        self.helper.state = {}
        self.helper.mark = lambda phase, **values: self.helper.state.update(phase=phase, **values)

    def test_launchservices_pid_is_discovered_separately_from_open_process(self):
        self.helper.app_pids = MagicMock(side_effect=[set(), set(), {12345}])
        with patch.object(installer.subprocess, 'run') as run, patch.object(installer.socket, 'create_connection') as connect, patch.object(installer.time, 'sleep'), patch.dict(os.environ, {'HOME': '/synthetic/home', 'TEST_SECRET': 'never-transfer'}):
            port = self.helper.start()
        args = run.call_args.args[0]
        self.assertEqual(args[:4], ['/usr/bin/open', '-n', '-a', str(self.helper.app)])
        self.assertIn('HOME=/synthetic/home', args)
        self.assertNotIn('TEST_SECRET=never-transfer', args)
        self.assertNotIn('TEST_SECRET', run.call_args.kwargs['env'])
        self.assertEqual(self.helper.state['newPid'], 12345)
        self.assertEqual(self.helper.state['newPort'], port)
        self.assertEqual(self.helper.state['launchMethod'], 'LaunchServices')
        connect.assert_called_once_with(('127.0.0.1', port), timeout=.2)

    def test_existing_application_prevents_duplicate_launch(self):
        self.helper.app_pids = lambda: {12345}
        with patch.object(installer.subprocess, 'run') as run, self.assertRaisesRegex(RuntimeError, 'already running'):
            self.helper.start()
        run.assert_not_called()

    def test_failed_launchservices_does_not_fall_back_to_background_spawn(self):
        self.helper.app_pids = lambda: set()
        with patch.object(installer.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'open')) as run, patch.object(installer.subprocess, 'Popen') as spawn, self.assertRaises(subprocess.CalledProcessError):
            self.helper.start()
        run.assert_called_once()
        spawn.assert_not_called()

    def test_multiple_pids_never_pass_inspector_readiness(self):
        self.helper.app_pids = MagicMock(side_effect=[set(), {12345, 23456}])
        with patch.object(installer.subprocess, 'run'), patch.object(installer.socket, 'create_connection') as connect, self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            self.helper.start()
        connect.assert_not_called()

    def test_exited_application_cannot_be_reported_as_launched(self):
        self.helper.app_pids = MagicMock(side_effect=[set(), {12345}, set()])
        with patch.object(installer.subprocess, 'run'), patch.object(installer.socket, 'create_connection', side_effect=OSError()), patch.object(installer.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'exited'):
            self.helper.start()


if __name__ == '__main__':
    unittest.main()
