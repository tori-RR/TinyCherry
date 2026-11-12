#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod computer_use;
mod host;
mod rpc_writer;

use host::{
    build_info, capture_stderr, request_timeout, trusted_origin, verify_backend_info, Diagnostics,
};
use rpc_writer::{PipeWriter, WriteError};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

type Reply = Result<Value, String>;
struct PendingRequest {
    sender: mpsc::Sender<Reply>,
    grant: Option<computer_use::GrantTicket>,
}
impl From<mpsc::Sender<Reply>> for PendingRequest {
    fn from(sender: mpsc::Sender<Reply>) -> Self {
        Self {
            sender,
            grant: None,
        }
    }
}
type Pending = Arc<Mutex<HashMap<u64, PendingRequest>>>;
const MAX_FRAME: usize = 4 * 1024 * 1024;

struct Backend {
    child: Arc<Mutex<Child>>,
    input: PipeWriter,
    terminate_transport: Arc<dyn Fn() + Send + Sync>,
    controls: Arc<computer_use::Controller>,
    pending: Pending,
    events: Arc<Mutex<Option<Channel<Value>>>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    diagnostics: Arc<Diagnostics>,
    data_dir: PathBuf,
}

impl Backend {
    fn start(data_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let diagnostics = Arc::new(Diagnostics::open(&data_dir)?);
        diagnostics.record("host: starting sidecar");
        let executable = std::env::current_exe()?.with_file_name("tinycherry-evostack-backend.exe");
        let mut command = Command::new(executable);
        command
            .arg("--data-dir")
            .arg(&data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().map_err(|error| {
            diagnostics.record("host: sidecar spawn failed");
            std::io::Error::other(format!(
                "EVOSTACK_BACKEND_START_FAILED: {error}; see backend-stderr.log"
            ))
        })?;
        Self::connect(child, data_dir, diagnostics)
    }

    fn connect(
        mut child: Child,
        data_dir: PathBuf,
        diagnostics: Arc<Diagnostics>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let input = PipeWriter::start(child.stdin.take().ok_or("backend stdin missing")?);
        let reverse_input = input.clone();
        let controls = Arc::new(computer_use::Controller::new(
            std::env::current_exe()?.with_file_name("open-computer-use.exe"),
        ));
        let reader_controls = controls.clone();
        let reverse_workers = Arc::new(AtomicUsize::new(0));
        let output = child.stdout.take().ok_or("backend stdout missing")?;
        let stderr = child.stderr.take().ok_or("backend stderr missing")?;
        let stderr_diagnostics = diagnostics.clone();
        std::thread::spawn(move || capture_stderr(stderr, &stderr_diagnostics));
        let child = Arc::new(Mutex::new(child));
        let reader_child = child.clone();
        let reader_diagnostics = diagnostics.clone();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let events: Arc<Mutex<Option<Channel<Value>>>> = Arc::new(Mutex::new(None));
        let event_reader = events.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let reader_alive = alive.clone();
        let shutting_down = Arc::new(AtomicBool::new(false));
        let reader_shutting_down = shutting_down.clone();
        let terminate_transport: Arc<dyn Fn() + Send + Sync> = {
            let child = child.clone();
            let alive = alive.clone();
            let pending = pending.clone();
            let writer = input.clone();
            let controls = controls.clone();
            let diagnostics = diagnostics.clone();
            Arc::new(move || {
                alive.store(false, Ordering::Release);
                writer.close();
                fail_pending(&pending);
                // This supervisor never needs the writer thread or its pipe handle.
                terminate_child(&child, &diagnostics);
                controls.shutdown();
            })
        };
        let reader_terminate = terminate_transport.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let reason = loop {
                let mut bytes = Vec::new();
                match reader
                    .by_ref()
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => break "stdout closed",
                    Err(_) => break "stdout read failed",
                    Ok(_) if bytes.len() > MAX_FRAME => break "oversized protocol frame",
                    Ok(_) => {}
                }
                let Ok(frame) = serde_json::from_slice::<Value>(&bytes) else {
                    break "invalid protocol JSON";
                };
                if frame["jsonrpc"] != "2.0" {
                    break "invalid protocol version";
                }
                if frame["method"] == "host.computer" {
                    let Some(id) = frame["id"].as_str().filter(|id| valid_reverse_id(id)) else {
                        break "invalid host request ID";
                    };
                    let id = id.to_owned();
                    let params = frame["params"].clone();
                    if reverse_workers.fetch_add(1, Ordering::AcqRel) >= 16 {
                        reverse_workers.fetch_sub(1, Ordering::AcqRel);
                        let writer = reverse_input.clone();
                        let terminate = reader_terminate.clone();
                        std::thread::spawn(move || {
                            if write_host_response(
                                &writer,
                                &id,
                                json!({"ok":false,"error":{"code":"CONTROL_BUSY","message":"Desktop host request limit reached","effect":"none"}}),
                            ).is_err() {
                                terminate();
                            }
                        });
                        continue;
                    }
                    let controls = reader_controls.clone();
                    let writer = reverse_input.clone();
                    let workers = reverse_workers.clone();
                    let terminate = reader_terminate.clone();
                    std::thread::spawn(move || {
                        let result = controls.dispatch(&params);
                        if write_host_response(&writer, &id, result).is_err() {
                            terminate();
                        }
                        workers.fetch_sub(1, Ordering::AcqRel);
                    });
                } else if frame["method"] == "host.computer.cancel" {
                    if let Some(task_id) = frame["params"]["taskId"].as_str() {
                        reader_controls.cancel_task(task_id);
                    }
                } else if let Some(id) = frame["id"].as_u64() {
                    deliver_response(&pending_reader, id, &frame, Some(&reader_controls));
                } else if frame["method"] == "event" {
                    let channel = event_reader.lock().unwrap().clone();
                    if let Some(channel) = channel {
                        let _ = channel.send(frame["params"].clone());
                    }
                }
            };
            reader_alive.store(false, Ordering::Release);
            reverse_input.close();
            fail_pending(&pending_reader);
            reader_diagnostics.record(&format!("host: sidecar transport ended ({reason})"));
            if !reader_shutting_down.load(Ordering::Acquire) {
                let channel = event_reader.lock().unwrap().clone();
                if let Some(channel) = channel {
                    let _ = channel.send(json!({"channel":"evostack:backend-exited", "args":[]}));
                }
            }
            reader_controls.shutdown();
            reap_child(&reader_child, &reader_diagnostics);
        });
        Ok(Self {
            child,
            input,
            terminate_transport,
            controls,
            pending,
            events,
            next_id: AtomicU64::new(1),
            alive,
            shutting_down,
            diagnostics,
            data_dir,
        })
    }

    fn request(&self, method: &str, params: Value) -> Reply {
        let timeout = request_timeout(method, &params);
        self.request_with_timeout(method, params, timeout)
    }

    fn request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        let deadline = Instant::now() + timeout;
        if !self.alive.load(Ordering::Acquire) {
            return Err("EVOSTACK_BACKEND_EXITED".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut bytes = serde_json::to_vec(
            &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .map_err(|e| e.to_string())?;
        if bytes.len() >= MAX_FRAME {
            return Err("EVOSTACK_REQUEST_TOO_LARGE".into());
        }
        bytes.push(b'\n');
        let (tx, rx) = mpsc::channel();
        let grant = if method == "ipc.invoke"
            && params["channel"] == "ipc-api:request"
            && params["args"][0] == "ai.stream.open"
        {
            params["args"][1]["topicId"]
                .as_str()
                .and_then(|owner| self.controls.capture_open(owner))
        } else {
            None
        };
        self.pending
            .lock()
            .unwrap()
            .insert(id, PendingRequest { sender: tx, grant });
        if !self.alive.load(Ordering::Acquire) {
            self.pending.lock().unwrap().remove(&id);
            return Err("EVOSTACK_BACKEND_EXITED".into());
        }
        let result = match self.input.send(bytes, deadline) {
            Ok(()) => wait_reply(
                &self.pending,
                id,
                rx,
                deadline.saturating_duration_since(Instant::now()),
            ),
            Err(WriteError::Busy) => Err("EVOSTACK_BUSY: request was not queued".into()),
            Err(error) => {
                (self.terminate_transport)();
                Err(if error == WriteError::Timeout {
                    "EVOSTACK_REQUEST_TIMEOUT: outcome unknown; no retry"
                } else {
                    "EVOSTACK_BACKEND_PIPE_CLOSED: outcome unknown; no retry"
                }
                .into())
            }
        };
        self.pending.lock().unwrap().remove(&id);
        result
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        self.diagnostics.record("host: shutdown requested");
        self.controls.shutdown();
        let _ = self.request("backend.shutdown", Value::Null);
        reap_child(&self.child, &self.diagnostics);
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn reap_child(child: &Mutex<Child>, diagnostics: &Diagnostics) {
    for _ in 0..50 {
        let status = child.lock().unwrap().try_wait();
        match status {
            Ok(Some(status)) => {
                diagnostics.record(&format!("host: sidecar exit {status}"));
                return;
            }
            Err(_) => {
                diagnostics.record("host: failed to read sidecar exit status");
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    diagnostics.record("host: sidecar did not exit within grace period; terminating");
    terminate_child(child, diagnostics);
}

fn terminate_child(child: &Mutex<Child>, diagnostics: &Diagnostics) {
    {
        let mut child = child.lock().unwrap();
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.kill();
    }
    for _ in 0..50 {
        if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
            diagnostics.record(&format!("host: sidecar exit {status}"));
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    diagnostics.record("host: sidecar termination could not be confirmed");
}

fn valid_reverse_id(id: &str) -> bool {
    id.strip_prefix("host:")
        .is_some_and(|v| !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit()))
}
fn write_host_response(writer: &PipeWriter, id: &str, result: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"result":result}))
        .map_err(|_| "Invalid host result")?;
    if bytes.len() >= MAX_FRAME {
        return Err("Desktop host result exceeded the IPC budget".into());
    }
    bytes.push(b'\n');
    writer
        .send(bytes, Instant::now() + Duration::from_secs(5))
        .map_err(|_| "Backend pipe closed".into())
}

fn deliver_response(
    pending: &Pending,
    id: u64,
    frame: &Value,
    controls: Option<&Arc<computer_use::Controller>>,
) {
    let reply = pending.lock().unwrap().remove(&id);
    if let Some(reply) = reply {
        let value = if frame.get("error").is_some() {
            Err(frame["error"]["message"]
                .as_str()
                .unwrap_or("Backend request failed")
                .to_owned())
        } else {
            Ok(frame["result"].clone())
        };
        let task = frame["computerTaskId"].as_str();
        if frame["result"]["ok"] == true && frame["result"]["data"]["mode"] == "started" {
            if let (Some(controller), Some(ticket), Some(task)) = (controls, reply.grant, task) {
                controller.grant_task(ticket, task);
            }
        }
        if reply.sender.send(value).is_err() {
            if let (Some(controller), Some(task)) = (controls, task) {
                controller.cancel_task(task);
            }
        }
    }
}

fn wait_reply(
    pending: &Pending,
    id: u64,
    receiver: mpsc::Receiver<Reply>,
    timeout: Duration,
) -> Reply {
    let result = match receiver.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("EVOSTACK_REQUEST_TIMEOUT: outcome unknown; no retry".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("EVOSTACK_BACKEND_PIPE_CLOSED".into()),
    };
    pending.lock().unwrap().remove(&id);
    result
}

fn fail_pending(pending: &Pending) {
    for (_, reply) in pending.lock().unwrap().drain() {
        let _ = reply.sender.send(Err(
            "EVOSTACK_BACKEND_EXITED: requests are never replayed".into()
        ));
    }
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() != "main" || !trusted_origin(&url) {
        return Err("EVOSTACK_FORBIDDEN_WINDOW".into());
    }
    Ok(())
}

#[tauri::command]
fn subscribe(
    window: WebviewWindow,
    backend: State<'_, Arc<Backend>>,
    events: Channel<Value>,
) -> Result<(), String> {
    trusted(&window)?;
    *backend.events.lock().unwrap() = Some(events);
    if !backend.alive.load(Ordering::Acquire) {
        let channel = backend.events.lock().unwrap().clone();
        if let Some(channel) = channel {
            let _ = channel.send(json!({"channel":"evostack:backend-exited", "args":[]}));
        }
    }
    Ok(())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    trusted(&window)?;
    window.start_dragging().map_err(|e| e.to_string())
}

fn desktop_request(
    window: &WebviewWindow,
    route: &str,
    input: &Value,
    backend: &Backend,
) -> Option<Reply> {
    if let Some(result) = backend.controls.request(route, input) {
        return Some(result);
    }
    let operation: Reply = match route {
        "skill.folder.open" => (|| {
            let resolved = backend.request(
                "ipc.invoke",
                json!({"channel":"ipc-api:request","args":["skill.folder.resolve",input]}),
            )?;
            if resolved["ok"] != true {
                return Err("EVOSTACK_SKILL_FOLDER_UNAVAILABLE".into());
            }
            let root = resolved["data"]["rootPath"]
                .as_str()
                .ok_or("EVOSTACK_SKILL_FOLDER_UNAVAILABLE")?;
            let path = std::path::Path::new(root);
            if !path.is_absolute() || !path.is_dir() {
                return Err("EVOSTACK_SKILL_FOLDER_UNAVAILABLE".into());
            }
            Command::new("explorer.exe")
                .arg(path)
                .spawn()
                .map(|_| Value::Null)
                .map_err(|_| "EVOSTACK_SKILL_FOLDER_OPEN_FAILED".into())
        })(),
        "window.get_init_data" => Ok(Value::Null),
        "window.is_maximized" => window
            .is_maximized()
            .map(Value::Bool)
            .map_err(|e| e.to_string()),
        "window.is_full_screen" => window
            .is_fullscreen()
            .map(Value::Bool)
            .map_err(|e| e.to_string()),
        "window.close" => window
            .close()
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.minimize" => window
            .minimize()
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.maximize" => window
            .maximize()
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.unmaximize" => window
            .unmaximize()
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.set_full_screen" => window
            .set_fullscreen(input.as_bool().unwrap_or(false))
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.main.reset_minimum_size" => window
            .set_min_size(Some(tauri::LogicalSize::new(900.0, 600.0)))
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.main.set_minimum_size" => window
            .set_min_size(Some(tauri::LogicalSize::new(
                input["width"].as_f64().unwrap_or(900.0),
                input["height"].as_f64().unwrap_or(600.0),
            )))
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "window.main.reload" => window
            .reload()
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "system.get_native_theme" => {
            Ok(json!(if window.theme().ok() == Some(tauri::Theme::Dark) {
                "dark"
            } else {
                "light"
            }))
        }
        "system.get_device_type" => Ok(json!("desktop")),
        "system.toggle_dev_tools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
            Ok(Value::Null)
        }
        "system.shell.open_external_website" | "system.shell.open_website" => {
            let raw = input
                .as_str()
                .or_else(|| input["url"].as_str())
                .unwrap_or("");
            match url::Url::parse(raw) {
                Ok(url)
                    if matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none() =>
                {
                    Command::new("rundll32.exe")
                        .args(["url.dll,FileProtocolHandler", url.as_str()])
                        .spawn()
                        .map(|_| Value::Null)
                        .map_err(|e| e.to_string())
                }
                _ => Err("EVOSTACK_UNSAFE_EXTERNAL_URL".into()),
            }
        }
        "app.get_info" => Ok(json!({
            "version":build_info()["version"], "platform":"win32", "arch":"x64", "isPackaged":true,
            "appPath":std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.to_path_buf())),
            "resourcesPath": backend.data_dir, "userDataPath": backend.data_dir, "logsPath": backend.data_dir,
            "homePath": backend.data_dir, "notesPath": backend.data_dir, "configPath": backend.data_dir,
            "appDataPath": backend.data_dir, "isPortable":true, "canCheckForUpdates":false,
            "installPath":std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.to_path_buf()))
        })),
        _ => return None,
    };
    Some(operation)
}

fn desktop_response(result: Reply) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"data":value}),
        Err(message) => json!({"ok":false,"error":{"code":"INTERNAL","message":message}}),
    }
}

#[tauri::command]
async fn ipc_request(
    window: WebviewWindow,
    backend: State<'_, Arc<Backend>>,
    channel: String,
    args: Vec<Value>,
) -> Reply {
    trusted(&window)?;
    // Existing user controls bypass the backend queue before its authoritative preference update.
    if channel == "preference:set"
        && args.first().and_then(Value::as_str) == Some("app.computer_use.agent_control.enabled")
    {
        if let Some(enabled) = args.get(1).and_then(Value::as_bool) {
            backend.controls.user_enabled(enabled);
        }
    } else if channel == "preference:set-multiple" {
        if let Some(enabled) = args
            .first()
            .and_then(|v| v["app.computer_use.agent_control.enabled"].as_bool())
        {
            backend.controls.user_enabled(enabled);
        }
    } else if channel == "ipc-api:request"
        && args.first().and_then(Value::as_str) == Some("ai.stream.abort")
    {
        if let Some(owner) = args.get(1).and_then(|v| v["topicId"].as_str()) {
            backend.controls.stop_owner(owner);
        }
    }
    if channel == "ipc-api:request" {
        let route = args
            .first()
            .and_then(Value::as_str)
            .ok_or("Missing route")?;
        if matches!(
            route,
            "computer_use.get_permission_status"
                | "computer_use.request_permissions"
                | "skill.folder.open"
        ) {
            let window = window.clone();
            let backend = backend.inner().clone();
            let route = route.to_owned();
            let input = args.get(1).cloned().unwrap_or(Value::Null);
            let result = tauri::async_runtime::spawn_blocking(move || {
                desktop_request(&window, &route, &input, &backend)
            })
            .await
            .map_err(|_| "EVOSTACK_DESKTOP_REQUEST_FAILED")?
            .ok_or("EVOSTACK_DESKTOP_ROUTE_MISSING")?;
            return Ok(desktop_response(result));
        }
        if let Some(result) = desktop_request(
            &window,
            route,
            args.get(1).unwrap_or(&Value::Null),
            &backend,
        ) {
            return Ok(desktop_response(result));
        }
    }
    if channel == "evostack:zoom" {
        window
            .set_zoom(
                args.first()
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0)
                    .clamp(0.5, 2.0),
            )
            .map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    if channel == "evostack:renderer-ready" {
        let phase = args
            .first()
            .and_then(Value::as_str)
            .ok_or("Missing renderer phase")?;
        if !matches!(phase, "onboarding" | "workspace") {
            return Err("EVOSTACK_INVALID_RENDERER_PHASE".into());
        }
        backend.diagnostics.record("host: React renderer ready");
        // Only the isolated package verifier requests an on-disk handshake.
        if let Ok(token) = std::env::var("TINYCHERRY_EVOSTACK_SMOKE_TOKEN") {
            std::fs::write(
                backend.data_dir.join("renderer-ready.json"),
                serde_json::to_vec(&json!({"token":token,"pid":std::process::id(),"phase":phase,"build":build_info()}))
                    .map_err(|_| "EVOSTACK_RENDERER_HANDSHAKE_FAILED")?,
            ).map_err(|_| "EVOSTACK_RENDERER_HANDSHAKE_FAILED")?;
        }
        return Ok(Value::Null);
    }
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend.request("ipc.invoke", json!({"channel":channel,"args":args}))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    if std::env::args_os().any(|argument| argument == "--evostack-build-info") {
        println!("{}", build_info());
        return;
    }
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc_request,
            subscribe,
            start_dragging
        ])
        .setup(|app| {
            let data_dir = match std::env::var_os("TINYCHERRY_EVOSTACK_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => std::env::current_exe()?
                    .parent()
                    .ok_or("Executable parent missing")?
                    .join("evostack-data"),
            };
            if !data_dir.is_absolute() {
                return Err("EvoStack data directory must be absolute".into());
            }
            std::fs::create_dir_all(&data_dir)?;
            let backend = Arc::new(Backend::start(data_dir.clone())?);
            let info = backend
                .request("backend.info", Value::Null)
                .map_err(std::io::Error::other)?;
            verify_backend_info(&info).map_err(std::io::Error::other)?;
            app.manage(backend);
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("windows/evostack/index.html".into()),
            )
            .title("TinyCherry EvoStack")
            .inner_size(1280.0, 850.0)
            .min_inner_size(900.0, 600.0)
            .decorations(false)
            .data_directory(data_dir.join("webview"))
            .on_navigation(trusted_origin)
            .build()?;
            let backend = app.state::<Arc<Backend>>().inner().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::ThemeChanged(theme) = event {
                    let channel = backend.events.lock().unwrap().clone();
                    if let Some(channel) = channel {
                        let _ = channel.send(json!({
                            "channel":"ipc-api:event",
                            "args":["system.native_theme_updated", if *theme == tauri::Theme::Dark {"dark"} else {"light"}]
                        }));
                    }
                }
            });
            if std::env::var_os("TINYCHERRY_EVOSTACK_DEVTOOLS").is_some() {
                window.open_devtools();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to start TinyCherry EvoStack");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<Arc<Backend>>().shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn unread_sidecar() -> Backend {
        use std::os::windows::process::CommandExt;
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let child = Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let directory = std::env::temp_dir().join(format!(
            "evostack-unread-pipe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let diagnostics = Arc::new(Diagnostics::open(&directory).unwrap());
        Backend::connect(child, directory, diagnostics).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn unread_sidecar_pipe_has_a_total_deadline_and_independent_shutdown() {
        let backend = unread_sidecar();
        let params = json!({"channel":"fixture", "args":["x".repeat(MAX_FRAME - 1024)]});
        let frame = json!({"jsonrpc":"2.0", "id":1, "method":"ipc.invoke", "params":params});
        assert!(serde_json::to_vec(&frame).unwrap().len() < MAX_FRAME);
        let start = Instant::now();
        let error = backend
            .request_with_timeout("ipc.invoke", params, Duration::from_millis(300))
            .unwrap_err();
        assert!(error.contains("TIMEOUT"));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(backend.child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(!backend.alive.load(Ordering::Acquire));
        assert!(backend.pending.lock().unwrap().is_empty());
        let shutdown = Instant::now();
        backend.shutdown();
        assert!(shutdown.elapsed() < Duration::from_secs(1));
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_terminates_a_sidecar_while_an_ordinary_request_is_blocked_writing() {
        let backend = Arc::new(unread_sidecar());
        let requesting = backend.clone();
        let request = std::thread::spawn(move || {
            requesting.request(
                "ipc.invoke",
                json!({"channel":"fixture", "args":["x".repeat(MAX_FRAME - 1024)]}),
            )
        });
        let waiting = Instant::now() + Duration::from_secs(2);
        while backend.input.queued_bytes() < MAX_FRAME - 1024 && Instant::now() < waiting {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(backend.input.queued_bytes() >= MAX_FRAME - 1024);
        let shutdown = Instant::now();
        backend.shutdown();
        assert!(shutdown.elapsed() < Duration::from_secs(4));
        assert!(request.join().unwrap().is_err());
        assert!(backend.child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(backend.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn late_response_after_timeout_cannot_complete_another_request() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (first_tx, first_rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, first_tx.into());
        assert!(wait_reply(&pending, 1, first_rx, Duration::from_millis(1))
            .unwrap_err()
            .contains("TIMEOUT"));
        let (second_tx, second_rx) = mpsc::channel();
        pending.lock().unwrap().insert(2, second_tx.into());
        deliver_response(&pending, 1, &json!({"result":"late"}), None);
        assert!(second_rx.try_recv().is_err());
        deliver_response(&pending, 2, &json!({"result":"current"}), None);
        assert_eq!(
            wait_reply(&pending, 2, second_rx, Duration::from_millis(10)).unwrap(),
            json!("current")
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn unexpected_exit_fails_every_waiter_without_replaying() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, first_tx.into());
        pending.lock().unwrap().insert(2, second_tx.into());
        fail_pending(&pending);
        for receiver in [first_rx, second_rx] {
            assert!(receiver
                .recv()
                .unwrap()
                .unwrap_err()
                .contains("never replayed"));
        }
        assert!(pending.lock().unwrap().is_empty());
    }
    #[test]
    fn reverse_requests_use_only_their_dedicated_string_id_space() {
        for id in ["host:1", "host:1234567890"] {
            assert!(valid_reverse_id(id));
        }
        for id in ["1", "host:", "host:-1", "permission:1", "host:1x"] {
            assert!(!valid_reverse_id(id));
        }
    }
    #[test]
    fn successful_open_sideband_grants_before_reply_without_changing_the_public_ack() {
        let controls = Arc::new(computer_use::Controller::new(PathBuf::from(
            "missing-test-desktop-helper.exe",
        )));
        let owner = "00000000-0000-0000-0000-000000000011";
        let task = "00000000-0000-0000-0000-000000000012";
        let ticket = controls.capture_open(owner).unwrap();
        assert_eq!(
            controls.dispatch(&json!({"operation":"configure","epoch":1,"enabled":true}))["ok"],
            true
        );
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(
            1,
            PendingRequest {
                sender: tx,
                grant: Some(ticket),
            },
        );
        let public = json!({"ok":true,"data":{"mode":"started","activeExecutions":[],"reservedMessages":[]}});
        deliver_response(
            &pending,
            1,
            &json!({"jsonrpc":"2.0","id":1,"result":public,"computerTaskId":task}),
            Some(&controls),
        );
        assert_eq!(rx.recv().unwrap().unwrap(), public);
        let invoke=controls.dispatch(&json!({"operation":"invoke","epoch":1,"taskId":task,"ownerId":owner,"tool":"list_apps","input":{}}));
        // The private grant was accepted; the intentionally absent fixture binary prevents any IO.
        assert_eq!(invoke["error"]["code"], "RUNTIME_NOT_FOUND");
        controls.shutdown();
    }
    #[test]
    fn stop_or_rpc_timeout_rejects_a_late_private_open_grant() {
        let controls = Arc::new(computer_use::Controller::new(PathBuf::from(
            "missing-test-desktop-helper.exe",
        )));
        let owner = "00000000-0000-0000-0000-000000000021";
        let task = "00000000-0000-0000-0000-000000000022";
        controls.dispatch(&json!({"operation":"configure","epoch":1,"enabled":true}));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let frame = json!({"jsonrpc":"2.0","id":1,"result":{"ok":true,"data":{"mode":"started"}},"computerTaskId":task});
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(
            1,
            PendingRequest {
                sender: tx,
                grant: controls.capture_open(owner),
            },
        );
        controls.stop_owner(owner);
        deliver_response(&pending, 1, &frame, Some(&controls));
        rx.recv().unwrap().unwrap();
        let request = json!({"operation":"invoke","epoch":1,"taskId":task,"ownerId":owner,"tool":"list_apps","input":{}});
        assert_eq!(controls.dispatch(&request)["error"]["code"], "TASK_CLOSED");
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(
            1,
            PendingRequest {
                sender: tx,
                grant: controls.capture_open(owner),
            },
        );
        assert!(wait_reply(&pending, 1, rx, Duration::from_millis(1)).is_err());
        deliver_response(&pending, 1, &frame, Some(&controls));
        assert_eq!(controls.dispatch(&request)["error"]["code"], "TASK_CLOSED");
        controls.shutdown();
    }
}
