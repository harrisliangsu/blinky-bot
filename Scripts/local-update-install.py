#!/usr/bin/env python3
"""One-shot local installer. Prepare first; a sealed RELEASE token activates it.

Run outside BlinkyBot's process tree (one-shot launchd job, KeepAlive=false).
No force-kill, database edits, task-completion forgery, automatic data restore,
model invocation, credential output or external messaging. CANCEL always stops
before activation; after activation it suppresses further actions and reports
the exact installed state. The old App stays recoverable via same-volume rename.
"""
import argparse
from contextlib import closing
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import sqlite3
import subprocess
import sys
import time
import traceback


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proof = load('local_update_proof', 'local-update-data.py')
freeze = load('local_update_freeze', 'freeze-local-build.py')
digest = proof.digest
write_json = proof.write_json


def processes():
    result = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,stat=,comm='], text=True).splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) == 4 and not fields[2].startswith('Z'):
            result[int(fields[0])] = (int(fields[1]), fields[3])
    return result


def user_messages(data, sessions):
    result = {}
    wal = data / 'sessions.sqlite-wal'
    suffix = '?mode=ro' if wal.exists() and wal.stat().st_size else '?mode=ro&immutable=1'
    with closing(sqlite3.connect((data / 'sessions.sqlite').as_uri() + suffix, uri=True)) as database:
        for sid, mid, raw in database.execute('SELECT session_id,id,value FROM messages'):
            if sid not in sessions or mid.startswith('agent-result-input-'):
                continue
            value = json.loads(raw)
            if value.get('role') == 'user':
                result[json.dumps([sid, mid], separators=(',', ':'))] = str(value.get('content', ''))
    return result


def message_fingerprints(messages):
    return {key: hashlib.sha256(value.encode()).hexdigest() for key, value in messages.items()}


def is_status_query(text):
    # Unrecognized new instructions hold the installer; common status questions
    # do not withdraw already explicit installation authorization.
    compact = re.sub(r'[\s?？!！。,.，、:：;；…~～]+', '', text).lower()
    if re.search(r'暂停|停止|取消|别装|别安装|不要装|不要安装|先别|先不|改范围|改成|新增|另外|stop|pause|cancel|hold|donotinstall|dontinstall', compact):
        return False
    phrases = ['进度', '状态', '现在进展', '现在到哪', '到哪里了', '做到哪', '怎么样了',
               '怎么样', '完成了吗', '做完了吗', '好了没', '好了吗', '还没好吗',
               '还没完成吗', '还在吗', 'status', 'progress', 'update', 'anyupdate', 'anyupdates',
               '现在进度如何', '目前进展怎么样', '做到哪一步了', '怎么还没好']
    if compact in phrases or compact in [word + '呢' for word in phrases]:
        return True
    return bool(re.fullmatch(r'(?:现在|目前|当前)?(?:的)?(?:进度|进展|状态)(?:如何|怎样|怎么样|到哪了|到哪里了|到哪一步了)(?:了|呢|吗)?', compact))


def validate_paths(config):
    if config.get('rehearsal'):
        temporary_roots = [Path(os.path.realpath(os.environ.get('TMPDIR', '/private/tmp'))), Path('/private/tmp')]
        for key in ['app', 'dataDir']:
            path = Path(config[key]).resolve()
            if not any(base == path or base in path.parents for base in temporary_roots):
                raise RuntimeError('Rehearsal requires temporary App and data paths')
    elif Path(config['app']).resolve() != Path('/Applications/BlinkyBot.app'):
        raise RuntimeError('Formal handoff targets only /Applications/BlinkyBot.app')


def prepare(config_path, handoff):
    config = json.loads(config_path.read_text())
    required = ['app', 'dataDir', 'candidateApp', 'oldAsarSha256', 'newAsarSha256',
                'oldPid', 'oldPort', 'transportTaskId', 'transportSessionIds',
                'transportTaskSessionId', 'originalBotId', 'watchSessionIds', 'sourceSessionId', 'nodePath', 'sourceManifest', 'oldLog']
    missing = [name for name in required if not config.get(name)]
    if missing:
        raise RuntimeError('Missing handoff fields: ' + ', '.join(missing))
    validate_paths(config)
    if config['sourceSessionId'] not in config['watchSessionIds']:
        raise RuntimeError('Receipt source must be among watched user sessions')
    if config['transportTaskSessionId'] not in config['transportSessionIds']:
        raise RuntimeError('Exact transport session must be among allowed transport sessions')
    handoff.mkdir(parents=True, mode=0o700, exist_ok=False)
    config['userMessagesAtHandoff'] = message_fingerprints(user_messages(Path(config['dataDir']), config['watchSessionIds']))
    queue_file = Path(config['dataDir']) / 'message-queues.json'
    queues = json.loads(queue_file.read_text()).get('queues', {}) if queue_file.exists() else {}
    config['queuedItemIdsAtHandoff'] = {sid: [item.get('id') for item in queue.get('items', [])] for sid, queue in queues.items()}
    config['helperDir'] = str(Path(__file__).resolve().parent)
    config['sealedFiles'] = config.get('sealedFiles', {})
    for name in ['local-update-install.py', 'local-update-runtime.mjs', 'local-update-data.py',
                 'freeze-local-build.py', 'inspect-installed-app.mjs', 'local-update-contracts.mjs']:
        path = Path(__file__).resolve().with_name(name)
        config['sealedFiles'][str(path)] = digest(path)
    config['sealedFiles'][str(Path(config['sourceManifest']).resolve())] = digest(Path(config['sourceManifest']))
    write_json(handoff / 'config.json', config)
    label = 'bot.blinky.installer.unified-' + re.sub('[^A-Za-z0-9.-]', '-', handoff.name)[-65:]
    job = {'Label': label, 'ProgramArguments': [sys.executable, str(Path(__file__).resolve()),
            'run', '--handoff', str(handoff)], 'WorkingDirectory': str(handoff),
           'KeepAlive': False, 'RunAtLoad': True, 'ProcessType': 'Background',
           'StandardOutPath': str(handoff / 'installer-stdout.log'),
           'StandardErrorPath': str(handoff / 'installer-stderr.log'),
           'EnvironmentVariables': {key: value for key, value in os.environ.items() if key in
                                    ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']}}
    job['EnvironmentVariables']['PATH'] = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    with (handoff / 'installer.plist').open('wb') as stream:
        plistlib.dump(job, stream)
    return {'prepared': True, 'handoff': str(handoff), 'releaseToken': digest(handoff / 'config.json'),
            'launchdLabel': label, 'plist': str(handoff / 'installer.plist'),
            'boundary': 'No installer started, application quit, replacement or userData modification.'}


class Installer:
    def __init__(self, handoff):
        self.root = handoff
        self.cfg = json.loads((handoff / 'config.json').read_text())
        validate_paths(self.cfg)
        self.app = Path(self.cfg['app'])
        self.data = Path(self.cfg['dataDir'])
        self.candidate = Path(self.cfg['candidateApp'])
        self.state = {'installed': False, 'installerPid': os.getpid(), 'root': str(handoff), 'timings': {}}
        self.started = time.monotonic()

    def mark(self, phase, **values):
        self.state.update(values, phase=phase, at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          seconds=round(time.monotonic() - self.started, 3))
        write_json(self.root / 'status.json', self.state)

    def boundary(self):
        if (self.root / 'CANCEL').exists():
            raise RuntimeError('Installation explicitly cancelled')
        now = user_messages(self.data, self.cfg['watchSessionIds'])
        before = self.cfg['userMessagesAtHandoff']
        unknown = [key for key, text in now.items()
                   if hashlib.sha256(text.encode()).hexdigest() != before.get(key) and not is_status_query(text)]
        if unknown:
            raise RuntimeError('A new user instruction requires coordinator review; message ids: ' + str(unknown))

    def app_pids(self):
        executable = str(self.app / 'Contents/MacOS/BlinkyBot')
        return {pid for pid, (_, command) in processes().items() if command == executable}

    def runtime(self, action, port, **values):
        config = {'action': action, 'port': port, 'appPath': str(self.app / 'Contents/Resources/app.asar'),
                  'dataDir': str(self.data), 'output': str(self.root / ('runtime-' + action + '.json')), **values}
        if action in ['read', 'close-inspector']:
            # Check inside the target before observing/scheduling close: exec
            # paths alone cannot prove a recycled port belongs to this process.
            config['expectedPid'] = self.state['newPid']
        elif action in ['gate', 'quit']:
            config['expectedPid'] = self.cfg['oldPid'] if port == self.cfg['oldPort'] else self.state['newPid']
        config_file = self.root / 'runtime-config.json'
        write_json(config_file, config)
        with (self.root / ('runtime-' + action + '.log')).open('a') as log:
            subprocess.run([self.cfg['nodePath'], str(Path(self.cfg['helperDir']) / 'local-update-runtime.mjs'),
                            str(config_file)], check=True, timeout=60, stdout=log, stderr=subprocess.STDOUT)
        return json.loads(Path(config['output']).read_text())

    def gate(self, port, after=False):
        value = self.runtime('gate', port, requireTransport=not after,
                             transportTaskId=self.cfg['transportTaskId'], transportTaskSessionId=self.cfg['transportTaskSessionId'],
                             sourceSessionId=self.cfg['sourceSessionId'], originalBotId=self.cfg['originalBotId'])
        allowed_tasks = set() if after else {self.cfg['transportTaskId']}
        allowed_sessions = {self.cfg['sourceSessionId']} if after else set(self.cfg['transportSessionIds'])
        if any(task['status'] in ['running', 'queued'] and task['id'] not in allowed_tasks for task in value['tasks']):
            raise RuntimeError('Other business tasks are active; no forced termination')
        if any(run['running'] and run['id'] not in allowed_sessions for run in value['runs']):
            raise RuntimeError('Another conversation is active; no forced termination')
        queue_file = self.data / 'message-queues.json'
        if queue_file.exists():
            queues = json.loads(queue_file.read_text()).get('queues', {})
            for sid, queue in queues.items():
                items = queue.get('items', [])
                if not items:
                    continue
                previous_ids = self.cfg.get('queuedItemIdsAtHandoff', {}).get(sid, [])
                status_only = after and sid == self.cfg['sourceSessionId'] and all(
                    isinstance(item.get('id'), str) and item['id'] and item['id'] not in previous_ids
                    and json.dumps([sid, item['id']], separators=(',', ':')) not in self.cfg['userMessagesAtHandoff']
                    and not item.get('attachments') and isinstance(item.get('text'), str) and is_status_query(item['text'])
                    for item in items)
                if not status_only:
                    raise RuntimeError('A pending message queue requires coordinator review')
        return value

    def start(self):
        # launchd runs this installer as Background. A directly spawned GUI
        # inherits that resource policy even after its window gains focus.
        # LaunchServices creates an application job with normal UI scheduling.
        if self.app_pids():
            raise RuntimeError('Application already running; no duplicate launch')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        environment = {key: value for key, value in os.environ.items() if key in
                       ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', '__CF_USER_TEXT_ENCODING']}
        if self.cfg.get('rehearsal'):
            environment.update(OPENBOT_DATA_DIR=str(self.data), BLINKY_SMOKE='1', BLINKY_SMOKE_DIR=str(self.data))
        log = self.root / 'app-start.log'
        log.touch(exist_ok=True)
        command = ['/usr/bin/open', '-n', '-a', str(self.app), '--stdout', str(log), '--stderr', str(log)]
        for key, value in environment.items():
            command.extend(['--env', key + '=' + value])
        command.extend(['--args', '--inspect=127.0.0.1:' + str(port)])
        self.mark('restarting', newPort=port, launchMethod='LaunchServices')
        subprocess.run(command, env=environment, check=True, timeout=15,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(150):
            pids = self.app_pids()
            if len(pids) > 1:
                raise RuntimeError('Multiple replacement App processes; identity is ambiguous')
            if pids:
                pid = next(iter(pids))
                if self.state.get('newPid') not in [None, pid]:
                    raise RuntimeError('Replacement App process changed before readback')
                if self.state.get('newPid') != pid:
                    self.mark('restarting', newPid=pid)
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.2):
                        return port
                except OSError:
                    pass
            elif self.state.get('newPid'):
                raise RuntimeError('Replacement App exited before readback')
            time.sleep(.2)
        raise RuntimeError('Replacement inspector did not start within 30s')

    def close_temporary_inspector(self, port):
        if self.app_pids() != {self.state['newPid']}:
            raise RuntimeError('Application identity changed before inspector cleanup')
        self.runtime('close-inspector', port)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    time.sleep(.1)
            except OSError:
                break
        else:
            raise RuntimeError('Temporary loopback inspector remained open')
        if self.app_pids() != {self.state['newPid']}:
            raise RuntimeError('Application exited while closing temporary inspector')

    def cleanup_failed_install_inspector(self):
        # A failed verification still owns any inspector opened by start().
        # Clean only that recorded process/port, without rollback or success.
        port = self.state.get('newPort')
        if not port or not self.state.get('newPid'):
            self.mark('installed_verification_failed', temporaryInspectorCleanupRequired=False)
            return
        try:
            self.close_temporary_inspector(port)
            self.mark('installed_verification_failed', temporaryInspectorClosed=True)
        except Exception as error:
            self.mark('installed_verification_failed', temporaryInspectorClosed=False,
                      temporaryInspectorPort=port, inspectorCleanupError=str(error))

    def recover_old_app(self, error, failed_phase):
        try:
            port = self.start()
            self.mark('held', oldAppRestarted=True, reason=str(error), failedPhase=failed_phase)
            try:
                self.close_temporary_inspector(port)
                self.mark('held', oldAppTemporaryInspectorClosed=True)
            except Exception as cleanup_error:
                self.mark('held', oldAppTemporaryInspectorClosed=False,
                          oldAppInspectorCleanupError=str(cleanup_error), oldAppTemporaryInspectorPort=port)
        except Exception as recovery_error:
            self.mark('held', oldAppRestarted=False, oldAppTemporaryInspectorClosed=False,
                      oldAppRecoveryError=str(recovery_error), reason=str(error), failedPhase=failed_phase)

    def run(self):
        self.mark('awaiting_release')
        deadline = time.monotonic() + self.cfg.get('releaseTimeoutSeconds', 900)
        while not (self.root / 'RELEASE').exists():
            if (self.root / 'CANCEL').exists():
                raise RuntimeError('Cancelled before release')
            if time.monotonic() > deadline:
                raise RuntimeError('Sealed handoff release deadline expired')
            time.sleep(.25)
        if (self.root / 'RELEASE').read_text().strip() != digest(self.root / 'config.json'):
            raise RuntimeError('Release token does not match reviewed handoff')
        lease_path = self.app.parent / '.blinkybot-local-update.flock'
        lease = lease_path.open('a')
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for line in subprocess.check_output(['launchctl', 'list'], text=True).splitlines():
            fields = line.split()
            if len(fields) == 3 and fields[2].startswith('bot.blinky.installer.') and fields[0].isdigit() and int(fields[0]) != os.getpid():
                raise RuntimeError('Another installer is running')
        for filename, expected in self.cfg['sealedFiles'].items():
            if digest(Path(filename)) != expected:
                raise RuntimeError('Sealed input changed: ' + filename)
        if not freeze.verify(Path(self.cfg['sourceManifest']))['ok']:
            raise RuntimeError('Frozen source or dependencies changed')
        if self.app_pids() != {self.cfg['oldPid']}:
            raise RuntimeError('Formal application process identity changed')
        for app, expected in [(self.app, self.cfg['oldAsarSha256']), (self.candidate, self.cfg['newAsarSha256'])]:
            if digest(app / 'Contents/Resources/app.asar') != expected:
                raise RuntimeError('Application bundle identity changed')
        self.boundary()
        before_runtime = self.gate(self.cfg['oldPort'])
        if before_runtime['runtime']['pid'] != self.cfg['oldPid']:
            raise RuntimeError('Inspector does not belong to the recorded old process')
        # Stage and verify before quit. Keep the old bundle by rename, not a second copy.
        staged = self.app.parent / ('.BlinkyBot-next-' + self.root.name + '.app')
        previous = self.app.parent / ('.BlinkyBot-before-' + self.root.name + '.app')
        if staged.exists() or previous.exists():
            raise RuntimeError('A previous update artifact already owns this handoff')
        self.mark('staging')
        start = time.monotonic()
        subprocess.run(['ditto', str(self.candidate), str(staged)], check=True, timeout=120)
        if freeze.inventory(staged) != freeze.inventory(self.candidate):
            raise RuntimeError('Staged bundle bytes differ from candidate')
        self.state['timings']['stageSeconds'] = round(time.monotonic() - start, 3)
        self.boundary()
        self.gate(self.cfg['oldPort'])
        owned = {self.cfg['oldPid']}
        while True:
            more = {pid for pid, (parent, _) in processes().items() if parent in owned}
            if more <= owned:
                break
            owned |= more
        old_log = Path(self.cfg['oldLog']) if self.cfg.get('oldLog') else None
        offset = old_log.stat().st_size if old_log and old_log.exists() else 0
        self.mark('quit_fence_check')
        quit_result = self.runtime('quit', self.cfg['oldPort'], transportTaskId=self.cfg['transportTaskId'],
                                   transportTaskSessionId=self.cfg['transportTaskSessionId'],
                                   sourceSessionId=self.cfg['sourceSessionId'], originalBotId=self.cfg['originalBotId'])
        if not quit_result.get('normalQuitRequested'):
            raise RuntimeError('Live transport fence did not authorize normal quit')
        self.mark('normal_quit_requested', quitRequested=True, finalTransportFence=quit_result['transportFence'])
        deadline = time.monotonic() + 65
        while set(processes()) & owned:
            if time.monotonic() > deadline:
                raise RuntimeError('Old App tree did not exit normally; no replacement performed')
            time.sleep(.25)
        if self.app_pids():
            raise RuntimeError('App restarted before activation')
        if old_log and old_log.exists():
            tail = old_log.read_bytes()[offset:].lower()
            if any(marker in tail for marker in [b'quitting with unsaved', b'flush on quit failed',
                                                b'store flush did not finish', b'gave up waiting for']):
                raise RuntimeError('Normal shutdown reported incomplete writes or child shutdown')
        self.boundary()
        self.mark('checkpointing')
        checkpoint = self.root / 'checkpoint'
        stats = proof.checkpoint(self.data, checkpoint, bool(self.cfg.get('fullDataCheckpoint', False)))
        self.mark('checkpoint_verified', checkpoint=str(checkpoint), checkpointStats=stats)
        self.boundary()
        if self.app_pids() or digest(self.app / 'Contents/Resources/app.asar') != self.cfg['oldAsarSha256']:
            raise RuntimeError('Formal application changed before activation')
        self.app.rename(previous)
        try:
            staged.rename(self.app)
        except Exception:
            previous.rename(self.app)
            raise
        self.mark('installed', installed=True, previousApp=str(previous), installedAsarSha256=digest(self.app / 'Contents/Resources/app.asar'))
        # Once installed, always restart to leave a usable App even if CANCEL arrives.
        port = self.start()
        observed = self.runtime('read', port, asarSha256=self.cfg['newAsarSha256'])
        if observed['runtime']['pid'] != self.state['newPid'] or self.app_pids() != {self.state['newPid']}:
            raise RuntimeError('Loaded process differs from installed candidate')
        after = self.gate(port, after=True)
        old_tasks = {task['id']: task for task in before_runtime['tasks']}
        new_tasks = {task['id']: task for task in after['tasks']}
        if not old_tasks.keys() <= new_tasks.keys():
            raise RuntimeError('Saved task disappeared')
        if any(task['status'] in ['running', 'queued'] for task in after['tasks'] if task['id'] == self.cfg['transportTaskId']):
            raise RuntimeError('Interrupted installation transport resumed')
        for tid, task in old_tasks.items():
            if task['status'] not in ['running', 'queued'] and new_tasks[tid]['status'] != task['status']:
                raise RuntimeError('A previously terminal task changed state')
        preserved = proof.verify(self.data, checkpoint, self.cfg.get('allowedSettingsDefaults', {}), self.cfg['transportTaskId'])
        write_json(self.root / 'preservation.json', preserved)
        if not preserved['ok']:
            raise RuntimeError('Saved data differs; inspect preservation.json without automatic data rollback')
        time.sleep(3)
        self.gate(port, after=True)
        self.mark('installed_verified', loadedModuleMatchesAsar=observed['loadedModuleMatchesAsar'],
                  noTransportReplayObserved=True, preservation=preserved, installationVerified=True)
        summary = self.cfg.get('deliverySummary', '本次代码与隔离验收记录见密封交接文件。')
        receipt = ('正式 BlinkyBot 已替换、重启并完成实际加载回读。ASAR SHA-256：' + self.cfg['newAsarSha256'] +
                   '\n原会话正文、附件与配置回读通过；本次重启观察未自动重放安装承载任务。\n' + summary +
                   '\n完整状态与证据：' + str(self.root / 'DELIVERY.json') +
                   '\n旧 App 保留于：' + str(previous) + '\n数据检查点：' + str(checkpoint))
        footer = self.cfg.get('deliveryFooter', '')
        if isinstance(footer, str) and footer:
            receipt += '\n' + footer
        write_json(self.root / 'DELIVERY.json', self.state)
        (self.root / 'DELIVERY.md').write_text(receipt + '\n')
        may_deliver = not (self.root / 'CANCEL').exists()
        try:
            self.boundary()
        except RuntimeError as error:
            may_deliver = False
            self.mark('installed_verified', deliveryHeldForNewInstruction=True, deliveryHoldReason=str(error))
        if may_deliver:
            try:
                receipt_id = 'local-update-' + self.root.name
                result = self.runtime('receipt', port, sourceSessionId=self.cfg['sourceSessionId'],
                                      receiptId=receipt_id, receiptText=receipt, originalBotId=self.cfg['originalBotId'])
                durable = 0
                content_matches = False
                author_matches = False
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    with closing(sqlite3.connect((self.data / 'sessions.sqlite').as_uri() + '?mode=ro', uri=True)) as database:
                        rows = database.execute('SELECT value FROM messages WHERE session_id=? AND id=?',
                                                (self.cfg['sourceSessionId'], receipt_id)).fetchall()
                    durable = len(rows)
                    content_matches = durable == 1 and json.loads(rows[0][0]).get('content') == receipt
                    author_matches = durable == 1 and json.loads(rows[0][0]).get('botId') == self.cfg['originalBotId'] and json.loads(rows[0][0]).get('role') == 'assistant'
                    if content_matches and author_matches:
                        break
                    time.sleep(.1)
                delivered = bool(result.get('saved')) and content_matches and author_matches
                self.mark('installed_verified' if delivered else 'installed_verified_receipt_failed',
                          receiptDelivered=delivered, receiptDurableCount=durable,
                          receiptContentHashMatches=content_matches, receiptOriginalBotMatches=author_matches)
            except Exception as error:
                self.mark('installed_verified_receipt_failed', receiptDelivered=False, receiptError=str(error))
        self.close_temporary_inspector(port)
        final_phase = 'installed_verified'
        if self.state.get('deliveryHeldForNewInstruction') or not may_deliver:
            final_phase = 'installed_verified_delivery_held'
        elif not self.state.get('receiptDelivered'):
            final_phase = 'installed_verified_receipt_failed'
        self.mark(final_phase, temporaryInspectorClosed=True)
        write_json(self.root / 'DELIVERY.json', self.state)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'run'])
    parser.add_argument('--handoff', type=Path, required=True)
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare':
        if not args.config:
            parser.error('prepare requires --config')
        print(json.dumps(prepare(args.config.resolve(), args.handoff.resolve())))
        return
    installer = Installer(args.handoff.resolve())
    try:
        installer.run()
    except Exception as error:
        traceback.print_exc()
        failed_phase = installer.state.get('phase')
        installer.mark('installed_verification_failed' if installer.state['installed'] else 'held',
                       reason=str(error), failedPhase=failed_phase)
        if not installer.state['installed'] and installer.state.get('quitRequested') and not installer.app_pids():
            installer.recover_old_app(error, failed_phase)
        elif installer.state['installed']:
            installer.cleanup_failed_install_inspector()
        write_json(installer.root / 'DELIVERY.json', installer.state)
        (installer.root / 'DELIVERY.md').write_text('本次更新未通过全部验收；没有自动恢复或清空用户数据。\n详见 DELIVERY.json。\n')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
