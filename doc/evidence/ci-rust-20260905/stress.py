#!/usr/bin/env python3
"""Bounded Linux contention reproduction for the synthetic Codex integration test."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--runs", type=int, default=200)
parser.add_argument("--workers", type=int, default=4)
parser.add_argument("--cpu", type=int, default=min(os.sched_getaffinity(0)))
args = parser.parse_args()
assert 1 <= args.runs <= 200 and 1 <= args.workers <= 4
assert args.cpu in os.sched_getaffinity(0)
binary = args.binary.resolve(strict=True)
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix="paperclip-codex-ci-stress-") as scratch:
    env = dict(os.environ, TMPDIR=scratch)
    def run(attempt):
        result = subprocess.run(
            ["taskset", "-c", str(args.cpu), str(binary),
             "ambiguous_replacement_turn_adopts_one_later_completion_identity",
             "--exact", "--nocapture"],
            env=env, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=20,
        )
        return {"attempt": attempt, "exit": result.returncode,
                "failure": result.stdout if result.returncode else None}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, range(1, args.runs + 1)))
failures = [result for result in results if result["exit"]]
print(json.dumps({
    "binary": str(binary), "runs": args.runs, "workers": args.workers,
    "cpu": args.cpu, "seconds": round(time.monotonic() - started, 3),
    "passed": args.runs - len(failures), "failed": len(failures),
    "failures": failures,
}, indent=2))
raise SystemExit(bool(failures))
