#!/usr/bin/env python3
"""Update proof tests. Only synthetic files in a private temporary directory."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


data_proof = load('data_proof', 'local-update-data.py')
freeze_proof = load('freeze_proof', 'freeze-local-build.py')
installer = load('installer', 'local-update-install.py')


class DataRetention(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='blinky-update-proof-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / 'attachments').mkdir()
        (self.data / 'attachments/item').write_text('synthetic opaque bytes')
        (self.data / 'Cache').mkdir()
        (self.data / 'Cache/disposable').write_text('discardable')
        (self.data / 'settings.json').write_text('{"theme":"dark"}')
        (self.data / 'retained-link').symlink_to('attachments/item')
        with sqlite3.connect(self.data / 'sessions.sqlite') as database:
            database.executescript('PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,metadata TEXT);'
                                   'CREATE TABLE messages(session_id TEXT,id TEXT,value TEXT);')
            database.execute('INSERT INTO sessions VALUES(?,?)', ('s', '{}'))
            database.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'm', '{"id":"m","content":"retained","streaming":true}'))
        self.checkpoint = self.root / 'checkpoint'

    def capture(self, full=False):
        return data_proof.checkpoint(self.data, self.checkpoint, full)

    def test_checkpoint_retains_database_settings_and_link_without_cache_copy(self):
        self.capture()
        saved = self.checkpoint / 'mutable-data'
        self.assertTrue((saved / 'sessions.sqlite').is_file())
        self.assertEqual((saved / 'settings.json').read_bytes(), (self.data / 'settings.json').read_bytes())
        self.assertTrue((saved / 'retained-link').is_symlink())
        self.assertFalse((saved / 'Cache').exists())
        self.assertFalse((saved / 'attachments').exists())
        self.assertTrue(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_live_wal_is_included_by_sqlite_backup(self):
        writer = sqlite3.connect(self.data / 'sessions.sqlite')
        self.addCleanup(writer.close)
        writer.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'wal', '{"content":"only in WAL"}'))
        writer.commit()
        self.assertGreater((self.data / 'sessions.sqlite-wal').stat().st_size, 0)
        self.capture()
        self.assertEqual(data_proof.verify(self.data, self.checkpoint)['messagePayloadsPreserved'], 2)

    def test_appending_message_and_clearing_spinner_preserve_prior_content(self):
        self.capture()
        with sqlite3.connect(self.data / 'sessions.sqlite') as database:
            database.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'new', '{"content":"appended"}'))
            database.execute('UPDATE messages SET value=? WHERE id=?', ('{"id":"m","content":"retained","streaming":false}', 'm'))
        self.assertTrue(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_prior_message_change_is_rejected(self):
        self.capture()
        with sqlite3.connect(self.data / 'sessions.sqlite') as database:
            database.execute('UPDATE messages SET value=? WHERE id=?', ('{"content":"wrong"}', 'm'))
        self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_settings_or_attachment_loss_is_rejected(self):
        self.capture()
        (self.data / 'settings.json').write_text('{"theme":"light"}')
        (self.data / 'attachments/item').unlink()
        value = data_proof.verify(self.data, self.checkpoint)
        self.assertFalse(value['ok'])
        self.assertIn('settings.json', value['changedFiles'])
        self.assertIn('attachments/item', value['changedFiles'])

    def test_full_mode_copies_attachment_for_migration(self):
        self.capture(full=True)
        self.assertTrue((self.checkpoint / 'mutable-data/attachments/item').is_file())

    def test_checkpoint_cannot_be_inside_live_data(self):
        with self.assertRaises(RuntimeError):
            data_proof.checkpoint(self.data, self.data / 'nested')

    def test_runtime_info_logs_and_proven_empty_blob_identity_can_change(self):
        level = self.data / 'Local Storage/leveldb'
        level.mkdir(parents=True)
        for name in ['LOG', 'LOG.old', '000003.log', 'MANIFEST-000001', 'CURRENT']:
            (level / name).write_text('synthetic leveldb ' + name)
        empty_name = 'blob_storage/11111111-1111-4111-8111-111111111111'
        (self.data / empty_name).mkdir(parents=True)
        self.capture()
        manifest = json.loads((self.checkpoint / 'checkpoint.json').read_text())
        self.assertEqual(manifest['verificationExclusions']['emptyBlobSessionDirectories'], [empty_name])
        self.assertEqual(manifest['verificationExclusions']['levelDbInfoLogs'], ['Local Storage/leveldb/LOG', 'Local Storage/leveldb/LOG.old'])
        (self.data / empty_name).rmdir()
        (self.data / 'blob_storage/22222222-2222-4222-8222-222222222222').mkdir()
        (level / 'LOG').write_text('new diagnostic')
        (level / 'LOG.old').write_text('rotated diagnostic')
        self.assertTrue(data_proof.verify(self.data, self.checkpoint)['ok'])
        # Numbered .log files are update records, never informational LOG.
        (level / '000003.log').write_text('damaged update bytes')
        result = data_proof.verify(self.data, self.checkpoint)
        self.assertFalse(result['ok'])
        self.assertIn('Local Storage/leveldb/000003.log', result['changedFiles'])

    def test_nonempty_blob_data_is_never_exempted_as_a_runtime_directory(self):
        name = 'blob_storage/33333333-3333-4333-8333-333333333333'
        folder = self.data / name
        folder.mkdir(parents=True)
        (folder / 'payload').write_text('retain this blob payload')
        self.capture()
        manifest = json.loads((self.checkpoint / 'checkpoint.json').read_text())
        self.assertNotIn(name, manifest['verificationExclusions']['emptyBlobSessionDirectories'])
        (folder / 'payload').write_text('damaged blob payload')
        result = data_proof.verify(self.data, self.checkpoint)
        self.assertFalse(result['ok'])
        self.assertIn(name + '/payload', result['changedFiles'])

    def test_session_storage_info_logs_rotate_but_numbered_and_near_paths_remain_checked(self):
        folder = self.data / 'Session Storage'
        folder.mkdir()
        (folder / 'leveldb').mkdir()
        for name in ['LOG', 'LOG.old', '000003.log', 'MANIFEST-000001', 'CURRENT', 'LOCK', 'LOG.backup', 'leveldb/LOG']:
            (folder / name).write_text('synthetic session data ' + name)
        self.capture()
        manifest = json.loads((self.checkpoint / 'checkpoint.json').read_text())
        self.assertEqual(manifest['verificationExclusions']['levelDbInfoLogs'], ['Session Storage/LOG', 'Session Storage/LOG.old'])
        for name in ['LOG', 'LOG.old']:
            (folder / name).write_text('rotated informational diagnostic ' + name)
        self.assertTrue(data_proof.verify(self.data, self.checkpoint)['ok'])
        for name in ['000003.log', 'MANIFEST-000001', 'CURRENT', 'LOCK', 'LOG.backup', 'leveldb/LOG']:
            file = folder / name
            original = file.read_bytes()
            file.write_text('damaged persistent data')
            result = data_proof.verify(self.data, self.checkpoint)
            self.assertFalse(result['ok'], name)
            self.assertIn('Session Storage/' + name, result['changedFiles'])
            file.write_bytes(original)

    def test_settings_accepts_only_sealed_additive_default_and_existing_values_survive(self):
        self.capture()
        (self.data / 'settings.json').write_text('{ "quickDecision":null, "theme":"dark" }')
        self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
        result = data_proof.verify(self.data, self.checkpoint, {'quickDecision': None})
        self.assertTrue(result['ok']); self.assertEqual(result['settingsCompatibility']['addedDefaultKeys'], ['quickDecision'])
        for value in ['{"quickDecision":{},"theme":"dark"}', '{"quickDecision":null,"theme":"light"}',
                      '{"quickDecision":null}', '{"quickDecision":null,"theme":"dark","other":true}']:
            (self.data / 'settings.json').write_text(value)
            self.assertFalse(data_proof.verify(self.data, self.checkpoint, {'quickDecision': None})['ok'])

    def transport(self, delivery='pending', tid='11111111-2222-4333-8444-555555555555'):
        (self.data / 'tasks').mkdir(exist_ok=True)
        task = {'id': tid, 'botId': 'original', 'sessionId': 'executor', 'sourceSessionId': 'source',
                'status': 'completed', 'result': 'synthetic result', 'prompt': 'synthetic objective',
                'deliveryStatus': delivery, 'createdAt': 10, 'updatedAt': 20,
                'acceptance': {'required': True}}
        (self.data / 'tasks' / (tid + '.json')).write_text(json.dumps(task))
        return task

    def test_empty_profile_image_default_requires_exact_seal_and_preserves_other_profile_keys(self):
        before = {'theme': 'dark', 'profileName': 'Saved identity', 'profileEmoji': 'fixture', 'profileColor': 'blue'}
        (self.data / 'settings.json').write_text(json.dumps(before)); self.capture()
        (self.data / 'settings.json').write_text(json.dumps({**before, 'profileImage': ''}))
        self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
        self.assertFalse(data_proof.verify(self.data, self.checkpoint, {'quickDecision': None})['ok'])
        self.assertTrue(data_proof.verify(self.data, self.checkpoint, {'profileImage': ''})['ok'])
        for key in ['theme', 'profileName', 'profileEmoji', 'profileColor']:
            (self.data / 'settings.json').write_text(json.dumps({**before, 'profileImage': '', key: 'changed'}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint, {'profileImage': ''})['ok'], key)
        for value in [None, False, [], 'nonempty']:
            (self.data / 'settings.json').write_text(json.dumps({**before, 'profileImage': value}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint, {'profileImage': ''})['ok'])
            with self.assertRaisesRegex(RuntimeError, 'explicitly sealed'):
                data_proof.verify(self.data, self.checkpoint, {'profileImage': value})

    def test_additive_profile_default_cannot_replace_existing_profile_image(self):
        before = {'theme': 'dark', 'profileImage': 'synthetic existing image'}
        (self.data / 'settings.json').write_text(json.dumps(before)); self.capture()
        (self.data / 'settings.json').write_text(json.dumps({**before, 'profileImage': '', 'quickDecision': None}))
        self.assertFalse(data_proof.verify(self.data, self.checkpoint, {'quickDecision': None, 'profileImage': ''})['ok'])
        (self.data / 'settings.json').write_text(json.dumps({**before, 'quickDecision': None}))
        self.assertTrue(data_proof.verify(self.data, self.checkpoint, {'quickDecision': None, 'profileImage': ''})['ok'])

    def test_only_sealed_transport_receipt_progress_is_compatible(self):
        task = self.transport(); self.capture()
        for status in ['delivering', 'delivered', 'uncertain']:
            (self.data / 'tasks' / (task['id'] + '.json')).write_text(json.dumps({**task, 'deliveryStatus': status, 'updatedAt': 21}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
            result = data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])
            self.assertTrue(result['ok'], status)
            self.assertEqual(result['transportTaskDeliveryCompatibility']['from'], 'pending')
            self.assertEqual(result['transportTaskDeliveryCompatibility']['to'], status)

    def test_transport_execution_identity_payload_and_other_tasks_stay_strict(self):
        task = self.transport(); other = self.transport(tid='66666666-7777-4888-8999-000000000000'); self.capture()
        path = self.data / 'tasks' / (task['id'] + '.json')
        moved = {**task, 'deliveryStatus': 'delivered', 'updatedAt': 21}
        for field, value in [('status', 'running'), ('id', other['id']), ('botId', 'different'),
                             ('sessionId', 'different'), ('sourceSessionId', 'different'),
                             ('result', 'wrong'), ('prompt', 'wrong'), ('createdAt', 11),
                             ('acceptance', {'required': 1}), ('newField', 'unexpected')]:
            path.write_text(json.dumps({**moved, field: value}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'], field)
        path.write_text(json.dumps(moved))
        other_path = self.data / 'tasks' / (other['id'] + '.json')
        other_path.write_text(json.dumps({**other, 'deliveryStatus': 'delivered', 'updatedAt': 21}))
        result = data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])
        self.assertFalse(result['ok']); self.assertIn('tasks/' + other['id'] + '.json', result['changedFiles'])

    def test_transport_receipt_cannot_regress_or_forge_timestamps(self):
        task = self.transport('delivering'); self.capture()
        path = self.data / 'tasks' / (task['id'] + '.json')
        for status in ['delivered', 'uncertain']:
            path.write_text(json.dumps({**task, 'deliveryStatus': status, 'updatedAt': 21}))
            self.assertTrue(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'])
        for change in [{'deliveryStatus': 'pending'}, {'deliveryStatus': 'delivering'}, {'deliveryStatus': []},
                       {'updatedAt': 19}, {'updatedAt': True}, {'updatedAt': float('nan')}, {'updatedAt': '21'}]:
            path.write_text(json.dumps({**task, 'deliveryStatus': 'delivered', 'updatedAt': 21, **change}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'], change)
        for tid in ['../settings', 'tasks/invalid.json', '', True]:
            with self.assertRaisesRegex(RuntimeError, 'exact UUID'):
                data_proof.verify(self.data, self.checkpoint, transport_task_id=tid)

    def test_transport_checkpoint_bytes_file_type_and_permissions_remain_strict(self):
        task = self.transport(); self.capture()
        path = self.data / 'tasks' / (task['id'] + '.json')
        moved = json.dumps({**task, 'deliveryStatus': 'delivered', 'updatedAt': 21})
        path.write_text(moved); original_mode = path.stat().st_mode & 0o777
        path.chmod(original_mode ^ 0o040)
        self.assertFalse(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'])
        path.chmod(original_mode)
        copied = self.checkpoint / 'mutable-data/tasks' / (task['id'] + '.json')
        copied.write_text(json.dumps({**task, 'prompt': 'tampered checkpoint'}))
        self.assertFalse(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'])
        copied.write_text(json.dumps(task)); path.unlink(); path.symlink_to(copied)
        self.assertFalse(data_proof.verify(self.data, self.checkpoint, transport_task_id=task['id'])['ok'])


    def atomic_residue(self, change=None):
        task = self.transport('delivered')
        temporary = self.data / 'tasks' / (task['id'] + '.json.888881.abc12345.tmp')
        value = {**task, 'deliveryStatus': 'delivering', 'updatedAt': 19}
        if change is not None:
            value.update(change)
        temporary.write_text(json.dumps(value))
        old = time.time_ns() - 2 * 60 * 60 * 1_000_000_000
        os.utime(temporary, ns=(old, old))
        return task, temporary

    def test_stale_atomic_receipt_cleanup_preserves_committed_task_and_checkpoint(self):
        task, temporary = self.atomic_residue()
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            saved = self.checkpoint / 'mutable-data' / temporary.relative_to(self.data)
            before = saved.read_bytes()
            result = data_proof.verify(self.data, self.checkpoint)
            self.assertTrue(result['ok'])
            self.assertEqual(result['redundantAtomicTempCleanup'][0]['equivalence'], 'same-terminal-task-receipt-progress')
            self.assertEqual(saved.read_bytes(), before)
            self.assertEqual(json.loads((self.data / 'tasks' / (task['id'] + '.json')).read_text()), task)

    def test_stale_identical_terminal_task_temp_is_redundant(self):
        task, temporary = self.atomic_residue({'deliveryStatus': 'delivered', 'updatedAt': 20})
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            result = data_proof.verify(self.data, self.checkpoint)
            self.assertTrue(result['ok'])
            self.assertEqual(result['redundantAtomicTempCleanup'][0]['equivalence'], 'byte-identical')

    def test_uncommitted_payload_is_never_waived_as_temp_cleanup(self):
        _, temporary = self.atomic_residue({'result': 'new uncommitted result'})
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            result = data_proof.verify(self.data, self.checkpoint)
            self.assertFalse(result['ok']); self.assertEqual(result['redundantAtomicTempCleanup'], [])

    def test_recent_temp_is_not_aged_by_later_readback(self):
        _, temporary = self.atomic_residue()
        now = time.time_ns(); os.utime(temporary, ns=(now, now))
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            manifest = self.checkpoint / 'checkpoint.json'
            future = now + 4 * 60 * 60 * 1_000_000_000
            os.utime(manifest, ns=(future, future))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_temp_owner_must_be_gone_at_checkpoint_and_readback(self):
        _, temporary = self.atomic_residue()
        with patch.object(data_proof, 'pid_is_alive', return_value=True):
            self.capture(); temporary.unlink()
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
        manifest = self.checkpoint / 'checkpoint.json'; value = json.loads(manifest.read_text())
        value['atomicTaskTempObservations'][str(temporary.relative_to(self.data))]['ownerExited'] = True
        manifest.write_text(json.dumps(value))
        with patch.object(data_proof, 'pid_is_alive', return_value=True):
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_legacy_checkpoint_gets_no_automatic_temp_exception(self):
        _, temporary = self.atomic_residue()
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            manifest = self.checkpoint / 'checkpoint.json'; value = json.loads(manifest.read_text())
            value.pop('capturedAtUnixNs'); value.pop('atomicTaskTempObservations')
            manifest.write_text(json.dumps(value))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_temp_cleanup_requires_unchanged_committed_target_and_intact_copy(self):
        task, temporary = self.atomic_residue()
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink()
            target = self.data / 'tasks' / (task['id'] + '.json')
            target.write_text(json.dumps({**task, 'result': 'changed committed result'}))
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
            target.write_text(json.dumps(task))
            copied = self.checkpoint / 'mutable-data' / temporary.relative_to(self.data)
            before = copied.read_bytes(); mode = copied.stat().st_mode & 0o777
            copied.chmod(mode ^ 0o040)
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
            copied.chmod(mode); copied.write_text('tampered checkpoint')
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])
            copied.write_bytes(before)
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'], 'mtime tampering is also rejected')

    def test_changed_temp_still_present_is_not_cleanup(self):
        _, temporary = self.atomic_residue()
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.write_text('new in-flight bytes')
            self.assertFalse(data_proof.verify(self.data, self.checkpoint)['ok'])

    def test_other_temp_paths_symlinks_and_receipt_regression_stay_strict(self):
        _, temporary = self.atomic_residue({'deliveryStatus': 'uncertain', 'updatedAt': 30})
        other = self.data / 'settings.json.888881.abc12345.tmp'; other.write_bytes((self.data / 'settings.json').read_bytes())
        link = self.data / 'tasks/66666666-7777-4888-8999-000000000000.json.888881.abc12345.tmp'
        link.symlink_to(temporary.name)
        with patch.object(data_proof, 'pid_is_alive', return_value=False):
            self.capture(); temporary.unlink(); other.unlink(); link.unlink()
            result = data_proof.verify(self.data, self.checkpoint)
            self.assertFalse(result['ok']); self.assertEqual(result['redundantAtomicTempCleanup'], [])
            self.assertEqual(len(result['changedFiles']), 3)

    def test_owner_probe_permission_failure_is_not_exit_proof(self):
        with patch.object(data_proof.os, 'kill') as signal:
            for invalid in [0, -1, 2**31, True]:
                self.assertTrue(data_proof.pid_is_alive(invalid))
            signal.assert_not_called()
        for failure, alive in [(ProcessLookupError(), False), (PermissionError(), True), (OSError(), True)]:
            with patch.object(data_proof.os, 'kill', side_effect=failure):
                self.assertEqual(data_proof.pid_is_alive(888881), alive)


class FrozenBuild(unittest.TestCase):
    def test_untracked_source_dependency_drift_and_generated_output(self):
        with tempfile.TemporaryDirectory(prefix='blinky-freeze-proof-') as name:
            root = Path(name)
            repo = root / 'repo'
            repo.mkdir()
            (repo / 'node_modules').mkdir()
            (repo / 'node_modules/fixture').write_text('fixed dependency')
            (repo / 'empty-resource').mkdir()
            (repo / 'new-untracked.ts').write_text('export const a=1')
            (repo / 'out').mkdir()
            (repo / 'out/generated').write_text('ignore generated output')
            (repo / 'docs').mkdir()
            (repo / 'docs/report.md').write_text('delivery evidence')
            (repo / '.env').write_text('SYNTHETIC_FIXTURE=opaque')
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=fixture', '-c',
                            'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'], check=True)
            freeze_proof.freeze(repo, root / 'freeze')
            manifest = root / 'freeze/manifest.json'
            self.assertTrue((root / 'freeze/source/empty-resource').is_dir())
            self.assertTrue((root / 'freeze/source/new-untracked.ts').is_file())
            self.assertFalse((root / 'freeze/source/out').exists())
            self.assertFalse((root / 'freeze/source/docs').exists())
            self.assertFalse((root / 'freeze/source/.env').exists())
            self.assertTrue(freeze_proof.verify(manifest)['ok'])
            (repo / 'out/generated').write_text('new generated output')
            (repo / 'docs/report.md').write_text('later evidence')
            (repo / '.env').write_text('SYNTHETIC_FIXTURE=changed')
            self.assertTrue(freeze_proof.verify(manifest)['ok'])
            (repo / 'node_modules/fixture').write_text('modified dependency')
            self.assertFalse(freeze_proof.verify(manifest)['ok'])
            (repo / 'node_modules/fixture').write_text('fixed dependency')
            (repo / 'new-untracked.ts').write_text('modified source')
            self.assertFalse(freeze_proof.verify(manifest)['ok'])


class HandoffBoundaries(unittest.TestCase):
    def test_after_gate_allows_only_original_source_run_and_new_pure_status_queue(self):
        with tempfile.TemporaryDirectory(prefix='blinky-post-update-status-') as name:
            helper = installer.Installer.__new__(installer.Installer)
            helper.data = Path(name)
            helper.cfg = {'transportTaskId': 'task', 'transportTaskSessionId': 'executor', 'transportSessionIds': ['source', 'executor'],
                          'sourceSessionId': 'source', 'originalBotId': 'lead', 'userMessagesAtHandoff': {'["source","old-message"]': 'hash'},
                          'queuedItemIdsAtHandoff': {'source': ['old-queued']}}
            view = {'tasks': [], 'runs': [{'id': 'source', 'running': True}]}
            helper.runtime = lambda *args, **kwargs: view
            queue_file = helper.data / 'message-queues.json'
            def queue(items, sid='source'):
                queue_file.write_text(json.dumps({'queues': {sid: {'items': items}}}))
            helper.gate(61234, after=True)
            queue([{'id': 'new-status', 'text': '目前进展怎么样'}])
            helper.gate(61234, after=True)
            for items, sid in [([{'id': 'new-work', 'text': '另外改一个功能'}], 'source'),
                               ([{'id': 'old-queued', 'text': '进度？'}], 'source'),
                               ([{'id': 'old-message', 'text': '进度？'}], 'source'),
                               ([{'id': 'new-status', 'text': '进度？', 'attachments': [{}]}], 'source'),
                               ([{'id': 'new-status', 'text': '进度？'}, {'id': 'new-work', 'text': '先别装'}], 'source'),
                               ([{'id': 'new-status', 'text': '进度？'}], 'executor')]:
                queue(items, sid)
                with self.assertRaisesRegex(RuntimeError, 'pending message queue'):
                    helper.gate(61234, after=True)
            queue([])
            for sid in ['executor', 'other']:
                view['runs'] = [{'id': sid, 'running': True}]
                with self.assertRaisesRegex(RuntimeError, 'Another conversation'):
                    helper.gate(61234, after=True)
            view['runs'] = [{'id': 'source', 'running': True}]
            view['tasks'] = [{'id': 'task', 'status': 'running'}]
            with self.assertRaisesRegex(RuntimeError, 'Other business tasks'):
                helper.gate(61234, after=True)

    def test_failed_installed_verification_closes_only_its_recorded_inspector(self):
        helper = installer.Installer.__new__(installer.Installer)
        helper.state = {'installed': True, 'newPid': 12345, 'newPort': 61234, 'installationVerified': False}
        calls = []
        helper.runtime = lambda action, port: calls.append((action, port))
        helper.app_pids = lambda: {12345}
        helper.mark = lambda phase, **values: helper.state.update(phase=phase, **values)
        with patch.object(installer.socket, 'create_connection', side_effect=OSError('closed')):
            helper.cleanup_failed_install_inspector()
        self.assertEqual(calls, [('close-inspector', 61234)])
        self.assertEqual(helper.state['phase'], 'installed_verification_failed')
        self.assertFalse(helper.state['installationVerified'])
        self.assertTrue(helper.state['temporaryInspectorClosed'])

    def test_failed_installed_verification_never_closes_an_unowned_process(self):
        helper = installer.Installer.__new__(installer.Installer)
        helper.state = {'installed': True, 'newPid': 12345, 'newPort': 61234}
        calls = []
        helper.runtime = lambda action, port: calls.append((action, port))
        helper.app_pids = lambda: {99999}
        helper.mark = lambda phase, **values: helper.state.update(phase=phase, **values)
        helper.cleanup_failed_install_inspector()
        self.assertEqual(calls, [])
        self.assertFalse(helper.state['temporaryInspectorClosed'])
        self.assertEqual(helper.state['temporaryInspectorPort'], 61234)
        self.assertIn('identity changed', helper.state['inspectorCleanupError'])

    def test_inspector_close_bridge_is_sealed_to_the_expected_pid(self):
        with tempfile.TemporaryDirectory(prefix='blinky-inspector-identity-') as name:
            helper = installer.Installer.__new__(installer.Installer)
            helper.root = Path(name)
            helper.app = helper.root / 'BlinkyBot.app'
            helper.data = helper.root / 'data'
            helper.cfg = {'nodePath': '/fixture/node', 'helperDir': '/fixture/helpers'}
            helper.state = {'newPid': 12345}
            def bridge(*args, **kwargs):
                config = json.loads((helper.root / 'runtime-config.json').read_text())
                self.assertEqual(config['expectedPid'], 12345)
                Path(config['output']).write_text('{}')
            with patch.object(installer.subprocess, 'run', side_effect=bridge):
                helper.runtime('close-inspector', 61234)

    def test_old_app_recovery_closes_its_new_inspector_and_checks_the_port(self):
        helper = installer.Installer.__new__(installer.Installer)
        helper.state = {'newPid': 12345}
        helper.start = lambda: 61234
        calls = []
        helper.runtime = lambda action, port: calls.append((action, port))
        helper.app_pids = lambda: {12345}
        helper.mark = lambda phase, **values: helper.state.update(phase=phase, **values)
        with patch.object(installer.socket, 'create_connection', side_effect=OSError('closed')) as connection:
            helper.recover_old_app(RuntimeError('fixture pre-install failure'), 'checkpointing')
        self.assertEqual(calls, [('close-inspector', 61234)])
        connection.assert_called_once_with(('127.0.0.1', 61234), timeout=.1)
        self.assertTrue(helper.state['oldAppRestarted'])
        self.assertTrue(helper.state['oldAppTemporaryInspectorClosed'])

    def test_old_app_recovery_records_inspector_cleanup_failure_separately(self):
        helper = installer.Installer.__new__(installer.Installer)
        helper.state = {'newPid': 12345}
        helper.start = lambda: 61234
        helper.runtime = lambda action, port: (_ for _ in ()).throw(RuntimeError('fixture close failure'))
        helper.app_pids = lambda: {12345}
        helper.mark = lambda phase, **values: helper.state.update(phase=phase, **values)
        helper.recover_old_app(RuntimeError('fixture pre-install failure'), 'checkpointing')
        self.assertTrue(helper.state['oldAppRestarted'])
        self.assertFalse(helper.state['oldAppTemporaryInspectorClosed'])
        self.assertEqual(helper.state['oldAppTemporaryInspectorPort'], 61234)

    def test_status_questions_do_not_revoke_authorization_but_new_work_holds(self):
        for text in ['进度？', '状态呢', '完成了吗？', '还没好吗？', 'status?', 'Any update?', 'Any updates?', '现在进度如何', '目前进展怎么样', '做到哪一步了', '怎么还没好']:
            self.assertTrue(installer.is_status_query(text), text)
        for text in ['暂停', '先不要更新', '停止安装', '进度？另外把数据删掉', '请加一个新功能', '进度怎样，先别装', '目前进度如何，改成测试版', 'status pause install']:
            self.assertFalse(installer.is_status_query(text), text)

    def test_new_user_message_hold_and_explicit_cancel(self):
        with tempfile.TemporaryDirectory(prefix='blinky-handoff-proof-') as name:
            root = Path(name)
            data = root / 'data'
            data.mkdir()
            with sqlite3.connect(data / 'sessions.sqlite') as database:
                database.execute('CREATE TABLE messages(session_id TEXT,id TEXT,value TEXT)')
                database.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'authorization', '{"role":"user","content":"更新"}'))
            config = {'app': str(root / 'BlinkyBot.app'), 'candidateApp': str(root / 'candidate.app'),
                      'dataDir': str(data), 'watchSessionIds': ['s'], 'rehearsal': True,
                      'userMessagesAtHandoff': installer.message_fingerprints(installer.user_messages(data, ['s']))}
            (root / 'config.json').write_text(json.dumps(config))
            helper = installer.Installer(root)
            helper.boundary()
            with sqlite3.connect(data / 'sessions.sqlite') as database:
                database.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'status', '{"role":"user","content":"进度？"}'))
            helper.boundary()
            with sqlite3.connect(data / 'sessions.sqlite') as database:
                database.execute('INSERT INTO messages VALUES(?,?,?)', ('s', 'pause', '{"role":"user","content":"暂停"}'))
            with self.assertRaisesRegex(RuntimeError, 'new user instruction'):
                helper.boundary()
            (root / 'CANCEL').write_text('stop')
            with self.assertRaisesRegex(RuntimeError, 'explicitly cancelled'):
                helper.boundary()

    def test_rehearsal_never_accepts_formal_data(self):
        with self.assertRaisesRegex(RuntimeError, 'temporary App and data'):
            installer.validate_paths({'rehearsal': True, 'app': '/private/tmp/fixture/BlinkyBot.app',
                                      'dataDir': '/Users/example/Library/Application Support/BlinkyBot'})


if __name__ == '__main__':
    unittest.main()
