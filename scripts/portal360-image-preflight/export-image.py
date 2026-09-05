"""Export only the immutable image identity that passed this job's isolated smoke."""
from pathlib import Path
import hashlib,json,re,shutil,subprocess,sys,time
sys.path.insert(0,str(Path(__file__).resolve().parent))
from preflight_config import load_config
GIB=1024**3
MAX_ARCHIVE_BYTES=6*GIB
MIN_FREE_BYTES=18*GIB

def validate_inputs(commit,build,smoke,image):
    assert re.fullmatch(r"[0-9a-f]{40}",commit),"Invalid source commit"
    assert build.get("commit")==smoke.get("source_commit")==commit,"Source identities differ"
    identity=build.get("image_id","")
    assert re.fullmatch(r"sha256:[0-9a-f]{64}",identity),"Invalid image identity"
    assert smoke.get("image_id")==image.get("Id")==identity,"Image identities differ"
    lock=build.get("derived_lock_sha256","")
    assert re.fullmatch(r"[0-9a-f]{64}",lock) and smoke.get("derived_lock_sha256")==lock,"Lock identities differ"
    assert build.get("status")=="built_not_smoked","No completed image"
    assert smoke.get("status")=="image_auth_and_route_validation_pass","No successful image smoke"
    health=smoke.get("health",{})
    assert health.get("http")==200 and health.get("commit")==commit,"Health source stamp not verified"
    expected={"signup_http":200,"authenticated_session":True,"bootstrap_claim_http":200,
              "empty_bearer_existing":401,"empty_bearer_missing":401,
              "authenticated_intake_invalid_body":400,"authenticated_missing_route":404,
              "valid_intake_submitted":False,"execution_not_tested":True}
    assert smoke.get("probe")==expected,"Required authentication/route probe differs"
    assert smoke.get("fixture_container_removed") and smoke.get("ephemeral_data_removed_with_container"),"Smoke state cleanup not verified"
    assert image.get("Os")=="linux" and image.get("Architecture")=="amd64","Unexpected image platform"
    size=image.get("Size")
    assert isinstance(size,int) and 0<size<=MAX_ARCHIVE_BYTES,"Unexpected image size"
    return identity,size

def main():
    commit,out,_=load_config()
    report={"source_commit":commit,"status":"export_not_started","max_archive_bytes":MAX_ARCHIVE_BYTES,
            "minimum_free_bytes":MIN_FREE_BYTES,"timeout_seconds":300,
            "method":"docker image save immutable image ID piped through gzip -n -1",
            "container_export_or_commit":False}
    archive=out/("paperclip-candidate-"+commit+".tar.gz")
    created=False;save=None;compress=None
    try:
        build=json.loads((out/"build-result.json").read_text())
        smoke=json.loads((out/"smoke-result.json").read_text())
        candidate=build.get("image_id","")
        assert re.fullmatch(r"sha256:[0-9a-f]{64}",candidate),"Invalid image ID before inspection"
        image=json.loads(subprocess.check_output(["docker","image","inspect",candidate],text=True,timeout=30))[0]
        identity,size=validate_inputs(commit,build,smoke,image)
        report.update({"image_id":identity,"image_size_bytes":size,
                       "derived_lock_sha256":build["derived_lock_sha256"],
                       "committed_lock_sha256":build["committed_lock_sha256"],
                       "archive_name":archive.name,
                       "smoke_result_sha256":hashlib.sha256((out/"smoke-result.json").read_bytes()).hexdigest(),
                       "artifact_name":"portal360-image-"+commit})
        assert shutil.disk_usage(out).free>MIN_FREE_BYTES+MAX_ARCHIVE_BYTES,"Insufficient export reserve"
        start=time.monotonic()
        sink=archive.open("xb");created=True
        with sink,(out/"image-export.txt").open("w") as log:
            save=subprocess.Popen(["docker","image","save",identity],stdout=subprocess.PIPE,stderr=log)
            compress=subprocess.Popen(["gzip","-n","-1"],stdin=save.stdout,stdout=sink,stderr=log)
            save.stdout.close()
            while save.poll() is None or compress.poll() is None:
                remaining=shutil.disk_usage(out).free
                report["minimum_observed_free_bytes"]=min(report.get("minimum_observed_free_bytes",remaining),remaining)
                assert remaining>MIN_FREE_BYTES,"Export disk reserve exhausted"
                assert archive.stat().st_size<=MAX_ARCHIVE_BYTES,"Archive cap exceeded"
                assert time.monotonic()-start<300,"Export timeout"
                time.sleep(1)
            assert save.wait()==0 and compress.wait()==0,"Image archive pipeline failed"
        report["archive_size_bytes"]=archive.stat().st_size
        assert 0<report["archive_size_bytes"]<=MAX_ARCHIVE_BYTES,"Invalid final archive size"
        digest=hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda:source.read(2*1024**2),b""):
                assert time.monotonic()-start<300,"Export hash timeout"
                digest.update(chunk)
        report["archive_sha256"]=digest.hexdigest()
        report["duration_seconds"]=round(time.monotonic()-start,2)
        report["status"]="verified_image_archive_ready"
    except Exception as error:
        report["status"]="export_failed";report["error"]=str(error)
        raise
    finally:
        for process in [save,compress]:
            if process is not None and process.poll() is None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
        if report["status"]!="verified_image_archive_ready" and created:
            archive.unlink(missing_ok=True)
            report["partial_archive_removed"]=not archive.exists()
        (out/"image-export.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))

if __name__=="__main__":main()
