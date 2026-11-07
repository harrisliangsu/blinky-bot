#!/usr/bin/env python3
"""Freeze actual source (including untracked files) and installed dependency bytes.

The snapshot contains copied source and a dependency symlink. Both complete byte
inventories must still match at verification; no branch, commit or userData is
changed. Build only inside the snapshot, not the concurrently edited worktree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

EXCLUDED = {'.git', 'node_modules', 'out', 'dist', 'release', 'coverage', '__pycache__', '.vite', '.cache', '.build'}
PRIVATE_FILES = {'.npmrc', '.pypirc', '.netrc', 'credentials.json', 'secrets.json'}
PRIVATE_DIRECTORIES = {'.ssh', '.aws', '.gnupg', '.credentials', '.secrets'}


def excluded_source_file(name):
    lower = name.lower()
    return (lower == '.env' or lower.startswith('.env.') or lower in PRIVATE_FILES or
            lower.endswith(('.pem', '.key', '.p12', '.pfx', '.log', '.tsbuildinfo')) or
            lower in {'.eslintcache', '.ds_store'})


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def inventory(root, exclude=frozenset(), source_scope=False):
    result = {}
    for folder, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in exclude)
        if source_scope:
            directories[:] = [name for name in directories
                              if name not in PRIVATE_DIRECTORIES and not excluded_source_file(name)]
        if source_scope and Path(folder) == root:
            # Docs are delivery artifacts, separately retained in the worktree.
            # Updating evidence must not make byte-identical runtime code stale.
            directories[:] = [name for name in directories if name != 'docs']
        for name in directories + files:
            path = Path(folder) / name
            if path.name == '.DS_Store' or path.suffix == '.pyc':
                continue
            if source_scope and excluded_source_file(name):
                continue
            relative = str(path.relative_to(root))
            if path.is_symlink():
                result[relative] = {'symlink': os.readlink(path)}
            elif path.is_file():
                result[relative] = {'sha256': digest(path), 'mode': path.stat().st_mode & 0o777}
            elif path.is_dir():
                result[relative] = {'directory': True}
    return result


def check_inventory(root, expected, exclusions, source_scope=False):
    actual = inventory(root, exclusions, source_scope)
    return {'changed': [name for name, value in expected.items() if actual.get(name) != value],
            'added': sorted(set(actual) - set(expected))}


def freeze(repo, destination):
    if destination == repo or repo in destination.parents:
        raise RuntimeError('Snapshot must be outside repository')
    if not (repo / 'node_modules').is_dir():
        raise RuntimeError('Installed node_modules are required')
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    started = time.monotonic()
    source = inventory(repo, EXCLUDED, source_scope=True)
    dependencies = inventory(repo / 'node_modules')
    snapshot = destination / 'source'
    snapshot.mkdir(mode=0o700)
    for name, item in source.items():
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if 'symlink' in item:
            target.symlink_to(item['symlink'])
        elif 'directory' in item:
            target.mkdir(exist_ok=True)
        else:
            shutil.copy2(repo / name, target)
    (snapshot / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    for root, expected, excludes, scoped in [(repo, source, EXCLUDED, True), (snapshot, source, EXCLUDED, True),
                                             (repo / 'node_modules', dependencies, set(), False)]:
        difference = check_inventory(root, expected, excludes, scoped)
        if difference['changed'] or difference['added']:
            raise RuntimeError('Files changed during freeze: ' + json.dumps(difference))
    result = {'format': 2, 'repo': str(repo), 'snapshot': str(snapshot),
              'head': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
              'source': source, 'dependencies': dependencies,
              'sourceScope': {'excludedDirectories': sorted(EXCLUDED), 'excludedRootDirectories': ['docs'],
                              'excludedPrivateNames': sorted(PRIVATE_FILES),
                              'excludedPrivateDirectories': sorted(PRIVATE_DIRECTORIES),
                              'excludedPatterns': ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.log', '*.tsbuildinfo'],
                              'included': 'All remaining files, including untracked src, assets, Scripts/scripts, Native, build and root configs.'},
              'seconds': round(time.monotonic() - started, 3)}
    (destination / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    return {'snapshot': str(snapshot), 'sourceFiles': sum('sha256' in value for value in source.values()),
            'dependencyFiles': sum('sha256' in value for value in dependencies.values()),
            'sourceEntries': len(source), 'dependencyEntries': len(dependencies), 'seconds': result['seconds']}


def verify(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    repo, snapshot = Path(manifest['repo']), Path(manifest['snapshot'])
    result = {'worktree': check_inventory(repo, manifest['source'], EXCLUDED, True),
              'snapshot': check_inventory(snapshot, manifest['source'], EXCLUDED, True),
              'dependencies': check_inventory(repo / 'node_modules', manifest['dependencies'], set())}
    result['ok'] = not any(value['changed'] or value['added'] for value in result.values())
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['freeze', 'verify'])
    parser.add_argument('--repo', type=Path)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    if args.action == 'freeze':
        if not args.repo or not args.destination:
            parser.error('freeze requires --repo and --destination')
        result = freeze(args.repo.resolve(), args.destination.resolve())
    else:
        if not args.manifest:
            parser.error('verify requires --manifest')
        result = verify(args.manifest.resolve())
    print(json.dumps(result))
    if result.get('ok') is False:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
