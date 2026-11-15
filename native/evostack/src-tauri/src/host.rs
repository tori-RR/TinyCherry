use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_LINE_BYTES: usize = 1024;

pub fn build_info() -> Value {
    json!({
        "version": option_env!("EVOSTACK_APP_VERSION").unwrap_or("2.1.10"),
        "revision": option_env!("EVOSTACK_BUILD_REVISION").unwrap_or("development"),
        "protocol": 1
    })
}

pub fn verify_backend_info(info: &Value) -> Result<(), String> {
    let expected = build_info();
    if info["version"] != expected["version"]
        || info["protocol"] != expected["protocol"]
        || (expected["revision"] != "development" && info["revision"] != expected["revision"])
    {
        return Err("EVOSTACK_BACKEND_VERSION_MISMATCH: keep the host and sidecar from the same portable package".into());
    }
    Ok(())
}

pub fn trusted_origin(url: &url::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("http", Some("tauri.localhost")) | ("tauri", Some("localhost"))
        )
}

pub fn request_timeout(method: &str, params: &Value) -> Duration {
    match method {
        "backend.shutdown" => Duration::from_secs(2),
        "backend.info" => Duration::from_secs(5),
        "ipc.invoke" if params["channel"] == "ipc-api:request" => {
            match params["args"][0].as_str() {
                Some("ai.provider.model.list" | "ai.provider.model.check") => {
                    Duration::from_secs(45)
                }
                Some("ai.stream.abort") => Duration::from_secs(5),
                _ => Duration::from_secs(15),
            }
        }
        _ => Duration::from_secs(15),
    }
}

struct LogFile {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
}

pub struct Diagnostics(Mutex<LogFile>);

impl Diagnostics {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let path = directory.join("backend-stderr.log");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self(Mutex::new(LogFile {
            path,
            file: Some(file),
            bytes,
        })))
    }

    pub fn record(&self, message: &str) {
        let _ = self.write(message);
    }

    fn write(&self, message: &str) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let message: String = message.chars().take(MAX_LINE_BYTES).collect();
        let line = format!("{timestamp} {message}\n");
        if state.bytes + line.len() as u64 > MAX_LOG_BYTES {
            drop(state.file.take());
            let backup = state.path.with_extension("log.1");
            match std::fs::remove_file(&backup) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            std::fs::rename(&state.path, backup)?;
            state.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&state.path)?,
            );
            state.bytes = 0;
        }
        state
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("diagnostic log unavailable"))?
            .write_all(line.as_bytes())?;
        state.bytes += line.len() as u64;
        Ok(())
    }
}

fn stderr_summary(line: &[u8]) -> &'static str {
    match line.strip_suffix(b"\r").unwrap_or(line) {
        b"EvoStack profile cannot be acquired" => "stderr: EvoStack profile cannot be acquired",
        b"EvoStack database initialization failed" => {
            "stderr: EvoStack database initialization failed"
        }
        line if line.starts_with(b"panic:") => {
            "stderr: backend panic (unstructured details suppressed)"
        }
        line if line.starts_with(b"fatal error:") => {
            "stderr: backend fatal error (unstructured details suppressed)"
        }
        _ => "stderr: unstructured output suppressed",
    }
}

// Stderr is not a trusted diagnostic format: a panic can embed an API key. Retain known
// startup categories and lifecycle status, never arbitrary text or JSON-RPC contents.
pub fn capture_stderr(mut reader: impl Read, diagnostics: &Diagnostics) {
    let mut line = Vec::with_capacity(MAX_LINE_BYTES);
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                diagnostics.record(stderr_summary(&line));
                line.clear();
            } else if line.len() < MAX_LINE_BYTES {
                line.push(*byte);
            }
        }
    }
    if !line.is_empty() {
        diagnostics.record(stderr_summary(&line));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_requires_the_exact_packaged_scheme_and_authority() {
        for raw in [
            "http://tauri.localhost/windows/evostack/index.html",
            "tauri://localhost/windows/evostack/index.html",
        ] {
            assert!(trusted_origin(&url::Url::parse(raw).unwrap()), "{raw}");
        }
        for raw in [
            "tauri://attacker/index.html",
            "https://tauri.localhost/",
            "http://tauri.localhost:8123/",
            "tauri://localhost:80/",
            "http://user@tauri.localhost/",
            "http://tauri.localhost.attacker/",
            "file://tauri.localhost/index.html",
        ] {
            assert!(!trusted_origin(&url::Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn probe_deadline_leaves_room_for_the_go_deadline() {
        let params = json!({"channel":"ipc-api:request", "args":["ai.provider.model.check", {}]});
        assert!(request_timeout("ipc.invoke", &params) > Duration::from_secs(30));
        assert!(request_timeout("ipc.invoke", &Value::Null) < Duration::from_secs(30));
        assert!(request_timeout("backend.shutdown", &Value::Null) < Duration::from_secs(5));
    }

    #[test]
    fn build_handshake_rejects_mismatched_sidecars() {
        let info = build_info();
        assert!(verify_backend_info(&info).is_ok());
        let mut mismatch = info;
        mismatch["protocol"] = json!(2);
        assert!(verify_backend_info(&mismatch).is_err());
        mismatch["protocol"] = json!(1);
        mismatch["version"] = json!("wrong");
        assert!(verify_backend_info(&mismatch).is_err());
    }

    #[test]
    fn diagnostics_rotate_and_do_not_retain_credentials_from_stderr() {
        let directory =
            std::env::temp_dir().join(format!("evostack-diagnostics-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let diagnostics = Diagnostics::open(&directory).unwrap();
        for _ in 0..3000 {
            diagnostics.record(&"bounded lifecycle entry ".repeat(12));
        }
        capture_stderr(&b"panic: sk-test-should-never-appear\nAuthorization: Bearer secret\nEvoStack database initialization failed\n"[..], &diagnostics);
        drop(diagnostics);
        for path in [
            directory.join("backend-stderr.log"),
            directory.join("backend-stderr.log.1"),
        ] {
            let contents = std::fs::read_to_string(&path).unwrap();
            assert!(contents.len() as u64 <= MAX_LOG_BYTES);
            assert!(!contents.contains("sk-test"));
            assert!(!contents.contains("Bearer secret"));
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(directory).unwrap();
    }
}
