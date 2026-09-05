#!/usr/bin/env python3
"""Run the official Docker workflow lockfile preprocessing in an isolated context."""
from pathlib import Path
import datetime,difflib,hashlib,io,json,os,subprocess,tarfile,tempfile
ROOT=Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from preflight_config import load_config
COMMIT,OUT,MIN_START_GIB=load_config()
assert subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()==COMMIT
NAME="portal360-lock-preflight-"+str(os.getpid())
def sha(b):return hashlib.sha256(b).hexdigest()
report={"commit":COMMIT,"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "workflow":".github/workflows/docker.yml:90","command":"pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile",
        "root_worktree_lock_modified":False,"container_memory":"2g","container_cpus":1,"container_network":"bridge (registry metadata only)"}
try:
    with tempfile.TemporaryDirectory(prefix="paperclip-lock-context-") as temp:
        context=Path(temp)
        archive=subprocess.check_output(["git","archive","--format=tar",COMMIT],cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(context,filter="data")
        before={str(f.relative_to(context)):sha(f.read_bytes()) for f in context.rglob("*") if f.is_file() and not f.is_symlink()}
        original=(context/"pnpm-lock.yaml").read_bytes()
        image=json.loads(subprocess.check_output(["docker","image","inspect","node:24"],text=True))[0]["Id"]
        report["node_image_id"]=image
        args=["docker","run","--rm","--name",NAME,"--memory","2g","--cpus","1","--pids-limit","128",
              "--cap-drop","ALL","--security-opt","no-new-privileges",
              "--env","COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
              "--mount","type=bind,src="+temp+",dst=/context","--workdir","/context",
              "--entrypoint","corepack",image,"pnpm","install","--lockfile-only","--ignore-scripts","--no-frozen-lockfile"]
        result=subprocess.run(args,capture_output=True,text=True,timeout=300)
        (OUT/"lock-refresh.txt").write_text(result.stdout+result.stderr)
        report["exit_code"]=result.returncode
        assert result.returncode==0,result.stdout+result.stderr
        after={str(f.relative_to(context)):sha(f.read_bytes()) for f in context.rglob("*") if f.is_file() and not f.is_symlink()}
        changed=sorted(k for k in before.keys()|after.keys() if before.get(k)!=after.get(k))
        report["changed_context_files"]=changed
        assert changed==["pnpm-lock.yaml"],changed
        derived=(context/"pnpm-lock.yaml").read_bytes()
        (OUT/"docker-context-lock.yaml").write_bytes(derived)
        (OUT/"docker-context-lock.diff").write_text("".join(difflib.unified_diff(original.decode().splitlines(True),derived.decode().splitlines(True),fromfile="committed/pnpm-lock.yaml",tofile="docker-context/pnpm-lock.yaml")))
        report["committed_lock_sha256"]=sha(original);report["derived_lock_sha256"]=sha(derived)
        report["derived_lock_bytes"]=len(derived)
        report["source_manifest_sha256"]=sha((context/"package.json").read_bytes())
        report["status"]="prepared_for_review"
finally:
    subprocess.run(["docker","rm","-f",NAME],capture_output=True)
    report["container_removed"]=subprocess.run(["docker","container","inspect",NAME],capture_output=True).returncode!=0
    (OUT/"lock-refresh-result.json").write_text(json.dumps(report,indent=2)+"\n")
print(json.dumps(report,indent=2))
