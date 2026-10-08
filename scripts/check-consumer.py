"""Execute the renamed-module consumer and retain native runner evidence."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--install-base", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    consumer = root / "bcr_test"
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    assert not (evidence / "native-consumer-proof.json").exists()
    linux = sys.platform.startswith("linux")
    runner = "linux-sandbox" if linux else "darwin-sandbox" if sys.platform == "darwin" else "local"
    test_runner = "local" if linux else runner
    module = re.search(r'module\(\s*name\s*=\s*"([^"]+)"', (root / "MODULE.bazel").read_text()).group(1)
    gazelle = module == "latticebuild_gazelle"
    assert module in {"latticebuild_js", "latticebuild_gazelle"}, module
    expected = {"//:compiled_test"} if gazelle else {
        "//:helper_test", "//examples/action:scratch_test", "//examples/basics:alias_test",
        "//examples/knip/library:production_test", "//examples/knip/library:unused_test",
        "//examples/knip/library:value_test", "//examples/ox/checks:format_test",
        "//examples/ox/checks:lint_test", "//examples/prettier/checks:format_test",
        "//examples/ts/library:emissions_test", "//examples/vite/app:bundle_test",
        "//examples/vite/app:unit_test",
    }

    def git(*command, cwd=root):
        return subprocess.check_output(["git", *command], cwd=cwd)

    def write(name, value):
        (evidence / name).write_text(json.dumps(value, indent=2) + "\n")

    head = git("rev-parse", "HEAD").decode().strip()
    tree = git("rev-parse", "HEAD^{tree}").decode().strip()
    assert head == os.environ["GITHUB_SHA"]
    assert not git("status", "--porcelain")
    original = {
        path: hashlib.sha256((root / path).read_bytes()).hexdigest()
        for path in git("ls-files", "-z").decode().split("\0") if path
    }
    write("source-before.json", dict(head=head, tree=tree, files=original, status=""))
    bazel = ["bazel", "--nosystem_rc", "--nohome_rc", "--output_user_root=" + str(args.output_root.resolve())]
    if args.install_base:
        bazel.append("--install_base=" + str(args.install_base.resolve()))
    flags = ["--disk_cache=", "--lockfile_mode=off", "--noremote_accept_cached",
             "--noremote_upload_local_results", "--nocache_test_results", "--verbose_failures",
             "--announce_rc", "--test_env=HOME", "--test_env=TMP", "--test_env=TEMP",
             "--spawn_strategy=" + (runner + ",local" if runner != "local" else runner)]
    if linux:
        flags += ["--sandbox_tmpfs_path=/tmp", "--experimental_repository_cache_hardlinks"]

    def run(name, command, cwd=consumer):
        with (evidence / (name + ".log")).open("wb") as log:
            result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        (evidence / (name + "-exit-code.txt")).write_text(str(result.returncode) + "\n")
        print(name, result.returncode, flush=True)
        if result.returncode:
            print((evidence / (name + ".log")).read_text(errors="replace"), flush=True)
            raise RuntimeError(name + " failed")

    def recorded(name, command, target, extra=()):
        run(name, bazel + [command, target, *flags,
            "--execution_log_json_file=" + str(evidence / (name + "-spawns.json")),
            "--build_event_json_file=" + str(evidence / (name + "-bep.json")), *extra])

    def check_sources(phase):
        current_head = git("rev-parse", "HEAD").decode().strip()
        current_tree = git("rev-parse", "HEAD^{tree}").decode().strip()
        status = git("status", "--porcelain").decode()
        assert current_head == head and current_tree == tree and status == ""
        for path, digest in original.items():
            assert hashlib.sha256((root / path).read_bytes()).hexdigest() == digest, path
        write("source-" + phase + ".json", dict(head=head, tree=tree, files=len(original), unchanged=True, status=status))

    try:
        if gazelle:
            # Root overrides do not propagate to this separate module. Qualify
            # the exact development pin through a private registry, leaving the
            # caller's committed MODULE and its renamed imports unchanged.
            override = re.search(r'git_override\(\s*module_name\s*=\s*"latticebuild_js",\s*commit\s*=\s*"([0-9a-f]{40})",\s*remote\s*=\s*"([^"]+)"', (root / "MODULE.bazel").read_text())
            assert override and override.group(2) == "https://github.com/latticebuild/rules_js.git"
            commit = override.group(1)
            version = re.search(r'bazel_dep\(name = "latticebuild_js", version = "([^"]+)"', (consumer / "MODULE.bazel").read_text()).group(1)
            dependency = evidence.parent / "consumer-js-dependency"
            run("dependency-clone", ["git", "clone", "--no-checkout", override.group(2), str(dependency)], root)
            run("dependency-checkout", ["git", "checkout", "--detach", commit], dependency)
            assert git("rev-parse", "HEAD", cwd=dependency).decode().strip() == commit
            assert not git("status", "--porcelain", cwd=dependency)
            module_bytes = (dependency / "MODULE.bazel").read_bytes()
            assert re.search(rb'version\s*=\s*"' + version.encode() + rb'"', module_bytes)
            archive = evidence.parent / ("rules_js-" + version + ".tar")
            with archive.open("wb") as output:
                subprocess.run(["git", "archive", "--prefix=rules_js-" + version + "/", "HEAD"], cwd=dependency, stdout=output, check=True)
            digest = hashlib.sha256(archive.read_bytes()).digest()
            registry = evidence.parent / "consumer-registry"
            entry = registry / "modules/latticebuild_js" / version
            entry.mkdir(parents=True)
            (registry / "bazel_registry.json").write_text('{"mirrors": []}\n')
            (entry / "MODULE.bazel").write_bytes(module_bytes)
            (entry / "source.json").write_text(json.dumps(dict(url=archive.as_uri(), strip_prefix="rules_js-" + version,
                integrity="sha256-" + base64.b64encode(digest).decode())) + "\n")
            metadata = json.loads((dependency / ".bcr/metadata.template.json").read_text())
            metadata["versions"] = [version]
            (entry.parent / "metadata.json").write_text(json.dumps(metadata) + "\n")
            flags += ["--registry=" + registry.as_uri(), "--registry=https://bcr.bazel.build"]
            write("dependency.json", dict(commit=commit, version=version, archiveSha256=digest.hex(), moduleSha256=hashlib.sha256(module_bytes).hexdigest()))
            run("install-parent", ["mise", "exec", "--", "pnpm", "--dir", "..", "install", "--frozen-lockfile"])
        run("install-caller", ["mise", "exec", "--", "pnpm", "install", "--frozen-lockfile"])
        if gazelle:
            recorded("generation", "run", "//:gazelle", ["--", "-repo_root", str(consumer), "-strict", "-mode=diff"])
        inventory = subprocess.check_output(bazel + ["query", "tests(//:test)", "--lockfile_mode=off", *[f for f in flags if f.startswith("--registry=")]], cwd=consumer, text=True)
        (evidence / "test-inventory.txt").write_text(inventory)
        assert set(inventory.splitlines()) == expected
        recorded("build", "build", "//:artifacts")
        recorded("test", "test", "//:test", ["--build_tests_only", "--test_output=all",
            "--strategy=TestRunner=" + (runner + ",local" if runner != "local" else runner)])
        if gazelle:
            recorded("stable-generation", "run", "//:gazelle", ["--", "-repo_root", str(consumer), "-strict", "-mode=diff"])
        build = read_stream(evidence / "build-spawns.json")
        tests = read_stream(evidence / "test-spawns.json")
        generation = read_stream(evidence / "generation-spawns.json") if gazelle else []
        actions = build + generation + [r for r in tests if r.get("mnemonic") != "TestRunner"]
        assert actions and all(r.get("runner") == runner and r.get("exitCode") == 0 and not r.get("cacheHit", False) for r in actions)
        assert any(r.get("mnemonic") == "Tsc" for r in build)
        assert any(r.get("mnemonic") == "Bound" for r in actions)
        test_spawns = [r for r in tests if r.get("mnemonic") == "TestRunner"]
        setup = "tw.exe" if sys.platform == "win32" else "test-setup.sh"
        xml = "xml.exe" if sys.platform == "win32" else "generate-xml.sh"
        def invokes(row, filename):
            return any(argument.replace("\\", "/").endswith("/" + filename) for argument in row.get("commandArgs", []))
        executions = [r for r in test_spawns if invokes(r, setup)]
        helpers = [r for r in test_spawns if invokes(r, xml)]
        assert len(executions) + len(helpers) == len(test_spawns)
        assert all(r.get("targetLabel") in expected and r.get("runner") == test_runner and r.get("exitCode") == 0 and not r.get("cacheHit", False) for r in helpers)
        assert len(helpers) <= len(expected) and len({r.get("targetLabel") for r in helpers}) == len(helpers)
        assert len(executions) == len(expected) and {r.get("targetLabel") for r in executions} == expected
        assert all(r.get("runner") == test_runner and r.get("exitCode") == 0 and not r.get("cacheHit", False) for r in executions)
        events = [json.loads(line) for line in (evidence / "test-bep.json").read_text().splitlines() if line.strip()]
        attempts = [r for r in events if "testResult" in r.get("id", {})]
        assert len(attempts) == len(expected) and {r["id"]["testResult"]["label"] for r in attempts} == expected
        for row in attempts:
            key, result = row["id"]["testResult"], row["testResult"]
            assert (key["run"], key["shard"], key["attempt"]) == (1, 1, 1)
            assert result["status"] == "PASSED" and not result.get("cachedLocally", False)
            assert result["executionInfo"]["strategy"] == test_runner and result["executionInfo"].get("exitCode", 0) == 0
        check_sources("after")
        proof = dict(source=head, tree=tree, module=module, platform=sys.platform,
            nativeActionSpawns=len(actions), buildRunner=runner, tests=sorted(expected), testRunner=test_runner,
            firstAttempts=len(attempts), xmlHelperSpawns=len(helpers), tmpfsPath="/tmp" if linux else None, passed=True)
    finally:
        try:
            run("shutdown", bazel + ["shutdown"])
        finally:
            check_sources("final")
    write("native-consumer-proof.json", proof)


def read_stream(path):
    decoder = json.JSONDecoder()
    text = path.read_text()
    rows = []
    position = 0
    while position < len(text):
        if text[position].isspace():
            position += 1
        else:
            row, position = decoder.raw_decode(text, position)
            rows.append(row)
    return rows


if __name__ == "__main__":
    main()
