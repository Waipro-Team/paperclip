# Correct Actions output-path context

GitHub rejected the initial workflow at commit d85760f0695fdf6ab99c171859ccc3cc3c1fc579 before allocating a job: runner.temp is unavailable in job-level env. The real [workflow validation failure](https://github.com/Waipro-Team/paperclip/actions/runs/33950400378) exposed a gap in the earlier YAML parse and review. No image build, smoke or runtime activity occurred in that failed run.

The fix removes only the OUTPUT value from job-level env and initializes it in a run step through quoted RUNNER_TEMP and GITHUB_ENV variables. The exact PR head SHA stays in the valid github context; all hosted-runner/path guards and resource limits remain unchanged.

Actionlint release1.7.12 passed semantic workflow validation. Its Linux archive was downloaded from the official release, checked against the published checksum and executed only in a dedicated temporary server directory; that directory was removed in the same activity. Bash syntax and Git diff whitespace checks passed. External shellcheck/pyflakes were not invoked; this is stated in actionlint-result.json.

The previous full-image-ci manifest describes the original d85760f06 snapshot; its workflow hash is intentionally superseded only by the new scoped manifest here. The separate full-image-build history is unchanged. This fix is ready for independent review and a new PR run, not a claim that GitHub image validation already succeeded.
