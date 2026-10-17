#!/usr/bin/env python3
"""Build WASM from clean pinned sources without network access during compilation.
All downloads, cache, scratch and outputs go under the explicit fresh destination.
Requires Python 3, Docker and Git. This never copies a prebuilt Lattice module.
"""
import argparse
import hashlib
import os
import re
import stat
import json
import pathlib
import subprocess
import sys
import urllib.request
import zipfile

IMAGE = 'emscripten/emsdk@sha256:cda91bb0b95863a05d4bb6aca9ce113c14293b78c63d914ad8801e6a4e33602b'
SQLITE_URL = 'https://www.sqlite.org/2024/sqlite-amalgamation-3450000.zip'
SQLITE_SHA = 'bde30d13ebdf84926ddd5e8b6df145be03a577a48fd075a087a5dd815bcdf740'
ROOT = pathlib.Path(__file__).resolve().parent.parent

def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git_tree(path):
    """Measure the exact regular-file subtree compiled in the source mount."""
    entries = []
    for child in sorted(path.iterdir(), key=lambda p: os.fsencode(p.name) + (b'/' if p.is_dir() else b'')):
        info = child.lstat()
        if stat.S_ISDIR(info.st_mode):
            mode, digest = b'40000', git_tree(child)
        elif stat.S_ISREG(info.st_mode):
            data = child.read_bytes()
            mode = b'100755' if info.st_mode & 0o111 else b'100644'
            digest = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        else:
            raise ValueError('Core subtree must contain only regular files and directories')
        entries.append(mode + b' ' + os.fsencode(child.name) + b'\0' + bytes.fromhex(digest))
    data = b''.join(entries)
    return hashlib.sha1(b'tree ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def core_input(root, source=None, profile_path=None):
    if source is None and profile_path is None:
        core = root / 'LatticeCore'
        expected = git(root, 'rev-parse', 'HEAD:LatticeCore')
        tree = git(core, 'rev-parse', expected + '^{tree}')
        if git(core, 'rev-parse', '--show-toplevel') != str(core) or git(core, 'rev-parse', 'HEAD') != expected:
            raise ValueError('Initialize the exact pinned LatticeCore submodule first')
        return core, expected, {'version': 1, 'latticeCoreCommit': expected, 'latticeCoreTree': tree}
    if source is None or profile_path is None:
        raise ValueError('The explicit Core source and reviewed profile are required together')
    lock = json.loads(pathlib.Path(profile_path).read_text())
    profile = lock.get('latticeCoreSource')
    if (lock.get('version') != 2 or not isinstance(profile, dict) or
            set(profile) != {'repository', 'commit', 'subpath', 'tree'} or
            any(not isinstance(value, str) for value in profile.values())):
        raise ValueError('Expected the closed version 2 Core source profile')
    path = pathlib.PurePosixPath(profile['subpath'])
    if (str(path) != profile['subpath'] or path.is_absolute() or not path.parts or
            any(part in ('.', '..', '.git') for part in path.parts) or
            not re.fullmatch(r'[0-9a-f]{40}', profile['commit']) or
            not re.fullmatch(r'[0-9a-f]{40}', profile['tree']) or
            not re.fullmatch(r'https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+', profile['repository'])):
        raise ValueError('An exact HTTPS repository, commit and safe Core subtree are required')
    source = pathlib.Path(source).expanduser().resolve()
    core = source.joinpath(*path.parts)
    if core.resolve() != core or not core.is_dir() or git_tree(core) != profile['tree']:
        raise ValueError('Staged Core differs from the reviewed source subtree')
    # The profile's commit is the reviewed source snapshot identity; the full
    # measured subtree is the byte-level admission, without requiring .git in
    # the credential-free staged build context or inventing an upstream alias.
    return core, None, {'version': 2, 'latticeCoreSource': profile}


def archive_source(source, revision, archive, target):
    subprocess.run(['git', '-C', str(source), 'archive', '--format=zip',
                    '--output=' + str(archive), revision], check=True)
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            if target not in (target / entry.filename).resolve().parents:
                raise ValueError('Invalid source archive path')
        zipped.extractall(target)


def archive_core_snapshot(core, expected_tree, archive, target):
    if git_tree(core) != expected_tree:
        raise ValueError('Staged Core changed before archiving')
    # Version 2 uses a deterministic ZIP of the exact selected subtree. Unlike
    # git archive of a bare tree object, its time cannot depend on the clock.
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED) as zipped:
        for source in sorted(core.rglob('*')):
            info = source.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Core snapshot contains a nonregular file')
            entry = zipfile.ZipInfo(source.relative_to(core).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | (0o755 if info.st_mode & 0o111 else 0o644)) << 16
            zipped.writestr(entry, source.read_bytes())
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            destination = target / entry.filename
            if target not in destination.resolve().parents:
                raise ValueError('Invalid Core snapshot archive path')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(zipped.read(entry))
            destination.chmod(0o755 if (entry.external_attr >> 16) & 0o111 else 0o644)
    if git_tree(core) != expected_tree or git_tree(target) != expected_tree:
        raise ValueError('Archived Core differs from the reviewed source subtree')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--core-source', type=pathlib.Path)
    parser.add_argument('--core-profile', type=pathlib.Path)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output.exists() or output == ROOT or ROOT in output.parents:
        raise SystemExit('Pass a fresh destination outside the source checkout')
    core, core_revision, core_receipt = core_input(ROOT, args.core_source, args.core_profile)
    if output == core or core in output.parents:
        raise SystemExit('Pass a fresh destination outside the Core source checkout')
    js_commit = git(ROOT, 'rev-parse', 'HEAD')
    js_tree = git(ROOT, 'rev-parse', js_commit + '^{tree}')
    for path in ([ROOT, core] if core_revision is not None else [ROOT]):
        if git(path, 'status', '--porcelain', '--untracked-files=all'):
            raise SystemExit('Source must be committed and clean: ' + str(path))
    output.mkdir(parents=True)
    for name in ['inputs', 'tmp', 'cache']:
        (output / name).mkdir()
    # Archive the recorded commits, rather than compiling a mutable checkout.
    # Ignored old binaries and edits made after the initial clean check cannot
    # enter the compiler's source mount.
    sources = output / 'source'
    archive_source(ROOT, js_commit, output / 'inputs/lattice-js.zip', sources)
    if core_revision is None:
        archive_core_snapshot(core, core_receipt['latticeCoreSource']['tree'],
                              output / 'inputs/lattice-core.zip', sources / 'LatticeCore')
    else:
        archive_source(core, core_revision, output / 'inputs/lattice-core.zip', sources / 'LatticeCore')
    archive = output / 'inputs/sqlite-amalgamation-3450000.zip'
    with urllib.request.urlopen(SQLITE_URL, timeout=60) as response, archive.open('wb') as target:
        # Fixed expected artifact is 2.7 MB; reject unexpected unbounded content.
        data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise SystemExit('SQLite archive exceeded its bound')
        target.write(data)
    if sha(archive) != SQLITE_SHA:
        raise SystemExit('SQLite archive checksum mismatch')
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            resolved = (output / 'inputs' / entry.filename).resolve()
            if output / 'inputs' not in resolved.parents:
                raise SystemExit('Invalid SQLite archive path')
        zipped.extractall(output / 'inputs')
    receipt = {
        **core_receipt,
        'sourceRepository': 'https://github.com/jsflax/LatticeJS.git',
        'latticeJSCommit': js_commit,
        'latticeJSTree': js_tree,
        'toolchainImage': IMAGE,
        'platform': 'linux/arm64',
        'sqliteURL': SQLITE_URL, 'sqliteArchiveSHA256': SQLITE_SHA,
        'sourceArchives': {name: sha(output / 'inputs' / name) for name in ['lattice-js.zip', 'lattice-core.zip']},
        'sqliteInputs': {file.name: sha(file) for file in sorted((output / 'inputs/sqlite-amalgamation-3450000').iterdir()) if file.is_file()},
        'buildType': 'Release', 'jobs': 2, 'networkDuringBuild': 'none',
    }
    (output / 'INPUTS.json').write_text(json.dumps(receipt, indent=2) + '\n')
    script = r'''
set -euo pipefail
emcc --version > /work/toolchain.txt
cmake --version >> /work/toolchain.txt
# Compiler-provided system libraries are inputs from the immutable image.
# Copy them so all build-generated cache entries remain in the chosen output.
cp -a /emsdk/upstream/emscripten/cache/. /work/cache/
export EM_CACHE=/work/cache
export TMPDIR=/work/tmp
emcmake cmake -S /source/wasm -B /work/build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DFETCHCONTENT_SOURCE_DIR_SQLITE3=/work/inputs/sqlite-amalgamation-3450000
cmake --build /work/build --parallel 2
'''
    command = ['docker', 'run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--cpus', '4', '--memory', '8g',
        '--mount', f'type=bind,source={sources},target=/source,readonly',
        '--mount', f'type=bind,source={output},target=/work',
        '--mount', f'type=bind,source={sources},target=/work/source,readonly',
        '--mount', f'type=bind,source={output / "inputs"},target=/work/inputs,readonly',
        '--workdir', '/source', IMAGE, 'bash', '-c', script]
    with (output / 'build.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    receipt['toolchainVersions'] = (output / 'toolchain.txt').read_text()
    receipt['artifacts'] = {name: {'sha256': sha(output / 'build' / name), 'bytes': (output / 'build' / name).stat().st_size}
        for name in ['lattice.js', 'lattice.wasm']}
    (output / 'BUILD_INFO.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__':
    main()
