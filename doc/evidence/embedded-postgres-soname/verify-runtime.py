#!/usr/bin/env python3
"""Candidate Docker RUN proof; no Paperclip server, DB initialization or network."""
from pathlib import Path
import hashlib, json, os, subprocess, tempfile

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
BASE_TAG = "portal360/paperclip:v2026.831.0-e13761927-u1001"
FIXTURE_TAG = "portal360-soname-proof:" + str(os.getpid())
CONTAINERS = ["portal360-soname-before-" + str(os.getpid()), "portal360-soname-after-" + str(os.getpid())]

def call(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=120, **kwargs)

base = json.loads(subprocess.check_output(["docker", "image", "inspect", BASE_TAG], text=True))[0]
base_id = base["Id"]
assert not base["Config"].get("Volumes"), "Refuse image with implicit volumes"
dockerfile = (ROOT / "Dockerfile").read_text()
start = dockerfile.index("# The native-runtime helper prepares aliases for bundled shared libraries.")
end = dockerfile.index("\nENV NODE_ENV=production", start)
runtime_layer = dockerfile[start:end]
helper_hash = hashlib.sha256((ROOT / "packages/db/src/embedded-postgres-native.ts").read_bytes()).hexdigest()
probe = r"""
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const result = { uid: process.getuid() };
if (result.uid !== 1001) throw new Error('wrong fixture UID');
try { fs.writeFileSync('/app/soname-write-probe', 'x'); throw new Error('app writable'); }
catch (error) {
  if (!['EACCES','EROFS'].includes(error.code)) throw error;
  result.app_write_denied = error.code;
}
result.helper_sha256 = crypto.createHash('sha256').update(fs.readFileSync('./packages/db/src/embedded-postgres-native.ts')).digest('hex');
if (result.helper_sha256 !== process.env.EXPECTED_HELPER_HASH) throw new Error('base helper differs from candidate');
const require = createRequire(path.resolve('packages/db/package.json'));
const packageRoot = path.dirname(path.dirname(require.resolve('embedded-postgres')));
const nativeRoot = path.resolve(packageRoot, '..', '@embedded-postgres', 'linux-x64', 'native');
const libDir = path.join(nativeRoot, 'lib');
process.env.LD_LIBRARY_PATH = libDir;
result.aliases_before = ['libcrypto.so.1','libssl.so.1'].map(name => ({ name, exists: fs.existsSync(path.join(libDir,name)) }));
try {
  const { prepareEmbeddedPostgresNativeRuntime } = await import('./packages/db/src/embedded-postgres-native.ts');
  await prepareEmbeddedPostgresNativeRuntime();
  result.preparation = 'ok';
} catch (error) { result.preparation = error.code || error.name; }
const pg = spawnSync(path.join(nativeRoot, 'bin/postgres'), ['--version'], { encoding:'utf8' });
result.postgres_exit = pg.status;
result.postgres_stdout = pg.stdout?.trim();
result.postgres_stderr = pg.stderr?.trim();
console.log(JSON.stringify(result));
"""
def run_probe(image, name):
    args = ["docker","run","--rm","--name",name,"--network","none","--read-only",
            "--user","1001:1001","--cpus","0.5","--memory","256m","--pids-limit","64",
            "--cap-drop","ALL","--security-opt","no-new-privileges",
            "--env","TSX_DISABLE_CACHE=1","--env","EXPECTED_HELPER_HASH="+helper_hash,
            "--workdir","/app","--entrypoint","node",image,
            "--import","./server/node_modules/tsx/dist/loader.mjs","--input-type=module","-e",probe]
    r = call(args)
    assert r.returncode == 0, r.stdout + r.stderr
    return json.loads(r.stdout.strip())

report = {"base_image_id":base_id,"candidate_helper_sha256":helper_hash,
          "candidate_docker_layer_sha256":hashlib.sha256(runtime_layer.encode()).hexdigest(),
          "constraints":{"uid":1001,"rootfs":"read-only","network":"none","memory":"256m",
                         "cpus":0.5,"pids_limit":64,"volumes":[],"server_started":False}}
try:
    report["before"] = run_probe(base_id, CONTAINERS[0])
    assert report["before"]["preparation"] in ["EACCES","EROFS"], report["before"]
    # The reproduced blocker is helper EROFS; postgres --version can already load.
    # Keep the binary result as evidence, not a fabricated pre-fix loader failure.
    with tempfile.TemporaryDirectory(prefix="paperclip-soname-image-") as temp:
        df = Path(temp) / "Dockerfile"
        assert json.loads(subprocess.check_output(["docker", "image", "inspect", BASE_TAG], text=True))[0]["Id"] == base_id, "base image tag drift"
        df.write_text("FROM " + BASE_TAG + "\nUSER root\nWORKDIR /app\n" + runtime_layer + "\n")
        r = call(["docker","build","--network","none","--pull=false","--memory","512m","-t",FIXTURE_TAG,temp])
        (EVIDENCE / "fixture-build.txt").write_text(r.stdout + r.stderr)
        assert r.returncode == 0, r.stdout + r.stderr
    report["after"] = run_probe(FIXTURE_TAG, CONTAINERS[1])
    assert report["after"]["preparation"] == "ok", report["after"]
    assert report["after"]["postgres_exit"] == 0, report["after"]
    assert all(item["exists"] for item in report["after"]["aliases_before"]), report["after"]
    report["result"] = "PASS"
finally:
    for name in CONTAINERS:
        call(["docker","rm","-f",name])
    call(["docker","image","rm",FIXTURE_TAG])
    remaining = subprocess.check_output(["docker","ps","-a","--format","{{.Names}}"],text=True).splitlines()
    report["fixture_containers_remaining"] = [n for n in CONTAINERS if n in remaining]
    report["fixture_image_remaining"] = call(["docker","image","inspect",FIXTURE_TAG]).returncode == 0
    (EVIDENCE / "fixture-result.json").write_text(json.dumps(report,indent=2)+"\n")
    assert not report["fixture_containers_remaining"] and not report["fixture_image_remaining"], "cleanup incomplete"
print(json.dumps(report,indent=2))
