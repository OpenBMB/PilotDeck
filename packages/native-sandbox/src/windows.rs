use std::collections::HashMap;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
  AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
  SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use crate::SpawnSandboxedOptions;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct JobHandle(HANDLE);
// Win32 HANDLE is safe to send/share across threads when synchronized by Mutex.
unsafe impl Send for JobHandle {}

static ACTIVE_JOBS: OnceLock<Mutex<HashMap<u32, JobHandle>>> = OnceLock::new();

fn active_jobs() -> &'static Mutex<HashMap<u32, JobHandle>> {
  ACTIVE_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn backend_name() -> &'static str {
  "windows-job"
}

pub fn spawn_process(id: u32, options: &SpawnSandboxedOptions) -> std::io::Result<Child> {
  let mut cmd = Command::new(&options.command);
  cmd.current_dir(&options.cwd);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());
  cmd.creation_flags(CREATE_NO_WINDOW);

  if options.windows_verbatim_arguments.unwrap_or(false) {
    for arg in &options.args {
      cmd.raw_arg(arg);
    }
  } else {
    cmd.args(&options.args);
  }

  if let Some(env_map) = &options.env {
    cmd.env_clear();
    for (k, v) in env_map {
      cmd.env(k, v);
    }
  }

  // TODO(sandbox-windows): Add AppContainer / Low-Integrity + workspace ACL restriction
  // for fine-grained filesystem and network isolation beyond Job Object containment.
  let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
  if job.is_null() {
    return Err(std::io::Error::last_os_error());
  }

  let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  let configured = unsafe {
    SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      &info as *const _ as *const std::ffi::c_void,
      std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    )
  };
  if configured == 0 {
    let err = std::io::Error::last_os_error();
    unsafe { CloseHandle(job) };
    return Err(err);
  }

  let child = match cmd.spawn() {
    Ok(c) => c,
    Err(err) => {
      unsafe { CloseHandle(job) };
      return Err(err);
    }
  };

  let assigned = unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) };
  if assigned == 0 {
    // Process may have already exited before assignment; close job and proceed.
    unsafe { CloseHandle(job) };
    return Ok(child);
  }

  if let Ok(mut guard) = active_jobs().lock() {
    guard.insert(id, JobHandle(job));
  } else {
    unsafe { CloseHandle(job) };
  }

  Ok(child)
}

pub fn kill_process(id: u32) -> bool {
  let guard = match active_jobs().lock() {
    Ok(g) => g,
    Err(_) => return false,
  };
  if let Some(job) = guard.get(&id) {
    let ok = unsafe { TerminateJobObject(job.0, 1) } != 0;
    return ok;
  }
  false
}

pub fn cleanup_process(id: u32) {
  if let Ok(mut guard) = active_jobs().lock() {
    if let Some(job) = guard.remove(&id) {
      unsafe { CloseHandle(job.0) };
    }
  }
}

