#!/usr/bin/env python3
"""Bounded official production image build from a committed git archive."""
from pathlib import Path
import datetime, hashlib, io, json, os, shutil, subprocess, tarfile, tempfile, time

ROOT=Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from preflight_config import load_config
COMMIT,OUT,MIN_START_GIB=load_config()
BUILDER="portal360-preflight-"+str(os.getpid())
TAG="portal360/paperclip-candidate:"+COMMIT[:9]+"-preflight"
CONTAINER="buildx_buildkit_"+BUILDER+"0"
VOLUME=CONTAINER+"_state"
GIB=1024**3
def run(args, timeout=120):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
def free():
    return shutil.disk_usage(ROOT).free
def write_report():
    (OUT/"build-result.json").write_text(json.dumps(report,indent=2)+"\n")
def exists(kind,name):
    return run(["docker",kind,"inspect",name],20).returncode==0

assert subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()==COMMIT
assert not exists("image",TAG), "Refuse pre-existing candidate tag"
initial_free=free()
if initial_free<=MIN_START_GIB*GIB:
    (OUT/"build-result.json").write_text(json.dumps({
        "commit":COMMIT,"status":"capacity_failed_before_build","image_tag":TAG,
        "free_bytes_before":initial_free,"minimum_start_gib":MIN_START_GIB,
        "builder_started":False,"production_changes":False,
    },indent=2)+"\n")
    raise RuntimeError("Insufficient initial disk reserve for the observed COPY peak")
assert not exists("container",CONTAINER) and not exists("volume",VOLUME)
buildkit_preexisting=exists("image","moby/buildkit:buildx-stable-1")
lock_record=json.loads((OUT/"lock-refresh-result.json").read_text())
derived_lock=(OUT/"docker-context-lock.yaml").read_bytes()
assert lock_record["commit"]==COMMIT and lock_record["changed_context_files"]==["pnpm-lock.yaml"]
assert hashlib.sha256(derived_lock).hexdigest()==lock_record["derived_lock_sha256"]

report={"commit":COMMIT,"started_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "image_tag":TAG,"builder":BUILDER,"free_bytes_before":free(),"minimum_start_gib":MIN_START_GIB,"build_timeout_seconds":1800,
        "abort_free_bytes":18*GIB,"minimum_reserve_bytes":15*GIB,
        "source":"git archive of exact commit plus captured lock from official Docker workflow preprocessing",
        "derived_lock_sha256":lock_record["derived_lock_sha256"],
        "committed_lock_sha256":lock_record["committed_lock_sha256"],
        "production_changes":False}
build=None
archive=None
success=False
context_temp=None
try:
    context_temp=tempfile.TemporaryDirectory(prefix="paperclip-image-context-")
    context=Path(context_temp.name)
    source_archive=subprocess.check_output(["git","archive","--format=tar",COMMIT],cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(source_archive)) as tar:
        tar.extractall(context,filter="data")
    del source_archive
    def context_hashes():
        return {str(f.relative_to(context)):hashlib.sha256(f.read_bytes()).hexdigest()
                for f in context.rglob("*") if f.is_file() and not f.is_symlink()}
    before_context=context_hashes()
    assert hashlib.sha256((context/"pnpm-lock.yaml").read_bytes()).hexdigest()==lock_record["committed_lock_sha256"]
    (context/"pnpm-lock.yaml").write_bytes(derived_lock)
    after_context=context_hashes()
    changed=sorted(k for k in before_context.keys()|after_context.keys() if before_context.get(k)!=after_context.get(k))
    assert changed==["pnpm-lock.yaml"],changed
    assert (context/"Dockerfile").read_bytes()==subprocess.check_output(["git","show",COMMIT+":Dockerfile"],cwd=ROOT)
    ignores=(context/".dockerignore").read_text().splitlines()
    for required in [".git",".paperclip","node_modules","**/node_modules","data","tmp"]:
        assert required in ignores,"missing Docker exclusion "+required
    for sensitive in [".env",".env.local",".env.production",".paperclip",".git"]:
        assert not (context/sensitive).exists(),"unexpected context path "+sensitive
    report["context_verification"]={"changed_files":changed,"dockerfile_sha256":after_context["Dockerfile"],
         "dockerignore_sha256":after_context[".dockerignore"],"file_count":len(after_context),
         "tree_sha256":hashlib.sha256(json.dumps(after_context,sort_keys=True).encode()).hexdigest(),
         "transport":"explicit temporary directory; no stdin autodetection"}

    create=["docker","buildx","create","--name",BUILDER,"--driver","docker-container",
            "--driver-opt","memory=6g,memory-swap=6g,cpu-period=100000,cpu-quota=200000,restart-policy=no"]
    r=run(create); assert r.returncode==0,r.stdout+r.stderr
    r=run(["docker","buildx","inspect",BUILDER,"--bootstrap"],180)
    (OUT/"bootstrap.txt").write_text(r.stdout+r.stderr)
    assert r.returncode==0,r.stdout+r.stderr
    config=json.loads(subprocess.check_output(["docker","inspect",CONTAINER],text=True))[0]
    hc=config["HostConfig"]
    limits={k:hc.get(k) for k in ["Memory","MemorySwap","CpuQuota","CpuPeriod"]}
    report["verified_builder_limits"]=limits
    assert limits=={"Memory":6*GIB,"MemorySwap":6*GIB,"CpuQuota":200000,"CpuPeriod":100000}, limits
    mount_names=[m.get("Name") for m in config["Mounts"] if m["Type"]=="volume"]
    assert mount_names==[VOLUME],mount_names
    report["fixture_volume"]=VOLUME
    assert free()>18*GIB,"Disk reserve exhausted before build"
    args=["docker","buildx","build","--builder",BUILDER,"--target","production",
          "--platform","linux/amd64","--load","--progress","plain","--tag",TAG,
          "--build-arg","USER_UID=1001","--build-arg","USER_GID=1001",
          "--build-arg","PAPERCLIP_BUILD_COMMIT="+COMMIT,
          "--build-arg","PAPERCLIP_BUILD_VERSION=candidate-"+COMMIT[:9],
          "--build-arg","CLI_TOOLS_CACHE_EPOCH="+datetime.datetime.now(datetime.timezone.utc).strftime("%G-W%V"),str(context)]
    report["build_command"]=args
    start=time.monotonic()
    with (OUT/"build.txt").open("w") as log:
        build=subprocess.Popen(args,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,text=False)
        last_progress=0
        while build.poll() is None:
            remaining=free()
            report["minimum_observed_free_bytes"]=min(report.get("minimum_observed_free_bytes",remaining),remaining)
            elapsed=time.monotonic()-start
            if remaining<18*GIB or elapsed>1800:
                report["abort_reason"]="disk_reserve" if remaining<18*GIB else "timeout"
                build.terminate()
                try:build.wait(timeout=15)
                except subprocess.TimeoutExpired:build.kill();build.wait()
                break
            if elapsed-last_progress>30:
                print(json.dumps({"elapsed_seconds":round(elapsed),"free_gib":round(remaining/GIB,2),"status":"building"}),flush=True)
                last_progress=elapsed
            time.sleep(3)
        report["build_exit"]=build.wait()
    report["duration_seconds"]=round(time.monotonic()-start,2)
    if report["build_exit"]!=0:
        print("\n".join((OUT/"build.txt").read_text().splitlines()[-25:]),flush=True)
        raise RuntimeError("Official image build failed or was stopped; see build.txt")
    image=json.loads(subprocess.check_output(["docker","image","inspect",TAG],text=True))[0]
    report["image_id"]=image["Id"];report["image_size_bytes"]=image["Size"]
    report["status"]="built_not_smoked";success=True
except Exception as error:
    report["status"]="not_built";report["error"]=str(error)
    raise
finally:
    if build is not None and build.poll() is None:
        build.terminate()
        try:build.wait(timeout=15)
        except subprocess.TimeoutExpired:build.kill();build.wait()
    if archive is not None and archive.poll() is None:
        archive.terminate();archive.wait(timeout=10)
    run(["docker","buildx","rm","--force",BUILDER],120)
    # Only the dedicated names established above may be removed.
    if exists("container",CONTAINER):run(["docker","rm","-f",CONTAINER],60)
    if exists("volume",VOLUME):run(["docker","volume","rm",VOLUME],120)
    if not success and exists("image",TAG):run(["docker","image","rm",TAG],60)
    if not buildkit_preexisting and exists("image","moby/buildkit:buildx-stable-1"):
        run(["docker","image","rm","moby/buildkit:buildx-stable-1"],60)
    report["cleanup"]={"builder_container_remaining":exists("container",CONTAINER),
                       "builder_volume_remaining":exists("volume",VOLUME),
                       "candidate_image_retained":success}
    if context_temp is not None:
        context_path=context_temp.name
        context_temp.cleanup()
        report["cleanup"]["context_directory_removed"]=not Path(context_path).exists()
    report["free_bytes_after"]=free()
    write_report()
    assert not report["cleanup"]["builder_container_remaining"] and not report["cleanup"]["builder_volume_remaining"]
print(json.dumps(report,indent=2),flush=True)
