"""Synthetic Docker filesystem regression only; no registry or app server."""
from pathlib import Path
import datetime,json,os,subprocess,tempfile
OUT=Path(__file__).resolve().parent
IMAGE=json.loads(subprocess.check_output(["docker","image","inspect","node:24"],text=True))[0]["Id"]
report={"image_id":IMAGE,"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope":"Synthetic file permissions and temporary cache only; no pnpm install, network or application execution",
        "cases":[]}
code="""const fs=require('node:fs');
try {
 fs.readFileSync('/context/package.json','utf8');
 fs.writeFileSync('/context/pnpm-lock.yaml','synthetic fixture only');
 fs.mkdirSync(process.env.COREPACK_HOME,{recursive:true});
 fs.writeFileSync(process.env.COREPACK_HOME+'/synthetic','fixture');
 fs.mkdirSync(process.env.HOME+'/.local/share/pnpm/store',{recursive:true});
 fs.writeFileSync(process.env.HOME+'/.local/share/pnpm/store/synthetic','fixture');
 console.log(JSON.stringify({uid:process.getuid(),context_read:true,context_write:true,temporary_cache_write:true}));
} catch(e) {
 console.log(JSON.stringify({uid:process.getuid(),error_code:e.code}));
 process.exit(42);
}"""
with tempfile.TemporaryDirectory(prefix="paperclip-context-owner-") as temp:
    context=Path(temp)/"context";context.mkdir(mode=0o700);os.chown(context,1001,1001)
    manifest=context/"package.json";manifest.write_text('{"name":"synthetic-preflight"}');os.chown(manifest,1001,1001)
    for uid in [0,1001]:
        name="portal360-context-owner-"+str(os.getpid())+"-"+str(uid)
        assert subprocess.run(["docker","container","inspect",name],capture_output=True).returncode!=0
        case={"container":name,"user":str(uid)+":"+str(uid)}
        try:
            args=["docker","create","--name",name,"--user",case["user"],
                  "--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
                  "--memory","128m","--memory-swap","128m","--cpus","0.25","--pids-limit","64",
                  "--tmpfs","/tmp:rw,nosuid,nodev,size=16777216,uid=1001,gid=1001,mode=1777",
                  "--mount","type=bind,src="+str(context)+",dst=/context",
                  "--env","HOME=/tmp","--env","COREPACK_HOME=/tmp/corepack",
                  IMAGE,"node","-e",code]
            created=subprocess.run(args,capture_output=True,text=True,check=True)
            config=json.loads(subprocess.check_output(["docker","inspect",name],text=True))[0]
            hc=config["HostConfig"]
            assert hc["NetworkMode"]=="none" and hc["ReadonlyRootfs"]
            assert hc["Memory"]==134217728 and hc["NanoCpus"]==250000000
            assert config["Config"]["User"]==case["user"]
            assert all((m["Type"]=="bind" and m["Source"]==str(context) and m["Destination"]=="/context") or
                       (m["Type"]=="tmpfs" and m["Destination"]=="/tmp") for m in config["Mounts"])
            result=subprocess.run(["docker","start","--attach",name],capture_output=True,text=True,timeout=20)
            case["exit_code"]=result.returncode;case["probe"]=json.loads(result.stdout)
            if uid==0:assert result.returncode==42 and case["probe"]["error_code"]=="EACCES"
            else:assert result.returncode==0 and case["probe"]["temporary_cache_write"]
        finally:
            subprocess.run(["docker","rm","-f",name],capture_output=True,timeout=20)
            case["container_removed"]=subprocess.run(["docker","container","inspect",name],capture_output=True).returncode!=0
            report["cases"].append(case)
            assert case["container_removed"]
    temp_path=temp
report["temporary_context_removed"]=not Path(temp_path).exists()
report["status"]="permission_regression_pass"
(OUT/"permission-regression.json").write_text(json.dumps(report,indent=2)+"\n")
print(json.dumps(report,indent=2))
