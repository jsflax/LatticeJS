import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BUILD = runpy.run_path(str(Path(__file__).with_name("build-pinned.py")))


class SourceProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lattice-core-profile-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "Orbital"
        self.core = self.source / "PrivateDependencies/LatticeCore"
        (self.core / "Sources").mkdir(parents=True)
        (self.core / "Package.swift").write_text("// fixture manifest\n")
        (self.core / "Sources/core.cpp").write_text("// exact compiler source\n")
        executable = self.core / "Sources/helper.sh"
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        self.profile = {"version": 2, "latticeCoreSource": {
            "repository": "https://github.com/canary-technologies-corp/Orbital.git",
            "commit": "a" * 40, "subpath": "PrivateDependencies/LatticeCore",
            "tree": BUILD["git_tree"](self.core)}}
        self.profile_path = self.root / "profile.json"
        self.profile_path.write_text(json.dumps(self.profile))

    def select(self):
        return BUILD["core_input"](self.root / "LatticeJS", self.source, self.profile_path)

    def test_explicit_snapshot_accepts_exact_profile_without_git_or_old_artifacts(self):
        core, revision, receipt = self.select()
        self.assertEqual(core, self.core)
        self.assertIsNone(revision)
        self.assertEqual(receipt, self.profile)
        self.assertFalse((self.source / ".git").exists())

    def test_profile_fields_are_closed_and_exact(self):
        for field, value in [("commit", "main"), ("tree", "HEAD^{tree}"),
                             ("repository", "https://user:secret@github.com/org/repo"),
                             ("subpath", "../Core"), ("subpath", "/Core"),
                             ("subpath", "PrivateDependencies//LatticeCore"),
                             ("extra", True)]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.profile)
                changed["latticeCoreSource"][field] = value
                self.profile_path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError): self.select()
        for value in [1, True, None]:
            self.profile_path.write_text(json.dumps({**self.profile, "version": value}))
            with self.assertRaises(ValueError): self.select()

    def test_source_and_profile_are_an_explicit_pair(self):
        for source, profile in [(None, self.profile_path), (self.source, None)]:
            with self.assertRaisesRegex(ValueError, "together"):
                BUILD["core_input"](self.root, source, profile)

    def test_drift_extra_files_and_executable_mode_refuse(self):
        original = (self.core / "Sources/core.cpp").read_bytes()
        (self.core / "Sources/core.cpp").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "differs"): self.select()
        (self.core / "Sources/core.cpp").write_bytes(original)
        extra = self.core / "old.wasm"
        extra.write_bytes(b"stale compiled artifact")
        with self.assertRaisesRegex(ValueError, "differs"): self.select()
        extra.unlink()
        (self.core / "Sources/helper.sh").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "differs"): self.select()

    def test_redirected_core_and_symlink_member_refuse(self):
        moved = self.core.with_name("other")
        self.core.rename(moved)
        self.core.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "differs"): self.select()
        self.core.unlink(); moved.rename(self.core)
        (self.core / "Sources/link").symlink_to("core.cpp")
        with self.assertRaisesRegex(ValueError, "regular"): self.select()

    def test_tree_identity_matches_real_git_and_mode(self):
        empty = self.root / "template"; empty.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "init", "--quiet", "--template=" + str(empty), str(self.source)], env=env, check=True)
        subprocess.run(["git", "-C", str(self.source), "add", "PrivateDependencies"], env=env, check=True)
        tree = subprocess.check_output(["git", "-C", str(self.source), "write-tree"], env=env, text=True).strip()
        actual = subprocess.check_output(["git", "-C", str(self.source), "rev-parse", tree + ":PrivateDependencies/LatticeCore"], env=env, text=True).strip()
        self.assertEqual(actual, self.profile["latticeCoreSource"]["tree"])

    def test_snapshot_archive_is_deterministic_and_exact(self):
        snapshots = []
        for index in range(2):
            archive = self.root / (str(index) + ".zip")
            target = self.root / ("snapshot" + str(index))
            BUILD["archive_core_snapshot"](self.core, self.profile["latticeCoreSource"]["tree"], archive, target)
            self.assertEqual(BUILD["git_tree"](target), self.profile["latticeCoreSource"]["tree"])
            self.assertEqual((target / "Sources/helper.sh").stat().st_mode & 0o777, 0o755)
            snapshots.append(archive.read_bytes())
            os.utime(self.core / "Sources/core.cpp", (123456789, 123456789))
        self.assertEqual(snapshots[0], snapshots[1])

    def test_mutation_during_archive_cannot_produce_a_passing_snapshot(self):
        import zipfile
        original = zipfile.ZipFile.writestr
        changed = False
        def write(owner, *args, **kwargs):
            nonlocal changed
            result = original(owner, *args, **kwargs)
            if not changed:
                changed = True
                (self.core / "Sources/core.cpp").write_text("// raced source\n")
            return result
        with patch.object(zipfile.ZipFile, "writestr", write):
            with self.assertRaisesRegex(ValueError, "differs"):
                BUILD["archive_core_snapshot"](self.core, self.profile["latticeCoreSource"]["tree"],
                                               self.root / "race.zip", self.root / "snapshot")

    def test_legacy_default_keeps_exact_submodule_identity(self):
        root = self.root / "LatticeJS"; core = root / "LatticeCore"
        values = {('rev-parse', 'HEAD:LatticeCore'): 'b' * 40,
                  ('rev-parse', 'b' * 40 + '^{tree}'): 'c' * 40,
                  ('rev-parse', '--show-toplevel'): str(core),
                  ('rev-parse', 'HEAD'): 'b' * 40}
        with patch.dict(BUILD["core_input"].__globals__, {"git": lambda path, *args: values[args]}):
            self.assertEqual(BUILD["core_input"](root), (core, 'b' * 40,
                {"version": 1, "latticeCoreCommit": 'b' * 40, "latticeCoreTree": 'c' * 40}))
            values[('rev-parse', 'HEAD')] = 'd' * 40
            with self.assertRaisesRegex(ValueError, "exact pinned"):
                BUILD["core_input"](root)


if __name__ == "__main__":
    unittest.main()
