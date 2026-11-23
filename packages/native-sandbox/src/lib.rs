use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod unix;

#[cfg(windows)]
use windows as platform;
#[cfg(not(windows))]
use unix as platform;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[napi(object)]
pub struct SpawnSandboxedOptions {
  pub command: String,
  pub args: Vec<String>,
  pub cwd: String,
  pub env: Option<HashMap<String, String>>,
  pub allow_network: Option<bool>,
  pub windows_verbatim_arguments: Option<bool>,
}

#[napi(object)]
pub struct SandboxOutputEvent {
  pub kind: String,
  pub data: Option<Buffer>,
  pub exit_code: Option<i32>,
  pub error: Option<String>,
}

#[napi]
pub fn sandbox_backend() -> String {
  platform::backend_name().to_string()
}

#[napi]
pub fn kill_sandboxed(id: u32) -> bool {
  platform::kill_process(id)
}

#[napi]
pub fn start_sandboxed(
  options: SpawnSandboxedOptions,
  #[napi(ts_arg_type = "(err: Error | null, event: SandboxOutputEvent) => void")]
  on_event: ThreadsafeFunction<SandboxOutputEvent, ErrorStrategy::CalleeHandled>,
) -> Result<u32> {
  let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let mut child = platform::spawn_process(id, &options)
    .map_err(|err| Error::from_reason(format!("Failed to spawn sandboxed process: {err}")))?;

  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let out_tsfn = on_event.clone();
  let err_tsfn = on_event.clone();

  thread::spawn(move || {
    let stdout_handle = stdout.map(|mut pipe| {
      thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
          match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
              let event = SandboxOutputEvent {
                kind: "stdout".to_string(),
                data: Some(Buffer::from(&buf[..n])),
                exit_code: None,
                error: None,
              };
              let _ = out_tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
          }
        }
      })
    });

    let stderr_handle = stderr.map(|mut pipe| {
      thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
          match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
              let event = SandboxOutputEvent {
                kind: "stderr".to_string(),
                data: Some(Buffer::from(&buf[..n])),
                exit_code: None,
                error: None,
              };
              let _ = err_tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
          }
        }
      })
    });

    if let Some(handle) = stdout_handle {
      let _ = handle.join();
    }
    if let Some(handle) = stderr_handle {
      let _ = handle.join();
    }

    let exit_result = child.wait();
    platform::cleanup_process(id);

    match exit_result {
      Ok(status) => {
        let event = SandboxOutputEvent {
          kind: "exit".to_string(),
          data: None,
          exit_code: status.code(),
          error: None,
        };
        let _ = on_event.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
      }
      Err(err) => {
        let event = SandboxOutputEvent {
          kind: "error".to_string(),
          data: None,
          exit_code: None,
          error: Some(err.to_string()),
        };
        let _ = on_event.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
      }
    }
  });

  Ok(id)
}

