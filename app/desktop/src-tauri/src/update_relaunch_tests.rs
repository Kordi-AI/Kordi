use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    dir: PathBuf,
    old: Child,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kordi-relaunch-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        let old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let fixture = Self { dir, old };
        fixture.tool("open", "if /bin/kill -0 \"$OLD_PID\" 2>/dev/null; then exit 99; fi\nprintf '%s\\n' \"$@\" > \"$RECORD\"");
        fixture.tool("alert", "printf '%s\\n' \"$@\" > \"$ALERT\"");
        fixture
    }

    fn tool(&self, name: &str, body: &str) {
        let path = self.dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn helper(&self, polls: u32) -> Command {
        let mut command = helper_command(
            self.old.id(),
            Path::new("/Applications/Kordi ' $(touch unexpected) Test.app"),
            "--kordi-update-relaunch",
            &self.dir.join("open"),
            &self.dir.join("alert"),
            polls,
        );
        command
            .current_dir(&self.dir)
            .env("OLD_PID", self.old.id().to_string())
            .env("RECORD", self.dir.join("record"))
            .env("ALERT", self.dir.join("reported"));
        command
    }

    fn stop_old(&mut self) {
        self.old.kill().unwrap();
        self.old.wait().unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.old.kill();
        let _ = self.old.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn finish(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("relaunch helper did not finish");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn waits_for_exit_and_preserves_each_literal_argument() {
    let mut fixture = Fixture::new();
    let mut helper = fixture.helper(30).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(250));
    assert!(helper.try_wait().unwrap().is_none());
    assert!(!fixture.dir.join("record").exists());
    let group = Command::new("/bin/ps")
        .args(["-o", "pgid=", "-p", &helper.id().to_string()])
        .output()
        .unwrap();
    assert!(group.status.success());
    assert_eq!(
        String::from_utf8_lossy(&group.stdout).trim(),
        helper.id().to_string()
    );
    fixture.stop_old();
    assert!(finish(&mut helper).success());
    assert_eq!(
        fs::read_to_string(fixture.dir.join("record")).unwrap(),
        "/Applications/Kordi ' $(touch unexpected) Test.app\n--args\n--kordi-update-relaunch\n"
    );
    assert!(!fixture.dir.join("unexpected").exists());
    assert!(!fixture.dir.join("reported").exists());
}

#[test]
fn timeout_reports_recovery_without_launching_over_a_live_process() {
    let fixture = Fixture::new();
    let status = finish(&mut fixture.helper(1).spawn().unwrap());
    assert_eq!(status.code(), Some(75));
    assert!(!fixture.dir.join("record").exists());
    let report = fs::read_to_string(fixture.dir.join("reported")).unwrap();
    assert!(report.contains("Kordi did not finish quitting"));
}

#[test]
fn already_exited_process_launches_even_with_no_wait_budget() {
    let mut fixture = Fixture::new();
    fixture.stop_old();
    assert!(finish(&mut fixture.helper(0).spawn().unwrap()).success());
    assert!(fixture.dir.join("record").exists());
}

#[test]
fn launch_failure_reports_recovery_and_returns_failure() {
    let mut fixture = Fixture::new();
    fixture.stop_old();
    fixture.tool("open", "exit 1");
    assert_eq!(
        finish(&mut fixture.helper(1).spawn().unwrap()).code(),
        Some(1)
    );
    assert!(fs::read_to_string(fixture.dir.join("reported"))
        .unwrap()
        .contains("Kordi could not reopen"));
}

#[test]
fn unavailable_reporter_does_not_turn_launch_failure_into_success() {
    let mut fixture = Fixture::new();
    fixture.stop_old();
    fixture.tool("open", "exit 1");
    fs::remove_file(fixture.dir.join("alert")).unwrap();
    assert_eq!(
        finish(&mut fixture.helper(1).spawn().unwrap()).code(),
        Some(1)
    );
}

#[test]
fn production_command_uses_fixed_system_tools_and_bounded_wait() {
    let command = command(123, Path::new("/Applications/Kordi.app"), "--test");
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy())
        .collect();
    assert_eq!(&args[6..], &["/usr/bin/open", "/usr/bin/osascript", "300"]);
}
