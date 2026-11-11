//! A detached, bounded handoff to macOS LaunchServices after the old app exits.

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

const SCRIPT: &str = include_str!("update_relaunch.sh");

pub(crate) fn command(pid: u32, bundle: &Path, relaunch_arg: &str) -> Command {
    helper_command(
        pid,
        bundle,
        relaunch_arg,
        Path::new("/usr/bin/open"),
        Path::new("/usr/bin/osascript"),
        300,
    )
}

fn helper_command(
    pid: u32,
    bundle: &Path,
    relaunch_arg: &str,
    launcher: &Path,
    reporter: &Path,
    polls: u32,
) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(SCRIPT)
        .arg("kordi-update-relaunch")
        .arg(pid.to_string())
        .arg(bundle)
        .arg(relaunch_arg)
        .arg(launcher)
        .arg(reporter)
        .arg(polls.to_string())
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
#[path = "update_relaunch_tests.rs"]
mod tests;
