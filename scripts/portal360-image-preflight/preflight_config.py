"""Guards and capacity preparation for this disposable GitHub-hosted preflight only."""
from pathlib import Path
import datetime,json,os,re,shutil,subprocess,sys
GIB=1024**3
SDK_PATHS=(
    "/usr/share/dotnet","/usr/share/swift","/usr/local/lib/android",
    "/usr/local/share/boost","/usr/local/share/powershell","/opt/ghc",
    "/opt/hostedtoolcache/CodeQL","/opt/hostedtoolcache/PyPy","/opt/hostedtoolcache/Ruby",
)

def configuration(env):
    if env.get("GITHUB_ACTIONS")!="true" or env.get("RUNNER_ENVIRONMENT")!="github-hosted":
        raise ValueError("Only the explicitly disposable GitHub-hosted workflow is supported")
    if env.get("RUNNER_OS")!="Linux":
        raise ValueError("Only the Linux hosted runner is supported")
    commit=env.get("PAPERCLIP_PREFLIGHT_COMMIT","")
    if not re.fullmatch(r"[0-9a-f]{40}",commit):
        raise ValueError("An exact full source commit is required")
    temp=Path(env.get("RUNNER_TEMP",""))
    if not temp.is_absolute() or temp==Path("/") or temp.resolve()!=temp or not temp.is_dir():
        raise ValueError("Invalid or symlinked runner temporary directory")
    output=Path(env.get("PAPERCLIP_PREFLIGHT_OUTPUT",""))
    expected=temp/"paperclip-image-preflight"
    if output!=expected or output.resolve()!=expected:
        raise ValueError("Output must be the exact non-symlink fixture directory under RUNNER_TEMP")
    if output.exists() and not output.is_dir():
        raise ValueError("Output exists and is not a directory")
    return commit,output

def load_config():
    commit,output=configuration(os.environ)
    output.mkdir(mode=0o700,exist_ok=True)
    return commit,output,40

def prepare_runner():
    commit,out,_=load_config()
    root=Path(__file__).resolve().parents[2]
    assert subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()==commit
    report={"source_commit":commit,"runner_label":"ubuntu-24.04","runner_environment":"github-hosted",
            "timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "minimum_start_free_gib":40,"abort_free_gib":18,
            "free_bytes_before":shutil.disk_usage(root).free,
            "removed_sdk_paths":[],"global_prune":False}
    try:
        # Exact optional SDK paths from the official docker.yml runner preparation.
        # Never Docker prune, repositories, credentials, user data, or arbitrary inputs.
        for name in SDK_PATHS:
            path=Path(name)
            if path.exists() or path.is_symlink():
                subprocess.run(["sudo","rm","-rf","--one-file-system","--",name],check=True,timeout=90)
                report["removed_sdk_paths"].append(name)
        report["free_bytes_after"]=shutil.disk_usage(root).free
        mem=dict(line.split(":",1) for line in Path("/proc/meminfo").read_text().splitlines())
        report["available_memory_bytes"]=int(mem["MemAvailable"].split()[0])*1024
        assert report["free_bytes_after"]>40*GIB,"Insufficient runner disk for the observed COPY peak"
        assert report["available_memory_bytes"]>=8*GIB,"Insufficient available memory for bounded builder"
        report["status"]="capacity_pass"
    except Exception as error:
        report["status"]="capacity_failed";report["error"]=str(error)
        raise
    finally:
        (out/"capacity.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))

def cleanup_image():
    commit,out,_=load_config()
    result=out/"build-result.json"
    report={"source_commit":commit,"image_removed":False,"status":"no_complete_image"}
    if result.exists():
        build=json.loads(result.read_text())
        assert build["commit"]==commit
        image=build.get("image_id")
        if image:
            assert re.fullmatch(r"sha256:[0-9a-f]{64}",image)
            tag="portal360/paperclip-candidate:"+commit[:9]+"-preflight"
            assert build["image_tag"]==tag
            actual=subprocess.run(["docker","image","inspect",tag],capture_output=True,text=True)
            if actual.returncode==0:
                assert json.loads(actual.stdout)[0]["Id"]==image
                subprocess.run(["docker","image","rm",tag],capture_output=True,text=True,check=True,timeout=90)
            remaining=subprocess.run(["docker","image","inspect",image],capture_output=True)
            report.update({"image_id":image,"image_removed":remaining.returncode!=0,
                           "status":"complete_image_cleaned" if remaining.returncode!=0 else "image_still_present"})
            assert report["image_removed"],"Fixture image cleanup incomplete"
    (out/"ci-cleanup.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))

if __name__=="__main__":
    if sys.argv[1:]==["prepare-runner"]:prepare_runner()
    elif sys.argv[1:]==["cleanup-image"]:cleanup_image()
    else:raise SystemExit("Expected prepare-runner or cleanup-image")
