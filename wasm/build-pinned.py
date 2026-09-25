#!/usr/bin/env python3
"""Build WASM from clean pinned sources without network access during compilation.
All downloads, cache, scratch and outputs go under the explicit fresh destination.
Requires Python 3, Docker and Git. This never copies a prebuilt Lattice module.
"""
import hashlib
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

def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: python3 wasm/build-pinned.py NEW_OUTPUT_DIRECTORY')
    output = pathlib.Path(sys.argv[1]).expanduser().resolve()
    if output.exists() or output == ROOT or ROOT in output.parents:
        raise SystemExit('Pass a fresh destination outside the source checkout')
    core = ROOT / 'LatticeCore'
    expected_core = git(ROOT, 'rev-parse', 'HEAD:LatticeCore')
    if git(core, 'rev-parse', '--show-toplevel') != str(core) or git(core, 'rev-parse', 'HEAD') != expected_core:
        raise SystemExit('Initialize the exact pinned LatticeCore submodule first')
    for path in [ROOT, core]:
        if git(path, 'status', '--porcelain', '--untracked-files=all'):
            raise SystemExit('Source must be committed and clean: ' + str(path))
    output.mkdir(parents=True)
    for name in ['inputs', 'tmp', 'cache']:
        (output / name).mkdir()
    # Archive the recorded commits, rather than compiling a mutable checkout.
    # Ignored old binaries and edits made after the initial clean check cannot
    # enter the compiler's source mount.
    sources = output / 'source'
    for path, revision, name, target in [(ROOT, 'HEAD', 'lattice-js', sources),
            (core, expected_core, 'lattice-core', sources / 'LatticeCore')]:
        zipped_source = output / 'inputs' / (name + '.zip')
        subprocess.run(['git', '-C', str(path), 'archive', '--format=zip',
            '--output=' + str(zipped_source), revision], check=True)
        with zipfile.ZipFile(zipped_source) as zipped:
            for entry in zipped.infolist():
                if target not in (target / entry.filename).resolve().parents:
                    raise SystemExit('Invalid source archive path')
            zipped.extractall(target)
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
        'version': 1,
        'sourceRepository': 'https://github.com/jsflax/LatticeJS.git',
        'latticeJSCommit': git(ROOT, 'rev-parse', 'HEAD'),
        'latticeJSTree': git(ROOT, 'rev-parse', 'HEAD^{tree}'),
        'latticeCoreCommit': expected_core,
        'latticeCoreTree': git(core, 'rev-parse', 'HEAD^{tree}'),
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
