#!/usr/bin/env python3
"""Private checkpoint and readback for local updates; never restores or edits source data.

The installer must first gate other work and normally quit the App. SQLite uses
the backup API (also safe with WAL), rather than copying a live database file.
Compatible updates copy mutable records and hash attachments in place. Select
--full only when the migration can modify attachments or other excluded files.
No plaintext settings, messages or credentials are printed or put in reports.
"""
import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import time

MESSAGE_FINGERPRINT_ALGORITHM = 'canonical-json-v1-ignore-top-level-streaming'

CACHE_NAMES = {'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
               'Crashpad', 'Dictionaries', 'logs', 'cache', 'browser', 'backups', 'boxes'}
TRANSIENT_NAMES = {'sessions.sqlite-wal', 'sessions.sqlite-shm', 'SingletonLock',
                   'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile'}
LEVELDB_INFO_LOGS = {'Local Storage/leveldb/LOG', 'Local Storage/leveldb/LOG.old',
                    'Session Storage/LOG', 'Session Storage/LOG.old'}


def runtime_verification_exclusions(files):
    # LOG/LOG.old are LevelDB informational diagnostics, not numbered *.log
    # update records. Blob context UUID folders are per-run identities, but
    # exempt only directories proven childless by the cold checkpoint itself.
    empty_blob_directories = []
    for name, item in files.items():
        if (item['kind'] == 'directory'
                and re.fullmatch(r'blob_storage/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', name)
                and not any(child.startswith(name + '/') for child in files)):
            empty_blob_directories.append(name)
    return {'levelDbInfoLogs': sorted(name for name in LEVELDB_INFO_LOGS if files.get(name, {}).get('kind') == 'file'),
            'emptyBlobSessionDirectories': sorted(empty_blob_directories)}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def inventory(root, full=False):
    result = {}
    for folder, directories, files in os.walk(root, followlinks=False):
        relative = Path(folder).relative_to(root)
        if relative == Path('.') and not full:
            directories[:] = [name for name in directories if name not in CACHE_NAMES]
        for name in directories + files:
            path = Path(folder) / name
            rel = str(path.relative_to(root))
            if rel in TRANSIENT_NAMES or rel == 'sessions.sqlite':
                continue
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if path.is_symlink():
                result[rel] = {'kind': 'symlink', 'target': os.readlink(path), 'mode': mode}
            elif path.is_file():
                result[rel] = {'kind': 'file', 'sha256': digest(path), 'bytes': info.st_size, 'mode': mode}
            elif path.is_dir():
                result[rel] = {'kind': 'directory', 'mode': mode}
            else:
                raise RuntimeError('Special file in persistent data: ' + rel)
    return result


def message_payload_fingerprint(raw):
    """Compare JSON payload semantics, never SQLite JSON1 serialization order.

    Only the documented transient top-level spinner is ignored. Nested values,
    array order, JSON types, text and attachment references remain significant.
    """
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise RuntimeError('Invalid message payload')
    value.pop('streaming', None)
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def database_proof(database):
    wal = database.with_name(database.name + '-wal')
    # An idle WAL-mode database may have no sidecars after normal shutdown.
    # immutable is valid only in this quiescent, no-WAL case; never ignore WAL.
    suffix = '?mode=ro' if wal.exists() and wal.stat().st_size else '?mode=ro&immutable=1'
    with closing(sqlite3.connect(database.as_uri() + suffix, uri=True)) as connection:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Session database quick_check failed')
        sessions = sorted(row[0] for row in connection.execute('SELECT id FROM sessions'))
        messages = {}
        for sid, mid, raw in connection.execute('SELECT session_id,id,value FROM messages'):
            messages[json.dumps([sid, mid], separators=(',', ':'))] = message_payload_fingerprint(raw)
        return {'messageFingerprintAlgorithm': MESSAGE_FINGERPRINT_ALGORITHM, 'sessions': sessions, 'messages': messages}


def checkpoint(data, output, full=False):
    if not data.is_dir() or not (data / 'sessions.sqlite').is_file():
        raise RuntimeError('Existing userData with sessions.sqlite is required')
    if output == data or data in output.parents:
        raise RuntimeError('Checkpoint must be outside userData')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    copied = output / 'mutable-data'
    copied.mkdir(mode=0o700)
    started = time.monotonic()
    before = inventory(data, full)
    database = data / 'sessions.sqlite'
    wal = data / 'sessions.sqlite-wal'
    suffix = '?mode=ro' if wal.exists() and wal.stat().st_size else '?mode=ro&immutable=1'
    with closing(sqlite3.connect(database.as_uri() + suffix, uri=True)) as source:
        with closing(sqlite3.connect(copied / 'sessions.sqlite')) as destination:
            source.backup(destination)
            destination.execute('PRAGMA journal_mode=DELETE')
    proof = database_proof(copied / 'sessions.sqlite')
    copied_files = 1
    copied_bytes = (copied / 'sessions.sqlite').stat().st_size
    for rel, item in before.items():
        # Immutable attachments are preserved in place. Updating App never moves them.
        if not full and (rel == 'attachments' or rel.startswith('attachments/')):
            continue
        destination = copied / rel
        if item['kind'] == 'directory':
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if item['kind'] == 'symlink':
                destination.symlink_to(item['target'])
            else:
                shutil.copy2(data / rel, destination, follow_symlinks=False)
                if digest(destination) != item['sha256']:
                    raise RuntimeError('Checkpoint verification failed: ' + rel)
                copied_files += 1
                copied_bytes += item['bytes']
    if inventory(data, full) != before:
        raise RuntimeError('Persistent files changed during checkpoint; quit App normally before retry')
    current = database_proof(data / 'sessions.sqlite')
    if current != proof:
        raise RuntimeError('Session data changed during checkpoint; no coherent checkpoint claimed')
    manifest = {'format': 1, 'mode': 'full' if full else 'compatible', 'dataRoot': str(data),
                'files': before, 'database': proof, 'copiedFiles': copied_files,
                'copiedBytes': copied_bytes, 'seconds': round(time.monotonic() - started, 3),
                'verificationExclusions': runtime_verification_exclusions(before),
                'capturedAtUnixNs': time.time_ns(),
                'atomicTaskTempObservations': {
                    name: {'mtimeNs': (copied / name).stat().st_mtime_ns,
                           'ownerExited': not pid_is_alive(int(name.rsplit('.', 3)[-3]))}
                    for name, item in before.items()
                    if item.get('kind') == 'file' and re.fullmatch(
                        r'tasks/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.[1-9][0-9]{0,9}\.[a-z0-9]{1,8}\.tmp', name)}}
    write_json(output / 'checkpoint.json', manifest)
    return {key: manifest[key] for key in ['mode', 'copiedFiles', 'copiedBytes', 'seconds']}


def compatible_settings(before_path, after_path, allowed_defaults):
    supported = {'quickDecision': None, 'profileImage': ''}
    if any(key not in supported or type(value) is not type(supported[key]) or value != supported[key]
           for key, value in allowed_defaults.items()):
        raise RuntimeError('Only explicitly sealed quickDecision:null and profileImage:"" defaults are supported')
    try:
        before, after = json.loads(before_path.read_text()), json.loads(after_path.read_text())
    except (OSError, ValueError):
        return {'ok': False, 'unreadable': True}
    if not isinstance(before, dict) or not isinstance(after, dict):
        return {'ok': False, 'unreadable': True}
    def same(left, right):
        if isinstance(left, dict) and isinstance(right, dict):
            return left.keys() == right.keys() and all(same(value, right[key]) for key, value in left.items())
        if isinstance(left, list) and isinstance(right, list):
            return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
        if isinstance(left, bool) or isinstance(right, bool):
            return type(left) is type(right) and left == right
        return type(left) is type(right) and left == right
    changed = [key for key, value in before.items() if key not in after or not same(value, after[key])]
    added = sorted(set(after) - set(before))
    valid_additions = all(key in allowed_defaults and same(after[key], allowed_defaults[key]) for key in added)
    return {'ok': not changed and valid_additions, 'changedExistingKeys': changed,
            'addedDefaultKeys': added if valid_additions else [], 'unexpectedAddedKeys': [] if valid_additions else added}


def compatible_transport_delivery(before_path, after_path, task_id):
    """Allow this sealed task's receipt to advance, never its execution/payload."""
    try:
        before, after = json.loads(before_path.read_text()), json.loads(after_path.read_text())
    except (OSError, ValueError):
        return {'ok': False, 'unreadable': True}
    if not isinstance(before, dict) or not isinstance(after, dict):
        return {'ok': False, 'invalidTask': True}
    transitions = {'pending': {'delivering', 'delivered', 'uncertain'},
                   'delivering': {'delivered', 'uncertain'}}
    prior, current = before.get('deliveryStatus'), after.get('deliveryStatus')
    times = [before.get('updatedAt'), after.get('updatedAt')]
    valid = (before.get('id') == task_id and after.get('id') == task_id
             and before.get('status') in ['completed', 'failed']
             and isinstance(before.get('result'), str)
             and isinstance(prior, str) and isinstance(current, str)
             and current in transitions.get(prior, set())
             and all(type(value) in [int, float] and math.isfinite(value) for value in times)
             and times[1] >= times[0])
    # JSON encoding compares booleans/numbers and all nested fields exactly,
    # unlike Python's equality (where True == 1). Only these two keys may move.
    stable = lambda value: json.dumps({key: item for key, item in value.items()
                                     if key not in ['deliveryStatus', 'updatedAt']},
                                    sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    valid = valid and stable(before) == stable(after)
    return {'ok': bool(valid), 'taskId': task_id,
            'from': prior, 'to': current,
            'allowedChangedFields': ['deliveryStatus', 'updatedAt']}


def pid_is_alive(pid):
    if type(pid) is not int or pid <= 0 or pid > 2**31 - 1:
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # A permission or platform error is not proof the owner has exited.
        return True


def redundant_temp_cleanup(checkpoint_dir, expected, actual, metadata):
    """Read-only proof for missing, already redundant terminal-task JSON writes.

    Narrow the store's one-hour/one-directory sweep scope to UUID task files:
    the writer is gone, both cold copies are intact, and the committed target
    is unchanged. Never waive a changed temp or a new/uncommitted payload.
    """
    captured_ns = metadata.get('capturedAtUnixNs')
    observations = metadata.get('atomicTaskTempObservations', {})
    # Legacy checkpoints remain strict; do not infer age from a later audit.
    if type(captured_ns) is not int or captured_ns <= 0 or not isinstance(observations, dict):
        return []
    copied = checkpoint_dir / 'mutable-data'
    compatible = []

    def intact(path, record):
        try:
            info = path.lstat()
            return (record.get('kind') == 'file' and stat.S_ISREG(info.st_mode)
                    and not path.parent.is_symlink()
                    and stat.S_IMODE(info.st_mode) == record['mode']
                    and info.st_size == record['bytes'] and digest(path) == record['sha256'])
        except (OSError, KeyError):
            return False

    for name, record in expected.items():
        relative = Path(name)
        if (relative.is_absolute() or len(relative.parts) != 2 or relative.parts[0] != 'tasks'
                or name in actual or record.get('kind') != 'file'):
            continue
        match = re.fullmatch(r'(.+\.json)\.([1-9][0-9]{0,9})\.([a-z0-9]{1,8})\.tmp', relative.name)
        if not match:
            continue
        owner = int(match[2])
        if owner > 2**31 - 1 or pid_is_alive(owner):
            continue
        target = str(relative.with_name(match[1]))
        task_id = Path(target).stem
        if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', task_id):
            continue
        committed = expected.get(target, {})
        if committed.get('kind') != 'file' or actual.get(target) != committed:
            continue
        temporary_path, committed_path = copied / name, copied / target
        if not intact(temporary_path, record) or not intact(committed_path, committed):
            continue
        observation = observations.get(name, {})
        if not isinstance(observation, dict) or observation.get('ownerExited') is not True:
            continue
        recorded_mtime = observation.get('mtimeNs')
        if type(recorded_mtime) is not int or recorded_mtime != temporary_path.stat().st_mtime_ns:
            continue
        age_ns = captured_ns - recorded_mtime
        if age_ns < 60 * 60 * 1_000_000_000:
            continue
        try:
            left, right = json.loads(temporary_path.read_text()), json.loads(committed_path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(left, dict) or not isinstance(right, dict):
            continue
        if (left.get('id') != task_id or right.get('id') != task_id
                or left.get('status') not in ['completed', 'failed', 'cancelled']
                or left.get('status') != right.get('status')):
            continue
        equivalence = 'byte-identical'
        if record['sha256'] != committed['sha256']:
            if not compatible_transport_delivery(temporary_path, committed_path, task_id)['ok']:
                continue
            equivalence = 'same-terminal-task-receipt-progress'
        compatible.append({'path': name, 'committedTarget': target, 'ownerPid': owner,
                           'ownerExited': True, 'ageAtCheckpointSeconds': age_ns // 1_000_000_000,
                           'equivalence': equivalence, 'committedTargetUnchanged': True,
                           'checkpointCopyRetained': True})
    return compatible


def verify(data, checkpoint_dir, allowed_settings_defaults=None, transport_task_id=None):
    if transport_task_id is not None and (not isinstance(transport_task_id, str) or not re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', transport_task_id)):
        raise RuntimeError('Sealed transport task id must be one exact UUID')
    manifest = json.loads((checkpoint_dir / 'checkpoint.json').read_text())
    if str(data) != manifest['dataRoot']:
        raise RuntimeError('Readback dataRoot differs from checkpoint')
    current = database_proof(data / 'sessions.sqlite')
    expected = manifest['database']
    if expected.get('messageFingerprintAlgorithm') != MESSAGE_FINGERPRINT_ALGORITHM:
        raise RuntimeError('Checkpoint message fingerprint contract is missing or incompatible; create a fresh reviewed checkpoint. Existing install status is not changed.')
    missing_sessions = sorted(set(expected['sessions']) - set(current['sessions']))
    changed_messages = [key for key, value in expected['messages'].items()
                        if current['messages'].get(key) != value]
    actual_files = inventory(data, manifest['mode'] == 'full')
    exclusions = runtime_verification_exclusions(manifest['files'])
    if manifest.get('verificationExclusions', exclusions) != exclusions:
        raise RuntimeError('Checkpoint runtime exclusion contract changed')
    exempt_entries = set(exclusions['levelDbInfoLogs'] + exclusions['emptyBlobSessionDirectories'])
    changed_files = [key for key, value in manifest['files'].items()
                     if key not in exempt_entries and actual_files.get(key) != value]
    temp_cleanup = redundant_temp_cleanup(checkpoint_dir, manifest['files'], actual_files, manifest)
    for item in temp_cleanup:
        changed_files.remove(item['path'])
    settings = {'ok': True, 'byteIdentical': True}
    if 'settings.json' in changed_files:
        settings = compatible_settings(checkpoint_dir / 'mutable-data/settings.json', data / 'settings.json', allowed_settings_defaults or {})
        if settings['ok']:
            changed_files.remove('settings.json')
    transport_delivery = {'ok': True, 'byteIdentical': True}
    task_file = 'tasks/' + transport_task_id + '.json' if transport_task_id else None
    if task_file in changed_files:
        expected_file, actual_file = manifest['files'][task_file], actual_files.get(task_file, {})
        before_path = checkpoint_dir / 'mutable-data' / task_file
        if (expected_file.get('kind') == actual_file.get('kind') == 'file'
                and expected_file.get('mode') == actual_file.get('mode')
                and before_path.is_file() and not before_path.is_symlink()
                and digest(before_path) == expected_file['sha256']):
            transport_delivery = compatible_transport_delivery(before_path, data / task_file, transport_task_id)
        else:
            transport_delivery = {'ok': False, 'taskId': transport_task_id, 'fileContractChanged': True}
        if transport_delivery['ok']:
            changed_files.remove(task_file)
    return {'ok': not (missing_sessions or changed_messages or changed_files),
            'sessionsPreserved': len(expected['sessions']) - len(missing_sessions),
            'messagePayloadsPreserved': len(expected['messages']) - len(changed_messages),
            'persistentEntriesChecked': len(manifest['files']) - len(exempt_entries),
            'missingSessionIds': missing_sessions, 'changedMessageIds': changed_messages,
            'changedFiles': changed_files, 'quickCheck': 'ok',
            'settingsCompatibility': settings,
            'transportTaskDeliveryCompatibility': transport_delivery,
            'redundantAtomicTempCleanup': temp_cleanup,
            'verificationExclusions': exclusions,
            'boundary': 'Existing messages, file bytes and attachments; new records allowed. '
                        'Only explicitly sealed settings defaults may be added. Only the sealed terminal transport task may advance '
                        'its deliveryStatus and monotonic updatedAt; all other task fields and tasks remain strict. Excludes only the four exact LevelDB info logs '
                        'and checkpoint-proven empty Chromium blob UUID directory identities. Missing terminal-task atomic JSON temps require a dead '
                        'owner, one-hour cold age, intact checkpoint copies and an unchanged committed target with identical payload. '
                        'No runtime, remote-login or no-replay claim.'}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['checkpoint', 'verify'])
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--allowed-settings-defaults', default='{}', help='Sealed additive defaults; only quickDecision:null and profileImage:"" are supported')
    args = parser.parse_args()
    data = args.data.resolve()
    target = args.checkpoint.resolve()
    result = checkpoint(data, target, args.full) if args.action == 'checkpoint' else verify(data, target, json.loads(args.allowed_settings_defaults))
    if args.report:
        write_json(args.report, result)
    print(json.dumps(result, ensure_ascii=False))
    if result.get('ok') is False:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
