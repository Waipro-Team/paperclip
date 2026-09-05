"""Pure guard tests: no Docker, SDK cleanup or external activity."""
from pathlib import Path
import importlib.util,tempfile,unittest
spec=importlib.util.spec_from_file_location("preflight_config",Path(__file__).with_name("preflight_config.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="paperclip-ci-guard-test-")
        self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        self.env={"GITHUB_ACTIONS":"true","RUNNER_ENVIRONMENT":"github-hosted","RUNNER_OS":"Linux",
                  "RUNNER_TEMP":str(self.base),"PAPERCLIP_PREFLIGHT_OUTPUT":str(self.base/"paperclip-image-preflight"),
                  "PAPERCLIP_PREFLIGHT_COMMIT":"a"*40}
    def test_exact_hosted_fixture(self):
        self.assertEqual(module.configuration(self.env),("a"*40,self.base/"paperclip-image-preflight"))
        self.assertFalse((self.base/"paperclip-image-preflight").exists())
    def test_server_and_self_hosted_rejected(self):
        for key,value in [("GITHUB_ACTIONS","false"),("RUNNER_ENVIRONMENT","self-hosted"),("RUNNER_OS","Windows")]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                module.configuration(dict(self.env,**{key:value}))
    def test_nonexact_source_rejected(self):
        for value in ["a"*7,"../master","HEAD","a"*39+";",""]:
            with self.subTest(value=value),self.assertRaises(ValueError):
                module.configuration(dict(self.env,PAPERCLIP_PREFLIGHT_COMMIT=value))
    def test_output_escape_rejected(self):
        for output in ["/",str(self.base),str(self.base/"other"),str(self.base/"../outside"),""]:
            with self.subTest(output=output),self.assertRaises(ValueError):
                module.configuration(dict(self.env,PAPERCLIP_PREFLIGHT_OUTPUT=output))
    def test_output_symlink_rejected(self):
        target=self.base/"other";target.mkdir()
        (self.base/"paperclip-image-preflight").symlink_to(target,target_is_directory=True)
        with self.assertRaises(ValueError):module.configuration(self.env)
    def test_temp_symlink_rejected(self):
        target=self.base/"actual";target.mkdir()
        link=self.base/"linked";link.symlink_to(target,target_is_directory=True)
        env=dict(self.env,RUNNER_TEMP=str(link),PAPERCLIP_PREFLIGHT_OUTPUT=str(link/"paperclip-image-preflight"))
        with self.assertRaises(ValueError):module.configuration(env)
    def test_existing_file_rejected(self):
        (self.base/"paperclip-image-preflight").write_text("synthetic")
        with self.assertRaises(ValueError):module.configuration(self.env)

if __name__=="__main__":unittest.main()
