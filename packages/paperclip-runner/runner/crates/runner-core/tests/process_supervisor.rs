#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

use paperclip_runner_core::local_runner::HarnessCommand;
use paperclip_runner_core::process_supervisor::SupervisedProcess;
use serde_json::{json, Value};

fn process_exists(pid: u64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn spawn_linger_process() -> (SupervisedProcess, u32, u64) {
    let harness = PathBuf::from(env!("CARGO_BIN_EXE_fake-harness"));
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/local-runner/scripts/linger.json");
    let mut process = SupervisedProcess::spawn(
        &harness,
        &[
            "--script".to_owned(),
            script.display().to_string(),
            "--delay-ms".to_owned(),
            "1".to_owned(),
        ],
        Duration::from_millis(50),
        64 * 1024,
    )
    .expect("fake harness should start");
    let harness_pid = process.id();
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("ready line should be readable")
        .expect("ready line should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "open".to_owned(),
            command_type: "session.open".to_owned(),
            payload: json!({}),
        })
        .expect("session.open should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("session line should be readable")
        .expect("session line should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "turn".to_owned(),
            command_type: "turn.start".to_owned(),
            payload: json!({ "turnId": "turn_cleanup" }),
        })
        .expect("turn.start should send");

    let mut worker_pid = None;
    for _ in 0..5 {
        let line = process
            .receive_stdout_line(Duration::from_secs(1))
            .expect("harness output should be readable")
            .expect("harness output should continue");
        let message: Value = serde_json::from_str(&line).expect("harness output should be JSON");
        if message["type"] == "diagnostic" {
            worker_pid = message["payload"]["workerPid"].as_u64();
            break;
        }
    }
    let worker_pid = worker_pid.expect("linger script should report its worker pid");
    assert!(process_exists(u64::from(harness_pid)));
    assert!(process_exists(worker_pid));
    (process, harness_pid, worker_pid)
}

#[test]
fn forced_process_group_cleanup_stops_harness_and_worker() {
    let (mut process, harness_pid, worker_pid) = spawn_linger_process();

    process
        .terminate_group()
        .expect("process group cleanup should finish");
    std::thread::sleep(Duration::from_millis(20));
    assert!(!process_exists(u64::from(harness_pid)));
    assert!(!process_exists(worker_pid));
}

#[test]
fn natural_harness_exit_also_cleans_up_workers() {
    let (mut process, harness_pid, worker_pid) = spawn_linger_process();
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "interrupt".to_owned(),
            command_type: "turn.interrupt".to_owned(),
            payload: json!({ "reason": "cleanup_test" }),
        })
        .expect("turn.interrupt should send");
    process
        .wait()
        .expect("harness should exit after interruption");

    std::thread::sleep(Duration::from_millis(20));
    assert!(!process_exists(u64::from(harness_pid)));
    assert!(!process_exists(worker_pid));
}

#[test]
fn oversized_harness_stdout_frame_is_rejected() {
    let harness = PathBuf::from(env!("CARGO_BIN_EXE_fake-harness"));
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/local-runner/scripts/oversized-line.json");
    let mut process = SupervisedProcess::spawn(
        &harness,
        &[
            "--script".to_owned(),
            script.display().to_string(),
            "--delay-ms".to_owned(),
            "1".to_owned(),
        ],
        Duration::from_millis(50),
        512,
    )
    .expect("fake harness should start");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("ready frame should fit")
        .expect("ready frame should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "open".to_owned(),
            command_type: "session.open".to_owned(),
            payload: json!({}),
        })
        .expect("session.open should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("session frame should fit")
        .expect("session frame should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "turn".to_owned(),
            command_type: "turn.start".to_owned(),
            payload: json!({ "turnId": "turn_oversized" }),
        })
        .expect("turn.start should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("turn frame should fit")
        .expect("turn frame should exist");

    let mut oversized_error = None;
    for _ in 0..3 {
        match process.receive_stdout_line(Duration::from_secs(1)) {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(error) => {
                oversized_error = Some(error);
                break;
            }
        }
    }
    let error = oversized_error.expect("oversized harness frame must be rejected");
    assert!(error.to_string().contains("exceeded 512 bytes"));

    process
        .terminate_group()
        .expect("oversized-frame harness should be cleaned up");
}

#[test]
fn process_exit_waits_for_stdout_and_closes_inherited_writer_handles() {
    let mut process = SupervisedProcess::spawn(
        &PathBuf::from("/bin/sh"),
        &[
            "-c".to_owned(),
            "sleep 30 & printf 'queued-output\\n'; exit 7".to_owned(),
        ],
        Duration::from_millis(50),
        1024,
    )
    .expect("provider with an inherited stdout writer should start");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while process.try_wait().expect("inspect exited leader").is_none() {
        assert!(std::time::Instant::now() < deadline, "leader did not exit");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        process
            .try_wait_after_stdout()
            .expect("reap exited leader and inherited writer")
            .is_none(),
        "process exit must not overtake unread stdout"
    );
    let mut lines = Vec::new();
    let exit = loop {
        assert!(std::time::Instant::now() < deadline, "stdout did not drain");
        if let Some(line) = process
            .receive_stdout_line(Duration::from_millis(10))
            .expect("read queued provider output")
        {
            lines.push(line);
        }
        if let Some(exit) = process
            .try_wait_after_stdout()
            .expect("observe exit after stdout closes")
        {
            break exit;
        }
    };
    assert_eq!(lines, vec!["queued-output"]);
    assert_eq!(exit.exit_code, Some(7));
    assert!(!exit.success);
}

#[cfg(target_os = "linux")]
#[test]
fn exited_process_fails_boundedly_when_a_detached_writer_keeps_stdout_open() {
    struct DetachedGroupCleanup(u32);
    impl Drop for DetachedGroupCleanup {
        fn drop(&mut self) {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.0)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    let mut process = SupervisedProcess::spawn(
        &PathBuf::from("/bin/sh"),
        &[
            "-c".to_owned(),
            "setsid /bin/sh -c 'echo detached:$$; sleep 30' & read marker; printf 'queued-output\\n'; exit 7".to_owned(),
        ],
        Duration::from_millis(50),
        1024,
    )
    .expect("provider with a detached stdout writer should start");
    let detached_pid = process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("detached writer identity should be readable")
        .expect("detached writer should report its identity")
        .strip_prefix("detached:")
        .expect("expected detached writer identity")
        .parse::<u32>()
        .expect("detached writer identity should be a PID");
    let _cleanup = DetachedGroupCleanup(detached_pid);
    process.send(&json!("finish")).expect("release the leader");

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while process.try_wait().expect("inspect exited leader").is_none() {
        assert!(std::time::Instant::now() < deadline, "leader did not exit");
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut lines = Vec::new();
    let error = loop {
        assert!(
            std::time::Instant::now() < deadline,
            "detached stdout writer left the exit poll unbounded"
        );
        if let Some(line) = process
            .receive_stdout_line(Duration::from_millis(1))
            .expect("read queued output before the drain deadline")
        {
            lines.push(line);
        }
        match process.try_wait_after_stdout() {
            Err(error) => break error,
            Ok(None) => {}
            Ok(Some(_)) => panic!("an unclosed output stream must not publish normal exit"),
        }
    };
    assert_eq!(lines, vec!["queued-output"]);
    assert!(error.to_string().contains("stdout did not close"));
}
