"""Pure negative provenance gates: no image export or Docker calls."""
from pathlib import Path
import importlib.util,json,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
spec=importlib.util.spec_from_file_location("export_image",Path(__file__).with_name("export-image.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ExportGates(unittest.TestCase):
    def setUp(self):
        self.commit="a"*40;self.image_id="sha256:"+"b"*64
        self.build={"commit":self.commit,"image_id":self.image_id,"derived_lock_sha256":"c"*64,"status":"built_not_smoked"}
        self.smoke={"source_commit":self.commit,"image_id":self.image_id,"derived_lock_sha256":"c"*64,
                    "status":"image_auth_and_route_validation_pass","health":{"http":200,"commit":self.commit},
                    "probe":{"signup_http":200,"authenticated_session":True,"bootstrap_claim_http":200,
                             "empty_bearer_existing":401,"empty_bearer_missing":401,
                             "authenticated_intake_invalid_body":400,"authenticated_missing_route":404,
                             "valid_intake_submitted":False,"execution_not_tested":True},
                    "fixture_container_removed":True,"ephemeral_data_removed_with_container":True}
        self.image={"Id":self.image_id,"Size":4790410296,"Os":"linux","Architecture":"amd64"}
    def validate(self):return module.validate_inputs(self.commit,self.build,self.smoke,self.image)
    def test_complete_provenance(self):self.assertEqual(self.validate(),(self.image_id,4790410296))
    def test_wrong_source_image_or_lock_rejected(self):
        for key,value in [("source_commit","d"*40),("image_id","sha256:"+"e"*64),("derived_lock_sha256","f"*64)]:
            old=self.smoke[key];self.smoke[key]=value
            with self.subTest(key=key),self.assertRaises(AssertionError):self.validate()
            self.smoke[key]=old
    def test_missing_build_or_smoke_rejected(self):
        self.build["status"]="not_built"
        with self.assertRaises(AssertionError):self.validate()
        self.build["status"]="built_not_smoked";self.smoke["status"]="not_run"
        with self.assertRaises(AssertionError):self.validate()
    def test_wrong_health_or_auth_result_rejected(self):
        self.smoke["health"]["commit"]="a"*7
        with self.assertRaises(AssertionError):self.validate()
        self.smoke["health"]["commit"]=self.commit;self.smoke["probe"]["authenticated_intake_invalid_body"]=401
        with self.assertRaises(AssertionError):self.validate()
    def test_valid_intake_or_unclean_fixture_rejected(self):
        self.smoke["probe"]["valid_intake_submitted"]=True
        with self.assertRaises(AssertionError):self.validate()
        self.smoke["probe"]["valid_intake_submitted"]=False;self.smoke["fixture_container_removed"]=False
        with self.assertRaises(AssertionError):self.validate()
    def test_wrong_local_image_rejected(self):
        self.image["Id"]="sha256:"+"f"*64
        with self.assertRaises(AssertionError):self.validate()
    def test_failed_smoke_never_starts_export_pipeline(self):
        self.smoke["status"]="not_run"
        with tempfile.TemporaryDirectory(prefix="paperclip-export-gate-") as temp:
            out=Path(temp)
            (out/"build-result.json").write_text(json.dumps(self.build))
            (out/"smoke-result.json").write_text(json.dumps(self.smoke))
            with patch.object(module,"load_config",return_value=(self.commit,out,40)), \
                 patch.object(module.subprocess,"check_output",return_value=json.dumps([self.image])), \
                 patch.object(module.subprocess,"Popen",side_effect=AssertionError("Export must not start")) as launch:
                with self.assertRaisesRegex(AssertionError,"No successful image smoke"):module.main()
                launch.assert_not_called()
            self.assertEqual(list(out.glob("*.tar.gz")),[])
            self.assertEqual(json.loads((out/"image-export.json").read_text())["status"],"export_failed")
    def test_platform_or_size_rejected(self):
        self.image["Architecture"]="arm64"
        with self.assertRaises(AssertionError):self.validate()
        self.image["Architecture"]="amd64";self.image["Size"]=module.MAX_ARCHIVE_BYTES+1
        with self.assertRaises(AssertionError):self.validate()

if __name__=="__main__":unittest.main()
