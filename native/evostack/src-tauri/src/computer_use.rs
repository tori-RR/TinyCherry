use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_NATIVE_FRAME: usize = 16 * 1024 * 1024;
const RESULT_BUDGET: usize = 3 * 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
type ControlResult = Result<Value, ControlError>;

#[derive(Clone, Debug)]
struct ControlError {
    code: String,
    message: String,
    effect: String,
    unconfirmed: bool,
}
impl ControlError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect: "none".into(),
            unconfirmed: false,
        }
    }
    fn uncertain(code: &str, message: &str, effect: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect: effect.into(),
            unconfirmed: true,
        }
    }
    fn envelope(&self) -> Value {
        let mut error = json!({"code":self.code,"message":self.message,"effect":self.effect});
        if self.unconfirmed {
            error["cleanup"] = json!("unconfirmed");
        }
        json!({"ok":false,"error":error})
    }
}
fn invalid() -> ControlError {
    ControlError::new("INVALID_INPUT", "Invalid desktop control request")
}
fn closed() -> ControlError {
    ControlError::new(
        "TASK_CLOSED",
        "This desktop task has ended; its references cannot be reused",
    )
}
fn background_key_unavailable() -> ControlError {
    ControlError::new(
        "BACKGROUND_UNAVAILABLE",
        "The current Windows helper cannot reliably route background key presses to application controls",
    )
}
fn host_capabilities(mut capabilities: Value) -> Value {
    if let Some(items) = capabilities["capabilities"].as_array_mut() {
        for capability in items {
            if capability["name"] == "pressKey" {
                let error = background_key_unavailable();
                capability["availability"] = json!({"status":"unsupported","reason":{"code":"UNSUPPORTED_CAPABILITY","message":error.message}});
            }
        }
    }
    capabilities
}
fn string(value: &Value, name: &str) -> Result<String, ControlError> {
    value[name]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
}
fn object_fields(value: &Value, fields: &[&str]) -> Result<(), ControlError> {
    if value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| fields.contains(&k.as_str())))
    {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn session_id() -> String {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed) as u128;
    let value = format!("{:032x}", time ^ ((std::process::id() as u128) << 64) ^ seq);
    format!(
        "{}-{}-{}-{}-{}",
        &value[..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..]
    )
}

trait Runtime: Send + Sync {
    fn initialize(&self) -> ControlResult;
    fn call(&self, method: &str, input: Value, effect: &str) -> ControlResult;
    fn revoke(&self);
    fn cancel(&self);
    fn close(&self) -> Result<(), ControlError>;
}
type NativePending = Arc<Mutex<HashMap<String, mpsc::Sender<ControlResult>>>>;

struct NativeClient {
    child: Mutex<Child>,
    #[cfg(windows)]
    _job: process_ownership::Job,
    input: Mutex<ChildStdin>,
    pending: NativePending,
    alive: Arc<AtomicBool>,
    closing: AtomicBool,
    cleanup: Mutex<Option<Result<(), ControlError>>>,
    close_lock: Mutex<()>,
    next: AtomicU64,
    session: String,
}
impl NativeClient {
    fn start(runtime: &Path) -> Result<Self, ControlError> {
        if !runtime.is_file() {
            return Err(ControlError::new(
                "RUNTIME_NOT_FOUND",
                "The packaged desktop helper is missing",
            ));
        }
        let session = session_id();
        let mut command = Command::new(runtime);
        command
            .args(["serve", "--stdio", "--session-id", &session])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            ControlError::new(
                "RUNTIME_START_FAILED",
                "Could not start the packaged desktop helper",
            )
        })?;
        #[cfg(windows)]
        let job = match process_ownership::Job::assign(&child) {
            Ok(job) => job,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ControlError::new(
                    "RUNTIME_START_FAILED",
                    "Could not own the desktop helper process tree",
                ));
            }
        };
        let input = child.stdin.take().ok_or_else(|| {
            ControlError::new("PROTOCOL_ERROR", "Desktop helper stdin is missing")
        })?;
        let mut output = child.stdout.take().ok_or_else(|| {
            ControlError::new("PROTOCOL_ERROR", "Desktop helper stdout is missing")
        })?;
        let pending: NativePending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let reader_alive = alive.clone();
        std::thread::spawn(move || {
            while let Ok(frame) = read_frame(&mut output) {
                if frame["jsonrpc"] != "2.0" {
                    break;
                }
                if frame.get("method").is_some() {
                    continue;
                }
                let Some(id) = frame["id"].as_str() else {
                    break;
                };
                let response = native_response(&frame);
                if let Some(sender) = reader_pending.lock().unwrap().remove(id) {
                    let _ = sender.send(response);
                }
            }
            reader_alive.store(false, Ordering::Release);
            for (_, sender) in reader_pending.lock().unwrap().drain() {
                let _ = sender.send(Err(ControlError::uncertain(
                    "RUNTIME_EXITED",
                    "Desktop helper disconnected; do not replay",
                    "possible",
                )));
            }
        });
        Ok(Self {
            child: Mutex::new(child),
            #[cfg(windows)]
            _job: job,
            input: Mutex::new(input),
            pending,
            alive,
            closing: AtomicBool::new(false),
            cleanup: Mutex::new(None),
            close_lock: Mutex::new(()),
            next: AtomicU64::new(1),
            session,
        })
    }
    fn send(&self, frame: Value) -> Result<(), ControlError> {
        let bytes = serde_json::to_vec(&frame).map_err(|_| invalid())?;
        if bytes.len() > RESULT_BUDGET {
            return Err(invalid());
        }
        let mut input = self.input.lock().unwrap();
        if self.closing.load(Ordering::Acquire)
            && frame["method"] != "shutdown"
            && frame["method"] != "$/cancelRequest"
        {
            return Err(closed());
        }
        write!(input, "Content-Length: {}\r\n\r\n", bytes.len())
            .and_then(|_| input.write_all(&bytes))
            .and_then(|_| input.flush())
            .map_err(|_| {
                ControlError::uncertain(
                    "RUNTIME_EXITED",
                    "Desktop helper pipe closed; do not replay",
                    "possible",
                )
            })
    }
    fn send_bounded(
        &self,
        frame: Value,
        effect: &str,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        let (sent, completion) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _ = sent.send(self.send(frame));
            });
            match completion.recv_timeout(timeout) {
                Ok(result) => result,
                Err(_) => {
                    self.revoke();
                    self.kill();
                    Err(ControlError::uncertain(
                        "TIMEOUT",
                        "Desktop pipe write timed out; do not replay",
                        effect,
                    ))
                }
            }
        })
    }
    fn call_timeout(
        &self,
        method: &str,
        input: Value,
        effect: &str,
        timeout: Duration,
    ) -> ControlResult {
        if !self.alive.load(Ordering::Acquire)
            || (self.closing.load(Ordering::Acquire) && method != "shutdown")
        {
            return Err(closed());
        }
        let id = format!("native:{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), sender);
        let deadline = Instant::now() + timeout;
        if let Err(error) = self.send_bounded(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":input}),
            effect,
            timeout,
        ) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let response =
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(value) => value,
                Err(mpsc::RecvTimeoutError::Timeout) if method == "shutdown" => {
                    Err(ControlError::uncertain(
                        "CLEANUP_UNCONFIRMED",
                        "Desktop shutdown did not acknowledge cleanup",
                        effect,
                    ))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let grace = Instant::now() + Duration::from_secs(2);
                    let cancellation = self.send_bounded(
                        json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}),
                        effect,
                        Duration::from_secs(2),
                    );
                    // A completed action can win cancellation; input is never replayed.
                    receiver
                        .recv_timeout(grace.saturating_duration_since(Instant::now()))
                        .unwrap_or_else(|_| {
                            Err(cancellation.err().unwrap_or_else(|| {
                                ControlError::uncertain(
                                    "TIMEOUT",
                                    "Desktop cancellation was not confirmed; do not replay",
                                    effect,
                                )
                            }))
                        })
                }
                Err(_) => Err(ControlError::uncertain(
                    "RUNTIME_EXITED",
                    "Desktop helper disconnected; do not replay",
                    effect,
                )),
            };
        self.pending.lock().unwrap().remove(&id);
        response
    }
    fn kill(&self) {
        let mut child = self.child.lock().unwrap();
        if !matches!(child.try_wait(), Ok(Some(_))) {
            #[cfg(windows)]
            self._job.terminate();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Runtime for NativeClient {
    fn initialize(&self) -> ControlResult {
        let info = self.call_timeout(
            "initialize",
            json!({"protocolVersion":2,"sessionId":self.session}),
            "none",
            Duration::from_secs(5),
        )?;
        if info["protocolVersion"] != 2
            || info["sessionId"] != self.session
            || info["ownership"] != "private"
        {
            return Err(ControlError::new(
                "PROTOCOL_MISMATCH",
                "Desktop helper private session handshake failed",
            ));
        }
        Ok(info)
    }
    fn call(&self, method: &str, input: Value, effect: &str) -> ControlResult {
        let timeout = if matches!(method, "getCapabilities" | "getPermissionStatus") {
            Duration::from_secs(5)
        } else {
            CALL_TIMEOUT
        };
        self.call_timeout(method, input, effect, timeout)
    }
    fn revoke(&self) {
        self.closing.store(true, Ordering::Release);
    }
    fn cancel(&self) {
        self.revoke();
        let requests: Vec<_> = self.pending.lock().unwrap().keys().cloned().collect();
        for id in requests {
            let _ =
                self.send(json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}));
        }
    }
    fn close(&self) -> Result<(), ControlError> {
        let _close = self.close_lock.lock().unwrap();
        if let Some(result) = self.cleanup.lock().unwrap().as_ref() {
            return result.clone();
        }
        self.closing.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_millis(3500);
        let (completion, completed) = mpsc::channel();
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                let result = (|| {
                    self.cancel();
                    let cancellation_deadline = Instant::now() + Duration::from_secs(2);
                    while !self.pending.lock().unwrap().is_empty()
                        && Instant::now() < cancellation_deadline
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    if !self.pending.lock().unwrap().is_empty() {
                        return Err(ControlError::uncertain(
                            "CLEANUP_UNCONFIRMED",
                            "Desktop cancellation cleanup could not be confirmed",
                            "possible",
                        ));
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(closed());
                    }
                    let reply = self.call_timeout(
                        "shutdown",
                        json!({"sessionId":self.session}),
                        "none",
                        remaining.min(Duration::from_secs(1)),
                    )?;
                    if reply["sessionId"] != self.session || reply["cleanup"] != "complete" {
                        return Err(ControlError::uncertain(
                            "CLEANUP_UNCONFIRMED",
                            "Desktop shutdown cleanup could not be confirmed",
                            "possible",
                        ));
                    }
                    loop {
                        match self.child.lock().unwrap().try_wait() {
                            Ok(Some(status)) if status.success() => return Ok(()),
                            Ok(Some(_)) | Err(_) => {
                                return Err(ControlError::uncertain(
                                    "CLEANUP_UNCONFIRMED",
                                    "Desktop helper did not exit cleanly",
                                    "possible",
                                ))
                            }
                            Ok(None) if Instant::now() < deadline => {
                                std::thread::sleep(Duration::from_millis(5))
                            }
                            Ok(None) => {
                                return Err(ControlError::uncertain(
                                    "CLEANUP_UNCONFIRMED",
                                    "Desktop helper exit was not confirmed",
                                    "possible",
                                ))
                            }
                        }
                    }
                })();
                let _ = completion.send(result);
            });
            match completed.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(result) => result,
                Err(_) => {
                    self.kill();
                    Err(ControlError::uncertain(
                        "CLEANUP_UNCONFIRMED",
                        "Desktop cleanup timed out; control remains blocked",
                        "possible",
                    ))
                }
            }
        });
        let result = result.map_err(|_| {
            ControlError::uncertain(
                "CLEANUP_UNCONFIRMED",
                "Desktop cleanup is unconfirmed; control remains blocked",
                "possible",
            )
        });
        if result.is_err() {
            self.kill();
        }
        *self.cleanup.lock().unwrap() = Some(result.clone());
        result
    }
}
impl Drop for NativeClient {
    fn drop(&mut self) {
        self.kill();
    }
}
fn native_response(frame: &Value) -> ControlResult {
    if let Some(error) = frame.get("error") {
        let data = &error["data"];
        let effect = data["effect"]
            .as_str()
            .filter(|v| ["none", "possible", "applied"].contains(v))
            .unwrap_or("possible");
        let code = data["code"].as_str().unwrap_or("PROTOCOL_ERROR");
        return Err(ControlError {
            code: code.into(),
            message: error["message"]
                .as_str()
                .unwrap_or("Desktop helper request failed")
                .chars()
                .take(1024)
                .collect(),
            effect: effect.into(),
            unconfirmed: code == "CLEANUP_FAILED",
        });
    }
    frame.get("result").cloned().ok_or_else(|| {
        ControlError::uncertain(
            "PROTOCOL_ERROR",
            "Desktop helper response has no result",
            "possible",
        )
    })
}

#[derive(Clone)]
struct SnapshotPermit {
    id: String,
    elements: HashMap<String, HashSet<String>>,
    image: Option<(f64, f64)>,
}
struct Task {
    owner: String,
    epoch: u64,
    cancelled: AtomicBool,
    initialized: AtomicBool,
    operation: Mutex<()>,
    runtime: Mutex<Option<Arc<dyn Runtime>>>,
    known_apps: Mutex<HashMap<String, Value>>,
    sessions: Mutex<HashMap<String, String>>,
    snapshots: Mutex<HashMap<String, SnapshotPermit>>,
}
impl Task {
    fn new(owner: String, epoch: u64) -> Self {
        Self {
            owner,
            epoch,
            cancelled: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            operation: Mutex::new(()),
            runtime: Mutex::new(None),
            known_apps: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(HashMap::new()),
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(slot) = self.runtime.try_lock() {
            if let Some(runtime) = slot.as_ref() {
                runtime.revoke();
            }
        }
    }
}
#[derive(Clone)]
pub struct GrantTicket {
    owner: String,
    owner_version: u64,
    global_version: u64,
}
#[derive(Default)]
struct ControlState {
    epoch: u64,
    desired: bool,
    enabled: bool,
    ui_stopped: bool,
    shutdown: bool,
    cleanup_blocked: bool,
    tasks: HashMap<String, Arc<Task>>,
    app_owners: HashMap<String, String>,
    closed_tasks: HashSet<String>,
    grants: HashMap<String, GrantTicket>,
    owner_versions: HashMap<String, u64>,
    global_version: u64,
    last_revoke_epoch: Option<u64>,
}
type RuntimeFactory = Arc<dyn Fn() -> Result<Arc<dyn Runtime>, ControlError> + Send + Sync>;
pub struct Controller {
    state: Mutex<ControlState>,
    configuration: Mutex<()>,
    factory: RuntimeFactory,
}
impl Controller {
    pub fn new(path: PathBuf) -> Self {
        Self::with_factory(Arc::new(move || {
            Ok(Arc::new(NativeClient::start(&path)?) as Arc<dyn Runtime>)
        }))
    }
    fn with_factory(factory: RuntimeFactory) -> Self {
        Self {
            state: Mutex::new(ControlState::default()),
            configuration: Mutex::new(()),
            factory,
        }
    }
    pub fn capture_open(&self, owner: &str) -> Option<GrantTicket> {
        if !uuid(owner) {
            return None;
        }
        let state = self.state.lock().unwrap();
        if state.shutdown || state.ui_stopped || state.cleanup_blocked {
            return None;
        }
        Some(GrantTicket {
            owner: owner.into(),
            owner_version: *state.owner_versions.get(owner).unwrap_or(&0),
            global_version: state.global_version,
        })
    }
    pub fn grant_task(&self, ticket: GrantTicket, task_id: &str) -> bool {
        if !uuid(task_id) {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if state.shutdown
            || state.ui_stopped
            || state.cleanup_blocked
            || state.closed_tasks.contains(task_id)
            || ticket.global_version != state.global_version
            || ticket.owner_version != *state.owner_versions.get(&ticket.owner).unwrap_or(&0)
        {
            return false;
        }
        state.grants.insert(task_id.into(), ticket);
        true
    }
    pub fn dispatch(&self, input: &Value) -> Value {
        let result = match input["operation"].as_str() {
            Some("configure") => self.configure(input),
            Some("invoke") => self.invoke(input),
            Some("close_task") => string(input, "taskId").and_then(|id| {
                if !uuid(&id) {
                    return Err(invalid());
                }
                self.close_task(&id).map(|_| json!({"cleanup":"complete"}))
            }),
            _ => Err(invalid()),
        };
        match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(error) => error.envelope(),
        }
    }
    fn configure(&self, input: &Value) -> ControlResult {
        object_fields(input, &["operation", "epoch", "enabled"])?;
        let epoch = input["epoch"].as_u64().ok_or_else(invalid)?;
        let enabled = input["enabled"].as_bool().ok_or_else(invalid)?;
        {
            let mut state = self.state.lock().unwrap();
            if state.shutdown {
                return Err(closed());
            }
            if epoch < state.epoch || (epoch == state.epoch && state.desired != enabled) {
                return Err(ControlError::new(
                    "STALE_CONTROL_EPOCH",
                    "Desktop authorization changed",
                ));
            }
            if epoch > state.epoch {
                state.epoch = epoch;
                state.desired = enabled;
                state.enabled = false;
                state.closed_tasks.clear();
            }
            if !enabled && state.last_revoke_epoch != Some(epoch) {
                state.last_revoke_epoch = Some(epoch);
                state.global_version = state.global_version.saturating_add(1);
                state.grants.clear();
            }
            if enabled && state.ui_stopped {
                return Err(ControlError::new(
                    "USER_STOPPED",
                    "The user stopped desktop control; only the user can enable it again",
                ));
            }
            if enabled && state.enabled && !state.cleanup_blocked {
                return Ok(json!({"cleanup":"complete"}));
            }
        }
        let _configuration = self.configuration.lock().unwrap();
        let tasks: Vec<_> = {
            let state = self.state.lock().unwrap();
            state
                .tasks
                .iter()
                .filter(|(_, t)| !enabled || t.epoch != epoch)
                .map(|(id, t)| (id.clone(), t.clone()))
                .collect()
        };
        for (_, task) in &tasks {
            task.cancel();
        }
        std::thread::scope(|scope| {
            for (id, _) in &tasks {
                scope.spawn(move || {
                    let _ = self.close_task(id);
                });
            }
        });
        let mut state = self.state.lock().unwrap();
        if epoch != state.epoch || enabled != state.desired {
            return Err(ControlError::new(
                "STALE_CONTROL_EPOCH",
                "Desktop authorization changed",
            ));
        }
        if state.cleanup_blocked {
            return Err(ControlError::uncertain(
                "CLEANUP_UNCONFIRMED",
                "Desktop cleanup is unconfirmed; restart the app before enabling control",
                "possible",
            ));
        }
        state.enabled = enabled && !state.ui_stopped && !state.shutdown;
        Ok(json!({"cleanup":"complete"}))
    }
    // Called before forwarding user controls to Go; it never waits for a native action lock.
    pub fn user_enabled(self: &Arc<Self>, enabled: bool) {
        let tasks = {
            let mut state = self.state.lock().unwrap();
            state.ui_stopped = !enabled;
            if !enabled {
                state.global_version = state.global_version.saturating_add(1);
                state.grants.clear();
                state.enabled = false;
                state.desired = false;
                state.tasks.keys().cloned().collect::<Vec<_>>()
            } else {
                Vec::new()
            }
        };
        for id in tasks {
            self.cancel_task(&id);
        }
    }
    pub fn stop_owner(self: &Arc<Self>, owner: &str) {
        if !uuid(owner) {
            return;
        }
        let ids = {
            let mut state = self.state.lock().unwrap();
            let version = state.owner_versions.entry(owner.into()).or_default();
            *version = version.saturating_add(1);
            let mut ids: HashSet<_> = state
                .tasks
                .iter()
                .filter(|(_, task)| task.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.extend(
                state
                    .grants
                    .iter()
                    .filter(|(_, ticket)| ticket.owner == owner)
                    .map(|(id, _)| id.clone()),
            );
            state.grants.retain(|_, ticket| ticket.owner != owner);
            ids
        };
        for id in ids {
            self.cancel_task(&id);
        }
    }
    pub fn cancel_task(self: &Arc<Self>, id: &str) {
        if !uuid(id) {
            return;
        }
        let task = {
            let mut state = self.state.lock().unwrap();
            state.grants.remove(id);
            state.tasks.get(id).cloned()
        };
        if let Some(task) = task {
            task.cancel();
            let controller = self.clone();
            let id = id.to_owned();
            std::thread::spawn(move || {
                let _ = controller.close_task(&id);
            });
        } else {
            self.state
                .lock()
                .unwrap()
                .closed_tasks
                .insert(id.to_owned());
        }
    }
    pub fn shutdown(&self) {
        let ids = {
            let mut state = self.state.lock().unwrap();
            state.shutdown = true;
            state.enabled = false;
            state.global_version = state.global_version.saturating_add(1);
            state.grants.clear();
            state.tasks.keys().cloned().collect::<Vec<_>>()
        };
        for id in &ids {
            if let Some(task) = self.state.lock().unwrap().tasks.get(id).cloned() {
                task.cancel();
            }
        }
        std::thread::scope(|scope| {
            for id in ids {
                scope.spawn(move || {
                    let _ = self.close_task(&id);
                });
            }
        });
    }
    fn close_task(&self, id: &str) -> Result<(), ControlError> {
        let task = {
            let mut state = self.state.lock().unwrap();
            state.closed_tasks.insert(id.to_owned());
            state.grants.remove(id);
            state.tasks.get(id).cloned()
        };
        let Some(task) = task else {
            return Ok(());
        };
        task.cancel();
        let runtime = task.runtime.lock().unwrap().clone();
        let result = runtime.map_or(Ok(()), |r| r.close());
        let mut state = self.state.lock().unwrap();
        if result.is_ok() {
            state.tasks.remove(id);
            state.app_owners.retain(|_, owner| owner != id);
        } else {
            state.cleanup_blocked = true;
            state.enabled = false;
        }
        result
    }
    fn task(&self, input: &Value) -> Result<(String, Arc<Task>), ControlError> {
        let id = string(input, "taskId")?;
        let owner = string(input, "ownerId")?;
        let epoch = input["epoch"].as_u64().ok_or_else(invalid)?;
        if !uuid(&id) || !uuid(&owner) {
            return Err(invalid());
        }
        let mut state = self.state.lock().unwrap();
        if state.cleanup_blocked {
            return Err(ControlError::uncertain(
                "CLEANUP_UNCONFIRMED",
                "Desktop cleanup is unconfirmed; control remains blocked",
                "possible",
            ));
        }
        if state.shutdown || !state.enabled || state.ui_stopped {
            return Err(ControlError::new(
                "CONTROL_DISABLED",
                "Desktop control is disabled or user-stopped",
            ));
        }
        if epoch != state.epoch {
            return Err(ControlError::new(
                "STALE_CONTROL_EPOCH",
                "Desktop authorization changed",
            ));
        }
        if state.grants.get(&id).is_none_or(|ticket| {
            ticket.owner != owner
                || ticket.global_version != state.global_version
                || ticket.owner_version != *state.owner_versions.get(&owner).unwrap_or(&0)
        }) {
            return Err(closed());
        }
        if state.closed_tasks.contains(&id) {
            return Err(closed());
        }
        if let Some(task) = state.tasks.get(&id) {
            if task.owner != owner || task.epoch != epoch || task.cancelled.load(Ordering::Acquire)
            {
                return Err(closed());
            }
            return Ok((id, task.clone()));
        }
        if state.tasks.len() >= 8 || state.closed_tasks.len() >= 1024 {
            return Err(ControlError::new(
                "CONTROL_LIMIT",
                "Desktop session limit reached; disable and re-enable control",
            ));
        }
        let task = Arc::new(Task::new(owner, epoch));
        state.tasks.insert(id.clone(), task.clone());
        Ok((id, task))
    }
    fn invoke(&self, input: &Value) -> ControlResult {
        object_fields(
            input,
            &[
                "operation",
                "epoch",
                "taskId",
                "ownerId",
                "label",
                "tool",
                "input",
            ],
        )?;
        let tool = string(input, "tool")?;
        if ![
            "list_apps",
            "open_app",
            "get_app_state",
            "click",
            "perform_secondary_action",
            "scroll",
            "drag",
            "type_text",
            "press_key",
            "set_value",
        ]
        .contains(&tool.as_str())
        {
            return Err(invalid());
        }
        let arguments = input
            .get("input")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or_else(invalid)?;
        if tool == "press_key" {
            return Err(background_key_unavailable());
        }
        let (id, task) = self.task(input)?;
        let _operation = task.operation.try_lock().map_err(|_| {
            ControlError::new(
                "CONTROL_BUSY",
                "A desktop operation is already in flight for this task",
            )
        })?;
        if task.cancelled.load(Ordering::Acquire) {
            return Err(closed());
        }
        let runtime = {
            let mut slot = task.runtime.lock().unwrap();
            if slot.is_none() {
                *slot = Some((self.factory)()?);
            }
            slot.as_ref().unwrap().clone()
        };
        let result = (|| {
            if task.cancelled.load(Ordering::Acquire) {
                return Err(closed());
            }
            if !task.initialized.load(Ordering::Acquire) {
                runtime.initialize()?;
                task.initialized.store(true, Ordering::Release);
            }
            self.run_tool(&id, &task, &runtime, &tool, arguments)
        })();
        if let Err(error) = &result {
            if error.unconfirmed || error.effect != "none" {
                task.cancel();
                self.close_task(&id)?;
            }
        }
        result
    }
    fn run_tool(
        &self,
        id: &str,
        task: &Task,
        runtime: &Arc<dyn Runtime>,
        tool: &str,
        input: Value,
    ) -> ControlResult {
        if task.cancelled.load(Ordering::Acquire) {
            return Err(closed());
        }
        match tool {
            "list_apps" => {
                object_fields(&input, &[])?;
                let mut apps = runtime.call("listApps", json!({}), "none")?;
                let list = apps
                    .as_array()
                    .filter(|v| v.len() <= 512)
                    .ok_or_else(invalid)?;
                let total = list.len();
                let capabilities =
                    host_capabilities(runtime.call("getCapabilities", json!({}), "none")?);
                while serde_json::to_vec(&json!({"apps":apps,"capabilities":capabilities}))
                    .map_err(|_| invalid())?
                    .len()
                    > 112 * 1024
                {
                    if apps.as_array_mut().ok_or_else(invalid)?.pop().is_none() {
                        return Err(invalid());
                    }
                }
                let list = apps.as_array().ok_or_else(invalid)?;
                let mut known = HashMap::new();
                for app in list {
                    let app_id = string(app, "id")?;
                    string(app, "name")?;
                    known.insert(app_id, app.clone());
                }
                *task.known_apps.lock().unwrap() = known;
                Ok(
                    json!({"apps":apps,"capabilities":capabilities,"truncated":apps.as_array().map_or(0,Vec::len)<total}),
                )
            }
            "open_app" => {
                object_fields(&input, &["appId"])?;
                let app_id = string(&input, "appId")?;
                let app = task
                    .known_apps
                    .lock()
                    .unwrap()
                    .get(&app_id)
                    .cloned()
                    .ok_or_else(|| {
                        ControlError::new(
                            "UNKNOWN_APP",
                            "Select an application returned by list_apps in this task",
                        )
                    })?;
                if let Some(session_id) =
                    task.sessions
                        .lock()
                        .unwrap()
                        .iter()
                        .find_map(|(session, known)| {
                            if known == &app_id {
                                Some(session.clone())
                            } else {
                                None
                            }
                        })
                {
                    return Ok(json!({"appSessionId":session_id,"app":app,"status":"active"}));
                }
                let mut keys = vec![format!(
                    "name:{}",
                    app["name"].as_str().unwrap_or("").to_lowercase()
                )];
                if let Some(identity) = app["identity"].as_str().filter(|id| !id.is_empty()) {
                    keys.push(format!("identity:{}", identity.to_lowercase()));
                }
                {
                    let mut state = self.state.lock().unwrap();
                    if keys
                        .iter()
                        .any(|key| state.app_owners.get(key).is_some_and(|owner| owner != id))
                    {
                        return Err(ControlError::new(
                            "APP_BUSY",
                            "Another desktop task owns this application",
                        ));
                    }
                    for key in &keys {
                        state.app_owners.insert(key.clone(), id.into());
                    }
                }
                let result = runtime.call("openAppSession", input, "none");
                let session = match result {
                    Ok(session) => session,
                    Err(error) => {
                        let mut state = self.state.lock().unwrap();
                        for key in &keys {
                            if state.app_owners.get(key).is_some_and(|owner| owner == id) {
                                state.app_owners.remove(key);
                            }
                        }
                        return Err(error);
                    }
                };
                if session["app"]["id"] != app_id || session["status"] != "active" {
                    return Err(ControlError::uncertain(
                        "PROTOCOL_ERROR",
                        "Desktop helper returned a different application",
                        "possible",
                    ));
                }
                let session_id = string(&session, "id")?;
                task.sessions
                    .lock()
                    .unwrap()
                    .insert(session_id.clone(), app_id);
                Ok(json!({"appSessionId":session_id,"app":session["app"],"status":"active"}))
            }
            "get_app_state" => {
                object_fields(&input, &["appSessionId"])?;
                let session = string(&input, "appSessionId")?;
                self.check_session(task, &session)?;
                task.snapshots.lock().unwrap().remove(&session);
                let state=runtime.call("getAppState",json!({"appSessionId":session,"activation":"never","includeScreenshot":true,"maxTreeNodes":200,"maxTreeDepth":24,"textLimit":16000}),"none")?;
                self.record_snapshot(task, &session, state)
            }
            _ => {
                let (session, action) = validated_action(task, tool, input)?;
                let result = runtime.call("act", action, "possible")?;
                if result["status"] != "completed" {
                    return Err(ControlError::uncertain(
                        "PROTOCOL_ERROR",
                        "Desktop helper did not confirm action completion",
                        "possible",
                    ));
                }
                if result["observation"]["status"] == "available" {
                    match self.record_snapshot(
                        task,
                        &session,
                        result["observation"]["snapshot"].clone(),
                    ) {
                        Ok(snapshot) => Ok(
                            json!({"status":"completed","observation":{"status":"available","snapshot":snapshot}}),
                        ),
                        Err(_) => Ok(
                            json!({"status":"completed","observation":{"status":"unavailable","reason":{"code":"CAPTURE_FAILED","message":"The action completed, but its observation could not be delivered. Observe again before further input."}}}),
                        ),
                    }
                } else if result["observation"]["status"] == "unavailable" {
                    Ok(result)
                } else {
                    Err(ControlError::uncertain(
                        "PROTOCOL_ERROR",
                        "Desktop helper returned an invalid observation",
                        "applied",
                    ))
                }
            }
        }
    }
    fn check_session(&self, task: &Task, id: &str) -> Result<(), ControlError> {
        if task.sessions.lock().unwrap().contains_key(id) {
            Ok(())
        } else {
            Err(ControlError::new(
                "UNKNOWN_APP_SESSION",
                "This application session does not belong to the current task",
            ))
        }
    }
    fn record_snapshot(&self, task: &Task, session: &str, mut snapshot: Value) -> ControlResult {
        if snapshot["appSessionId"] != session {
            return Err(invalid());
        }
        if task
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .is_none_or(|app_id| snapshot["app"]["id"] != *app_id)
        {
            return Err(ControlError::uncertain(
                "PROTOCOL_ERROR",
                "Desktop observation returned a different target application",
                "none",
            ));
        }
        bound_observation(&mut snapshot)?;
        let id = string(&snapshot, "id")?;
        if snapshot["screenshot"]["status"] == "available"
            && (snapshot["screenshot"]["image"]["dataBase64"]
                .as_str()
                .is_none_or(|data| data.len() > 2 * 1024 * 1024)
                || serde_json::to_vec(&snapshot).map_err(|_| invalid())?.len() > RESULT_BUDGET)
        {
            snapshot["screenshot"] = json!({"status":"unavailable","reason":{"code":"CAPTURE_FAILED","message":"Screenshot exceeds the desktop IPC budget; accessibility state remains available"}});
        }
        if serde_json::to_vec(&snapshot).map_err(|_| invalid())?.len() > RESULT_BUDGET {
            return Err(ControlError::new(
                "FRAME_TOO_LARGE",
                "Desktop observation exceeds the IPC budget",
            ));
        }
        let mut elements = HashMap::new();
        if snapshot["tree"]["status"] == "available" {
            for element in snapshot["tree"]["elements"]
                .as_array()
                .ok_or_else(invalid)?
            {
                let element_id = string(element, "id")?;
                let actions = element["secondaryActions"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v["id"].as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                elements.insert(element_id, actions);
            }
        }
        let image = if snapshot["screenshot"]["status"] == "available" {
            let image = &snapshot["screenshot"]["image"];
            match (image["width"].as_f64(), image["height"].as_f64()) {
                (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((w, h)),
                _ => return Err(invalid()),
            }
        } else {
            None
        };
        snapshot["snapshotId"] = json!(id);
        task.snapshots.lock().unwrap().insert(
            session.into(),
            SnapshotPermit {
                id,
                elements,
                image,
            },
        );
        Ok(snapshot)
    }
    pub fn request(&self, route: &str, input: &Value) -> Option<Result<Value, String>> {
        match route {
            "computer_use.get_permission_status" if input.is_null() => {}
            "computer_use.request_permissions" if valid_permission_request(input) => {}
            "computer_use.get_permission_status" | "computer_use.request_permissions" => {
                return Some(Err("EVOSTACK_INVALID_COMPUTER_PERMISSION_REQUEST".into()))
            }
            _ => return None,
        }
        Some((|| {
            let runtime = (self.factory)().map_err(|e| e.message)?;
            let result = (|| {
                runtime.initialize()?;
                let status = runtime.call("getPermissionStatus", json!({}), "none")?;
                let caps = host_capabilities(runtime.call("getCapabilities", json!({}), "none")?);
                let state = self.state.lock().unwrap();
                permission_status(
                    status,
                    !state.shutdown && !state.cleanup_blocked && capabilities_available(&caps),
                )
            })();
            let cleanup = runtime.close();
            match (result, cleanup) {
                (Ok(value), Ok(())) => Ok(value),
                (Err(error), _) | (_, Err(error)) => Err(error.message),
            }
        })())
    }
}
fn capabilities_available(value: &Value) -> bool {
    value["platform"] == "win32"
        && ["accessibility", "click", "typeText", "setValue"]
            .iter()
            .all(|name| {
                value["capabilities"].as_array().is_some_and(|c| {
                    c.iter()
                        .any(|v| v["name"] == *name && v["availability"]["status"] == "available")
                })
            })
}
fn valid_permission_request(input: &Value) -> bool {
    input.as_object().is_some_and(|o| {
        o.len() == 1
            && o.get("ids").and_then(Value::as_array).is_some_and(|ids| {
                !ids.is_empty()
                    && ids
                        .iter()
                        .all(|id| matches!(id.as_str(), Some("accessibility" | "screenRecording")))
            })
    })
}
fn permission_status(result: Value, available: bool) -> ControlResult {
    let permissions = result["permissions"].as_array().ok_or_else(invalid)?;
    for permission in permissions {
        if permission["id"].as_str().is_none_or(str::is_empty)
            || !permission["label"].is_string()
            || !matches!(
                permission["status"].as_str(),
                Some("granted" | "denied" | "notDetermined" | "unknown" | "unavailable")
            )
            || !matches!(
                permission["interaction"].as_str(),
                Some("none" | "systemPrompt" | "systemSettings")
            )
        {
            return Err(invalid());
        }
    }
    Ok(json!({"permissions":permissions,"controlAvailable":available}))
}
fn validated_action(
    task: &Task,
    tool: &str,
    mut input: Value,
) -> Result<(String, Value), ControlError> {
    let fields: &[&str] = match tool {
        "click" => &[
            "appSessionId",
            "snapshotId",
            "elementId",
            "x",
            "y",
            "button",
            "count",
        ],
        "perform_secondary_action" => &["appSessionId", "snapshotId", "elementId", "actionId"],
        "scroll" => &[
            "appSessionId",
            "snapshotId",
            "elementId",
            "direction",
            "pages",
        ],
        "drag" => &["appSessionId", "snapshotId", "from", "to"],
        "type_text" => &["appSessionId", "snapshotId", "text"],
        "set_value" => &["appSessionId", "snapshotId", "elementId", "value"],
        _ => return Err(invalid()),
    };
    object_fields(&input, fields)?;
    let session = string(&input, "appSessionId")?;
    let snapshot = string(&input, "snapshotId")?;
    if !task.sessions.lock().unwrap().contains_key(&session) {
        return Err(ControlError::new(
            "UNKNOWN_APP_SESSION",
            "This application session does not belong to this task",
        ));
    }
    let permit = task
        .snapshots
        .lock()
        .unwrap()
        .get(&session)
        .cloned()
        .filter(|p| p.id == snapshot)
        .ok_or_else(|| {
            ControlError::new(
                "STALE_SNAPSHOT",
                "Observe the application again before input",
            )
        })?;
    let element = if input.get("elementId").is_some() {
        let id = string(&input, "elementId")?;
        if !permit.elements.contains_key(&id) {
            return Err(invalid());
        }
        Some(id)
    } else {
        None
    };
    let point = |value: &Value| -> bool {
        permit.image.is_some_and(|(w, h)| {
            value["x"].as_f64().is_some_and(|x| x >= 0.0 && x < w)
                && value["y"].as_f64().is_some_and(|y| y >= 0.0 && y < h)
        })
    };
    match tool {
        "click" => {
            if element.is_some() == (input.get("x").is_some() || input.get("y").is_some()) {
                return Err(invalid());
            }
            if element.is_none() && !point(&input) {
                return Err(invalid());
            }
            if input.get("button").is_some()
                && !matches!(input["button"].as_str(), Some("left" | "middle" | "right"))
            {
                return Err(invalid());
            }
            if input.get("count").is_some()
                && !input["count"]
                    .as_u64()
                    .is_some_and(|c| (1..=3).contains(&c))
            {
                return Err(invalid());
            }
        }
        "perform_secondary_action" => {
            let id = element.ok_or_else(invalid)?;
            let action = string(&input, "actionId")?;
            if !permit.elements[&id].contains(&action) {
                return Err(invalid());
            }
        }
        "scroll" => {
            if !matches!(
                input["direction"].as_str(),
                Some("up" | "down" | "left" | "right")
            ) || !input["pages"]
                .as_f64()
                .is_some_and(|v| v > 0.0 && v <= 20.0)
            {
                return Err(invalid());
            }
        }
        "drag" => {
            object_fields(&input["from"], &["x", "y"])?;
            object_fields(&input["to"], &["x", "y"])?;
            if !point(&input["from"]) || !point(&input["to"]) {
                return Err(invalid());
            }
        }
        "type_text" => {
            if !input["text"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.len() <= 100000)
            {
                return Err(invalid());
            }
        }
        "set_value" => {
            if element.is_none() || !input["value"].as_str().is_some_and(|v| v.len() <= 100000) {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    // Validation rejections have no effect and preserve the observation; actual dispatch consumes it.
    task.snapshots.lock().unwrap().remove(&session);
    input["type"] = json!(if tool == "perform_secondary_action" {
        "performSecondaryAction"
    } else if tool == "type_text" {
        "typeText"
    } else if tool == "set_value" {
        "setValue"
    } else {
        tool
    });
    input["allowGlobalInput"] = json!(false);
    Ok((session, input))
}
fn read_frame(reader: &mut impl Read) -> Result<Value, String> {
    let mut header = Vec::new();
    loop {
        let mut byte = [0];
        reader
            .read_exact(&mut byte)
            .map_err(|_| "Desktop helper pipe closed")?;
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() >= 8192 {
            return Err("Desktop helper header too large".into());
        }
    }
    let header = std::str::from_utf8(&header).map_err(|_| "Invalid desktop frame")?;
    let lengths: Vec<_> = header
        .split("\r\n")
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
        .map(|(_, v)| v.trim().parse::<usize>())
        .collect();
    let length = match lengths.as_slice() {
        [Ok(n)] if *n > 0 && *n <= MAX_NATIVE_FRAME => *n,
        _ => return Err("Invalid desktop frame length".into()),
    };
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|_| "Desktop helper pipe closed")?;
    serde_json::from_slice(&body).map_err(|_| "Invalid desktop JSON".into())
}

// Windows helper UIA workers are lazy (created on desktop operations). Put the helper
// in our job before initialize, so both ordinary cleanup and host death own its tree.
#[cfg(windows)]
mod process_ownership {
    use std::{ffi::c_void, io, os::windows::io::AsRawHandle, process::Child};
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(
            job: isize,
            class: u32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: *mut c_void) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
    }
    pub struct Job(isize);
    impl Job {
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
        pub fn assign(child: &Child) -> io::Result<Self> {
            let job = Self(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
            if job.0 == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000;
            if unsafe {
                SetInformationJobObject(
                    job.0,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn text_prefix(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
fn metadata_size(snapshot: &mut Value) -> Result<usize, ControlError> {
    let data = snapshot
        .get_mut("screenshot")
        .and_then(|s| s.get_mut("image"))
        .and_then(Value::as_object_mut)
        .and_then(|o| o.remove("dataBase64"));
    let size = serde_json::to_vec(snapshot).map_err(|_| invalid())?.len();
    if let Some(data) = data {
        snapshot["screenshot"]["image"]["dataBase64"] = data;
    }
    Ok(size)
}
fn bound_observation(snapshot: &mut Value) -> Result<(), ControlError> {
    for (object, key) in [("app", "name"), ("window", "title")] {
        if let Some(text) = snapshot[object][key].as_str() {
            let bounded = text_prefix(text, 512).to_owned();
            if bounded.len() != text.len() {
                snapshot["metadataTruncated"] = json!(true);
            }
            snapshot[object][key] = json!(bounded);
        }
    }
    if snapshot["tree"]["status"] != "available" {
        return if metadata_size(snapshot)? <= 112 * 1024 {
            Ok(())
        } else {
            Err(ControlError::new(
                "FRAME_TOO_LARGE",
                "Desktop observation metadata exceeds the IPC budget",
            ))
        };
    }
    let mut changed = false;
    let mut elements = snapshot["tree"]["elements"]
        .as_array()
        .cloned()
        .ok_or_else(invalid)?;
    for element in &mut elements {
        for key in ["name", "value"] {
            if let Some(text) = element[key].as_str() {
                if text.len() > 512 {
                    element[key] = json!(text_prefix(text, 512));
                    changed = true;
                }
            }
        }
        if let Some(actions) = element["secondaryActions"].as_array_mut() {
            for action in actions {
                if let Some(label) = action["label"].as_str() {
                    if label.len() > 256 {
                        action["label"] = json!(text_prefix(label, 256));
                        changed = true;
                    }
                }
            }
        }
    }
    let mut truncated = snapshot["tree"]["truncated"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut nodes_removed = false;
    loop {
        snapshot["tree"]["elements"] = json!(elements);
        if changed || nodes_removed {
            snapshot["tree"]["text"] = json!(elements
                .iter()
                .map(|e| format!(
                    "{}: {} {} {}",
                    e["id"].as_str().unwrap_or(""),
                    e["role"].as_str().unwrap_or(""),
                    e["name"].as_str().unwrap_or(""),
                    e["value"].as_str().unwrap_or("")
                ))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        if metadata_size(snapshot)? <= 110 * 1024 {
            break;
        }
        if elements.pop().is_none() {
            return Err(ControlError::new(
                "FRAME_TOO_LARGE",
                "Desktop observation metadata exceeds the IPC budget",
            ));
        }
        nodes_removed = true;
    }
    if changed && !truncated.contains(&json!("text")) {
        truncated.push(json!("text"));
    }
    if nodes_removed {
        for kind in ["nodes", "text"] {
            if !truncated.contains(&json!(kind)) {
                truncated.push(json!(kind));
            }
        }
    }
    snapshot["tree"]["truncated"] = json!(truncated);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const TASK: &str = "00000000-0000-0000-0000-000000000001";
    const TASK2: &str = "00000000-0000-0000-0000-000000000002";
    const OWNER: &str = "00000000-0000-0000-0000-000000000003";
    fn capabilities() -> Value {
        json!({"platform":"win32","capabilities":[{"name":"accessibility","availability":{"status":"available"}},{"name":"click","availability":{"status":"available"}},{"name":"typeText","availability":{"status":"available"}},{"name":"pressKey","availability":{"status":"available"}},{"name":"setValue","availability":{"status":"available"}}]})
    }
    fn snapshot(id: &str) -> Value {
        json!({"id":id,"appSessionId":"session-1","app":{"id":"app-1","name":"Fixture"},"window":{"id":"window-1","title":"Fixture"},"tree":{"status":"available","elements":[{"id":"1","role":"button","name":"Count","actions":["click"],"secondaryActions":[{"id":"menu","label":"Menu"}]}],"truncated":[]},"screenshot":{"status":"available","image":{"mimeType":"image/png","width":100,"height":80,"dataBase64":"AAAA"}}})
    }
    struct FakeRuntime {
        calls: Mutex<Vec<(String, Value)>>,
        cancelled: AtomicBool,
        closed: AtomicBool,
        waiting: AtomicBool,
        fail_close: bool,
        sequence: AtomicU64,
    }
    impl FakeRuntime {
        fn new(fail_close: bool) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                cancelled: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                waiting: AtomicBool::new(false),
                fail_close,
                sequence: AtomicU64::new(0),
            }
        }
    }
    impl Runtime for FakeRuntime {
        fn initialize(&self) -> ControlResult {
            Ok(json!({"ownership":"private"}))
        }
        fn call(&self, method: &str, input: Value, _: &str) -> ControlResult {
            self.calls
                .lock()
                .unwrap()
                .push((method.into(), input.clone()));
            match method {
                "getPermissionStatus" => Ok(json!({"permissions":[]})),
                "getCapabilities" => Ok(capabilities()),
                "listApps" => {
                    Ok(json!([{"id":"app-1","name":"Fixture","identity":"fixture:stable"}]))
                }
                "openAppSession" => Ok(
                    json!({"id":"session-1","app":{"id":"app-1","name":"Fixture"},"status":"active"}),
                ),
                "getAppState" => {
                    assert_eq!(input["activation"], "never");
                    Ok(snapshot(&format!(
                        "snapshot-{}",
                        self.sequence.fetch_add(1, Ordering::Relaxed)
                    )))
                }
                "act" => {
                    assert_eq!(input["allowGlobalInput"], false);
                    if input["text"] == "wait" {
                        self.waiting.store(true, Ordering::Release);
                        while !self.cancelled.load(Ordering::Acquire) {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        return Err(ControlError::new("CANCELLED", "Cancelled"));
                    }
                    Ok(
                        json!({"status":"completed","observation":{"status":"available","snapshot":snapshot(&format!("snapshot-{}",self.sequence.fetch_add(1,Ordering::Relaxed)))}}),
                    )
                }
                _ => Err(invalid()),
            }
        }
        fn revoke(&self) {
            self.cancelled.store(true, Ordering::Release);
        }
        fn cancel(&self) {
            self.revoke();
        }
        fn close(&self) -> Result<(), ControlError> {
            self.closed.store(true, Ordering::Release);
            if self.fail_close {
                Err(ControlError::uncertain(
                    "CLEANUP_UNCONFIRMED",
                    "Unconfirmed",
                    "possible",
                ))
            } else {
                Ok(())
            }
        }
    }
    type FakeInstances = Arc<Mutex<Vec<Arc<FakeRuntime>>>>;
    fn controller(fail_close: bool) -> (Arc<Controller>, FakeInstances) {
        let runtimes = Arc::new(Mutex::new(Vec::new()));
        let instances = runtimes.clone();
        let factory: RuntimeFactory = Arc::new(move || {
            let runtime = Arc::new(FakeRuntime::new(fail_close));
            instances.lock().unwrap().push(runtime.clone());
            Ok(runtime as Arc<dyn Runtime>)
        });
        (Arc::new(Controller::with_factory(factory)), runtimes)
    }
    fn configure(c: &Controller, epoch: u64, enabled: bool) -> Value {
        c.dispatch(&json!({"operation":"configure","epoch":epoch,"enabled":enabled}))
    }
    fn invoke(c: &Controller, task: &str, epoch: u64, tool: &str, input: Value) -> Value {
        c.dispatch(&json!({"operation":"invoke","epoch":epoch,"taskId":task,"ownerId":OWNER,"label":"Fixture task","tool":tool,"input":input}))
    }
    fn authorize(c: &Controller, task: &str) {
        assert!(c.grant_task(c.capture_open(OWNER).unwrap(), task));
    }
    fn open(c: &Controller, task: &str) {
        authorize(c, task);
        assert_eq!(invoke(c, task, 1, "list_apps", json!({}))["ok"], true);
        assert_eq!(
            invoke(c, task, 1, "open_app", json!({"appId":"app-1"}))["ok"],
            true
        );
    }

    #[test]
    fn epochs_user_stop_and_task_tombstones_cannot_be_bypassed_by_tools() {
        let (c, runtimes) = controller(false);
        assert_eq!(invoke(&c, TASK, 1, "list_apps", json!({}))["ok"], false);
        assert_eq!(configure(&c, 1, true)["ok"], true);
        open(&c, TASK);
        c.user_enabled(false);
        assert_eq!(configure(&c, 1, true)["ok"], false);
        assert_eq!(invoke(&c, TASK, 1, "list_apps", json!({}))["ok"], false);
        assert_eq!(configure(&c, 2, false)["ok"], true);
        assert_eq!(
            configure(&c, 1, true)["error"]["code"],
            "STALE_CONTROL_EPOCH"
        );
        c.user_enabled(true);
        assert_eq!(configure(&c, 3, true)["ok"], true);
        assert_eq!(
            invoke(&c, TASK, 1, "list_apps", json!({}))["error"]["code"],
            "STALE_CONTROL_EPOCH"
        );
        assert!(runtimes.lock().unwrap()[0].closed.load(Ordering::Acquire));
        authorize(&c, TASK2);
        assert_eq!(invoke(&c, TASK2, 3, "list_apps", json!({}))["ok"], true);
        c.cancel_task(TASK2);
        assert_eq!(invoke(&c, TASK2, 3, "list_apps", json!({}))["ok"], false);
        c.shutdown();
    }
    #[test]
    fn app_identity_ownership_and_native_scope_are_enforced() {
        let (c, _) = controller(false);
        configure(&c, 1, true);
        assert_eq!(
            invoke(&c, TASK, 1, "open_app", json!({"appId":"app-1"}))["ok"],
            false
        );
        open(&c, TASK);
        authorize(&c, TASK2);
        invoke(&c, TASK2, 1, "list_apps", json!({}));
        assert_eq!(
            invoke(&c, TASK2, 1, "open_app", json!({"appId":"app-1"}))["error"]["code"],
            "APP_BUSY"
        );
        c.state.lock().unwrap().tasks[TASK2].known_apps.lock().unwrap().insert("different-native-token".into(),json!({"id":"different-native-token","name":"Different display name","identity":"FIXTURE:STABLE"}));
        assert_eq!(
            invoke(
                &c,
                TASK2,
                1,
                "open_app",
                json!({"appId":"different-native-token"})
            )["error"]["code"],
            "APP_BUSY"
        );
        assert_eq!(
            invoke(
                &c,
                TASK2,
                1,
                "get_app_state",
                json!({"appSessionId":"session-1"})
            )["error"]["code"],
            "UNKNOWN_APP_SESSION"
        );
        assert_eq!(
            invoke(&c, TASK, 1, "configure", json!({"enabled":true}))["error"]["code"],
            "INVALID_INPUT"
        );
        assert_eq!(
            c.dispatch(&json!({"operation":"close_task","taskId":TASK}))["ok"],
            true
        );
        assert_eq!(
            invoke(&c, TASK, 1, "list_apps", json!({}))["error"]["code"],
            "TASK_CLOSED"
        );
        assert_eq!(
            invoke(&c, TASK2, 1, "open_app", json!({"appId":"app-1"}))["ok"],
            true
        );
        c.shutdown();
    }
    #[test]
    fn every_action_consumes_its_snapshot_and_background_policy_is_forced() {
        let (c, runtimes) = controller(false);
        configure(&c, 1, true);
        open(&c, TASK);
        let state = invoke(
            &c,
            TASK,
            1,
            "get_app_state",
            json!({"appSessionId":"session-1"}),
        );
        let id = state["data"]["id"].clone();
        assert_eq!(
            invoke(
                &c,
                TASK,
                1,
                "click",
                json!({"appSessionId":"session-1","snapshotId":id,"x":100,"y":0})
            )["error"]["code"],
            "INVALID_INPUT"
        );
        assert_eq!(
            invoke(
                &c,
                TASK,
                1,
                "click",
                json!({"appSessionId":"session-1","snapshotId":id,"elementId":"1","allowGlobalInput":true})
            )["error"]["code"],
            "INVALID_INPUT"
        );
        let action = invoke(
            &c,
            TASK,
            1,
            "click",
            json!({"appSessionId":"session-1","snapshotId":id,"elementId":"1"}),
        );
        assert_eq!(action["ok"], true);
        assert_eq!(
            invoke(
                &c,
                TASK,
                1,
                "click",
                json!({"appSessionId":"session-1","snapshotId":id,"elementId":"1"})
            )["error"]["code"],
            "STALE_SNAPSHOT"
        );
        assert_eq!(
            runtimes.lock().unwrap()[0]
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "act")
                .count(),
            1
        );
        c.shutdown();
    }
    #[test]
    fn background_key_rejection_never_starts_or_calls_helper_and_preserves_snapshot() {
        let (c, runtimes) = controller(false);
        configure(&c, 1, true);
        authorize(&c, TASK);
        let input = json!({"appSessionId":"session-1","snapshotId":"unused","key":"Return"});
        let result = invoke(&c, TASK, 1, "press_key", input);
        assert_eq!(result["error"]["code"], "BACKGROUND_UNAVAILABLE");
        assert_eq!(result["error"]["effect"], "none");
        assert!(runtimes.lock().unwrap().is_empty());
        assert!(c.state.lock().unwrap().tasks.is_empty());

        let apps = invoke(&c, TASK, 1, "list_apps", json!({}));
        let keyboard = apps["data"]["capabilities"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|capability| capability["name"] == "pressKey")
            .unwrap();
        assert_eq!(keyboard["availability"]["status"], "unsupported");
        assert_eq!(
            keyboard["availability"]["reason"]["code"],
            "UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(
            invoke(&c, TASK, 1, "open_app", json!({"appId":"app-1"}))["ok"],
            true
        );
        let observation = invoke(
            &c,
            TASK,
            1,
            "get_app_state",
            json!({"appSessionId":"session-1"}),
        );
        let snapshot_id = observation["data"]["id"].clone();
        let runtime = runtimes.lock().unwrap()[0].clone();
        let calls = runtime.calls.lock().unwrap().len();
        assert_eq!(
            invoke(
                &c,
                TASK,
                1,
                "press_key",
                json!({"appSessionId":"session-1","snapshotId":snapshot_id,"key":"Return"})
            )["error"]["code"],
            "BACKGROUND_UNAVAILABLE"
        );
        assert_eq!(runtime.calls.lock().unwrap().len(), calls);
        assert_eq!(
            invoke(
                &c,
                TASK,
                1,
                "click",
                json!({"appSessionId":"session-1","snapshotId":snapshot_id,"elementId":"1"})
            )["ok"],
            true
        );
        c.shutdown();
    }
    #[test]
    fn cancel_bypasses_the_waiting_action_lock_and_cleanup_is_confirmed() {
        let (c, runtimes) = controller(false);
        configure(&c, 1, true);
        open(&c, TASK);
        let state = invoke(
            &c,
            TASK,
            1,
            "get_app_state",
            json!({"appSessionId":"session-1"}),
        );
        let id = state["data"]["id"].clone();
        let worker = c.clone();
        let handle = std::thread::spawn(move || {
            invoke(
                &worker,
                TASK,
                1,
                "type_text",
                json!({"appSessionId":"session-1","snapshotId":id,"text":"wait"}),
            )
        });
        let runtime = runtimes.lock().unwrap()[0].clone();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !runtime.waiting.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(runtime.waiting.load(Ordering::Acquire));
        let start = Instant::now();
        c.user_enabled(false);
        assert!(start.elapsed() < Duration::from_millis(250));
        assert_eq!(handle.join().unwrap()["error"]["code"], "CANCELLED");
        assert_eq!(configure(&c, 2, false)["ok"], true);
        assert!(runtime.closed.load(Ordering::Acquire));
        c.shutdown();
    }
    #[test]
    fn cleanup_failure_is_sticky_across_repeated_and_new_configurations() {
        let (c, _) = controller(true);
        configure(&c, 1, true);
        open(&c, TASK);
        assert_eq!(
            c.dispatch(&json!({"operation":"close_task","taskId":TASK}))["error"]["cleanup"],
            "unconfirmed"
        );
        assert_eq!(configure(&c, 1, true)["ok"], false);
        assert_eq!(configure(&c, 2, false)["ok"], false);
        c.user_enabled(true);
        assert_eq!(configure(&c, 3, true)["ok"], false);
        assert_eq!(invoke(&c, TASK2, 3, "list_apps", json!({}))["ok"], false);
    }
    #[test]
    fn large_screenshots_are_not_rescaled_or_exposed_as_coordinate_targets() {
        let (c, _) = controller(false);
        let task = Task::new(OWNER.into(), 1);
        task.sessions
            .lock()
            .unwrap()
            .insert("session-1".into(), "app-1".into());
        let mut image = snapshot("snapshot-1");
        image["screenshot"]["image"]["dataBase64"] = json!("A".repeat(2 * 1024 * 1024 + 1));
        let result = c.record_snapshot(&task, "session-1", image).unwrap();
        assert_eq!(result["screenshot"]["status"], "unavailable");
        assert_eq!(result["tree"]["status"], "available");
        assert!(validated_action(
            &task,
            "click",
            json!({"appSessionId":"session-1","snapshotId":"snapshot-1","x":5,"y":5})
        )
        .is_err());
        assert!(validated_action(
            &task,
            "click",
            json!({"appSessionId":"session-1","snapshotId":"snapshot-1","elementId":"1"})
        )
        .is_ok());
    }
    #[test]
    fn wire_frames_and_errors_preserve_uncertainty_without_retry() {
        let body = br#"{"jsonrpc":"2.0","id":"native:1","result":{"permissions":[]}}"#;
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend(body);
        assert_eq!(read_frame(&mut frame.as_slice()).unwrap()["id"], "native:1");
        for bad in [
            b"Content-Length: 1\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
            b"Content-Length: 16777217\r\n\r\n",
            b"Content-Length: 9\r\n\r\n{}",
        ] {
            let mut input = bad;
            assert!(read_frame(&mut input).is_err());
        }
        let error = native_response(
            &json!({"error":{"message":"uncertain","data":{"code":"TIMEOUT","effect":"possible"}}}),
        )
        .unwrap_err();
        assert_eq!(error.effect, "possible");
        assert_eq!(
            native_response(&json!({"result":{"status":"completed"}})).unwrap()["status"],
            "completed"
        );
    }
    #[test]
    fn permission_preflight_uses_actual_capabilities_and_cleanup_state() {
        assert!(capabilities_available(&capabilities()));
        assert!(!capabilities_available(
            &json!({"platform":"win32","capabilities":[]})
        ));
        assert_eq!(
            permission_status(json!({"permissions":[]}), true).unwrap()["controlAvailable"],
            true
        );
        assert!(valid_permission_request(&json!({"ids":["accessibility"]})));
        assert!(!valid_permission_request(&json!({"ids":["keyboard"]})));
        assert!(permission_status(
            json!({"permissions":[{"id":"x","label":"x","status":"yes","interaction":"none"}]}),
            true
        )
        .is_err());
        assert!(uuid(&session_id()));
        assert_ne!(session_id(), session_id());
    }
    #[test]
    fn observation_metadata_is_bounded_and_reports_actual_tree_truncation() {
        let mut value = snapshot("s");
        value["tree"]["elements"]=json!((0..500).map(|n|json!({"id":n.to_string(),"role":"text","name":"桌面".repeat(200),"value":"v".repeat(3000),"actions":[],"secondaryActions":[]})).collect::<Vec<_>>());
        value["tree"]["text"] = json!("large".repeat(100000));
        bound_observation(&mut value).unwrap();
        assert!(metadata_size(&mut value).unwrap() < 112 * 1024);
        assert!(value["tree"]["truncated"]
            .as_array()
            .unwrap()
            .contains(&json!("nodes")));
        assert!(value["tree"]["truncated"]
            .as_array()
            .unwrap()
            .contains(&json!("text")));
        assert_eq!(value["screenshot"]["image"]["width"], 100);
        assert_eq!(value["screenshot"]["image"]["height"], 80);
        assert!(value["tree"]["elements"].as_array().unwrap().len() < 500);
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "spawns only an owned, gated PowerShell parent and sleeping child; no desktop input"]
    fn kill_on_close_job_terminates_the_owned_helper_descendant_tree() {
        use std::{
            io::{BufRead, BufReader},
            os::windows::process::CommandExt,
        };
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, id: u32) -> isize;
            fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
            fn CloseHandle(handle: isize) -> i32;
        }
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile","-NonInteractive","-Command","[Console]::ReadLine() | Out-Null; $fixtureChild=Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru; [Console]::WriteLine($fixtureChild.Id); Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut parent = command.spawn().unwrap();
        let job = match process_ownership::Job::assign(&parent) {
            Ok(job) => job,
            Err(error) => {
                let _ = parent.kill();
                let _ = parent.wait();
                panic!("Could not own test process tree: {error}")
            }
        };
        parent
            .stdin
            .take()
            .unwrap()
            .write_all(b"continue\n")
            .unwrap();
        let mut line = String::new();
        BufReader::new(parent.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let child_pid: u32 = line.trim().parse().unwrap();
        let child = unsafe { OpenProcess(0x00100000, 0, child_pid) };
        assert_ne!(child, 0);
        // Killing the directly owned parent alone must still release all descendants on job close.
        parent.kill().unwrap();
        parent.wait().unwrap();
        drop(job);
        assert_eq!(unsafe { WaitForSingleObject(child, 5000) }, 0);
        unsafe {
            CloseHandle(child);
        }
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "reads capabilities and permissions only from the packaged helper; no app discovery or input"]
    fn native_helper_private_session_preflight_confirms_cleanup() {
        let path = std::env::var_os("EVOSTACK_TEST_COMPUTER_RUNTIME")
            .expect("Set the packaged helper path");
        let c = Controller::new(PathBuf::from(path));
        let result = c
            .request("computer_use.get_permission_status", &Value::Null)
            .unwrap()
            .unwrap();
        assert_eq!(result["permissions"], json!([]));
        assert_eq!(result["controlAvailable"], true);
    }
    #[test]
    fn stop_before_first_native_call_rejects_old_ack_and_allows_new_user_open() {
        let (c, _) = controller(false);
        let pending_open = c.capture_open(OWNER).unwrap();
        c.stop_owner(OWNER);
        assert!(!c.grant_task(pending_open, TASK));
        configure(&c, 1, true);
        assert_eq!(
            invoke(&c, TASK, 1, "list_apps", json!({}))["error"]["code"],
            "TASK_CLOSED"
        );
        authorize(&c, TASK2);
        assert_eq!(invoke(&c, TASK2, 1, "list_apps", json!({}))["ok"], true);
        c.shutdown();
    }
    #[test]
    fn global_revocation_rejects_pending_ack_but_initial_true_keeps_fresh_grant() {
        let (c, _) = controller(false);
        authorize(&c, TASK);
        assert_eq!(configure(&c, 1, true)["ok"], true);
        assert_eq!(invoke(&c, TASK, 1, "list_apps", json!({}))["ok"], true);
        let old = c.capture_open(OWNER).unwrap();
        c.user_enabled(false);
        configure(&c, 2, false);
        c.user_enabled(true);
        configure(&c, 3, true);
        assert!(!c.grant_task(old, TASK2));
        authorize(&c, TASK2);
        assert_eq!(invoke(&c, TASK2, 3, "list_apps", json!({}))["ok"], true);
        c.shutdown();
    }
    #[test]
    fn opening_while_user_stop_is_latched_cannot_receive_a_future_grant() {
        let (c, _) = controller(false);
        assert!(c.capture_open(OWNER).is_some()); // Initial persisted authorization may not be configured yet.
        c.user_enabled(false);
        assert!(c.capture_open(OWNER).is_none());
        c.user_enabled(true);
        let ticket = c.capture_open(OWNER).unwrap();
        assert!(c.grant_task(ticket, TASK));
        configure(&c, 1, true);
        assert_eq!(invoke(&c, TASK, 1, "list_apps", json!({}))["ok"], true);
        c.shutdown();
    }
}
