use std::process::{Child, Command, Stdio};

use crate::SpawnSandboxedOptions;

pub fn backend_name() -> &'static str {
  // TODO(sandbox-unix): Implement macOS Seatbelt (`sandbox-exec`) and Linux
  // `landlock` + `seccomp` backends, then return `"macos-seatbelt"` / `"linux-landlock"`.
  "unsupported"
}

pub fn spawn_process(_id: u32, options: &SpawnSandboxedOptions) -> std::io::Result<Child> {
  let mut cmd = Command::new(&options.command);
  cmd.args(&options.args);
  cmd.current_dir(&options.cwd);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());
  if let Some(env_map) = &options.env {
    cmd.env_clear();
    for (k, v) in env_map {
      cmd.env(k, v);
    }
  }
  cmd.spawn()
}

pub fn kill_process(_id: u32) -> bool {
  false
}

pub fn cleanup_process(_id: u32) {}

