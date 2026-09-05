#!/usr/bin/env python3
"""Smoke only an exact candidate image with disposable tmpfs state and no network."""
from pathlib import Path
import datetime,json,os,secrets,subprocess,time
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent
build=json.loads((OUT/"build-result.json").read_text())
assert build["status"]=="built_not_smoked","No completed candidate image"
IMAGE=build["image_id"]
NAME="portal360-intake-image-smoke-"+str(os.getpid())
def run(args,timeout=30,env=None):
    return subprocess.run(args,capture_output=True,text=True,timeout=timeout,env=env)
assert run(["docker","container","inspect",NAME]).returncode!=0
image_config=json.loads(subprocess.check_output(["docker","image","inspect",IMAGE],text=True))[0]
assert image_config["Id"]==IMAGE and not image_config["Config"].get("Volumes"),"Unexpected image/declared volumes"
report={"source_commit":build["commit"],"derived_lock_sha256":build["derived_lock_sha256"],"image_id":IMAGE,
        "started_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "constraints":{"network":"none","rootfs":"read-only","user":"1001:1001","memory":"2g","cpus":1,"pids":256,
                       "tmpfs":["/paperclip (1GiB)","/tmp (256MiB)"],"volumes":[],"ports":[],"scheduler":False,"telemetry":False}}
probe=r"""
import { randomBytes } from 'node:crypto';
const base='http://127.0.0.1:3100';
const results={};
let cookies='';
async function call(path,body,extra={}) {
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',
   headers:{'Content-Type':'application/json','Origin':base,...(cookies?{'Cookie':cookies}:{}),...extra},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
 const set=response.headers.getSetCookie();
 if(set.length) cookies=set.map(item=>item.split(';')[0]).join('; ');
 let value=null;try{value=await response.json();}catch{}
 return {status:response.status,value};
}
const signup=await call('/api/auth/sign-up/email',{name:'Synthetic preflight',email:'preflight@example.invalid',password:randomBytes(24).toString('base64url')});
results.signup_http=signup.status;
if(signup.status<200||signup.status>=300)throw new Error('synthetic signup failed HTTP '+signup.status);
const session=await call('/api/auth/get-session');
results.authenticated_session=Boolean(session.value?.session?.userId&&session.value?.user);
if(!results.authenticated_session)throw new Error('synthetic session not established');
const claim=await call('/api/bootstrap/claim',{});
results.bootstrap_claim_http=claim.status;
if(claim.status!==200)throw new Error('synthetic private bootstrap claim failed HTTP '+claim.status);
const company='11111111-1111-4111-8111-111111111111';
const present='/api/companies/'+company+'/regia/intake';
const absent='/api/companies/'+company+'/regia/not-a-route';
results.empty_bearer_existing=(await call(present,{}, {'Authorization':'Bearer'})).status;
results.empty_bearer_missing=(await call(absent,{}, {'Authorization':'Bearer'})).status;
if(results.empty_bearer_existing!==401||results.empty_bearer_missing!==401)throw new Error('empty bearer auth fence mismatch');
results.authenticated_intake_invalid_body=(await call(present,{})).status;
results.authenticated_missing_route=(await call(absent,{})).status;
if(results.authenticated_intake_invalid_body!==400||results.authenticated_missing_route!==404)throw new Error('authenticated route presence/validation mismatch');
results.valid_intake_submitted=false;
results.execution_not_tested=true;
console.log(JSON.stringify(results));
"""
try:
    args=["docker","run","-d","--name",NAME,"--network","none","--read-only","--user","1001:1001",
          "--cpus","1","--memory","2g","--pids-limit","256","--cap-drop","ALL","--security-opt","no-new-privileges",
          "--tmpfs","/paperclip:rw,nosuid,nodev,size=1073741824,uid=1001,gid=1001",
          "--tmpfs","/tmp:rw,nosuid,nodev,size=268435456,uid=1001,gid=1001",
          "--env","PAPERCLIP_TELEMETRY_DISABLED=1","--env","HEARTBEAT_SCHEDULER_ENABLED=false",
          "--env","PAPERCLIP_MIGRATION_AUTO_APPLY=true","--env","PAPERCLIP_MIGRATION_PROMPT=never",
          "--env","PAPERCLIP_OPEN_ON_LISTEN=false","--env","PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3100",
          "--env","PAPERCLIP_DEPLOYMENT_MODE=authenticated","--env","PAPERCLIP_DEPLOYMENT_EXPOSURE=private",
          "--env","TSX_DISABLE_CACHE=1","--env","BETTER_AUTH_SECRET",IMAGE]
    # Ephemeral auth fixture only; never written to arguments, logs or the receipt.
    started=run(args,env=dict(os.environ,BETTER_AUTH_SECRET=secrets.token_urlsafe(48)));assert started.returncode==0,started.stderr
    inspect=json.loads(subprocess.check_output(["docker","inspect",NAME],text=True))[0]
    assert inspect["HostConfig"]["NetworkMode"]=="none" and inspect["HostConfig"]["ReadonlyRootfs"]
    assert not inspect["HostConfig"]["PortBindings"],"Unexpected port binding"
    assert set(inspect["HostConfig"]["Tmpfs"])=={"/paperclip","/tmp"}
    assert all(m["Type"]=="tmpfs" and m["Destination"] in {"/paperclip","/tmp"} for m in inspect["Mounts"]),"Unexpected mount"
    assert inspect["Config"]["User"]=="1001:1001"
    assert inspect["HostConfig"]["Memory"]==2*1024**3 and inspect["HostConfig"]["NanoCpus"]==10**9
    health_code="const r=await fetch('http://127.0.0.1:3100/api/health');const j=await r.json();console.log(JSON.stringify({http:r.status,status:j.status,commit:j.commit,deploymentMode:j.deploymentMode,bootstrapStatus:j.bootstrapStatus}));"
    health=None
    for attempt in range(90):
        r=run(["docker","exec",NAME,"node","--input-type=module","-e",health_code],10)
        if r.returncode==0:
            candidate=json.loads(r.stdout)
            if candidate.get("http")==200:health=candidate;break
        state=json.loads(subprocess.check_output(["docker","inspect",NAME],text=True))[0]["State"]
        if not state["Running"]:raise RuntimeError("Fixture server exited; code="+str(state["ExitCode"])+" OOM="+str(state["OOMKilled"]))
        time.sleep(2)
    assert health is not None,"Fixture readiness timeout"
    report["health"]=health
    assert isinstance(health.get("commit"),str) and len(health["commit"])>=7 and build["commit"].startswith(health["commit"]),"Wrong image source stamp"
    r=run(["docker","exec",NAME,"node","--input-type=module","-e",probe],90)
    if r.returncode!=0:
        # The probe prints no response bodies, passwords, cookies or generated tokens.
        report["probe_error"]=r.stderr[-2000:]
        raise RuntimeError("Synthetic authenticated image probe failed")
    report["probe"]=json.loads(r.stdout)
    report["status"]="image_auth_and_route_validation_pass"
except Exception as error:
    report["status"]="smoke_failed";report["error"]=str(error)
    raise
finally:
    run(["docker","stop","--time","10",NAME],20)
    run(["docker","rm","-f",NAME],30)
    report["fixture_container_removed"]=run(["docker","container","inspect",NAME]).returncode!=0
    report["ephemeral_data_removed_with_container"]=report["fixture_container_removed"]
    report["candidate_image_retained"]=True
    (OUT/"smoke-result.json").write_text(json.dumps(report,indent=2)+"\n")
    assert report["fixture_container_removed"],"Fixture cleanup incomplete"
print(json.dumps(report,indent=2))
