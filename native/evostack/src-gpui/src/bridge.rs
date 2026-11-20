//! The small, version-independent boundary between Wry and the desktop host.
use crate::{host::trusted_origin, Reply, MAX_FRAME};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const MAX_PENDING: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct EventChannel(Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>);
impl EventChannel {
    pub fn new(send: impl Fn(Value) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(send))
    }
    pub fn send(&self, event: Value) -> Result<(), String> {
        (self.0)(event)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub session: String,
    pub command: String,
    pub args: Value,
}

pub fn parse_request(origin: &str, body: &str) -> Result<Request, &'static str> {
    if !url::Url::parse(origin)
        .ok()
        .is_some_and(|url| trusted_origin(&url))
    {
        return Err("EVOSTACK_UNTRUSTED_FRONTEND");
    }
    if body.len() >= MAX_FRAME {
        return Err("EVOSTACK_REQUEST_TOO_LARGE");
    }
    let request: Request = serde_json::from_str(body).map_err(|_| "EVOSTACK_INVALID_REQUEST")?;
    let session = request.session.as_bytes();
    if request.id == 0
        || request.id > MAX_SAFE_INTEGER
        || session.len() != 36
        || !session.iter().enumerate().all(|(i, ch)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *ch == b'-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
        || !request.args.is_object()
    {
        return Err("EVOSTACK_INVALID_REQUEST");
    }
    match request.command.as_str() {
        "desktop_info" | "subscribe" | "start_dragging"
            if request.args.as_object().unwrap().is_empty() => {}
        "ipc_request"
            if request.args["channel"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.len() <= 512)
                && request.args["args"].is_array()
                && request.args.as_object().unwrap().len() == 2 => {}
        _ => return Err("EVOSTACK_INVALID_COMMAND"),
    }
    Ok(request)
}

pub fn reply_script(request: &Request, result: Reply) -> String {
    let value = match result {
        Ok(value) => json!({"session":request.session,"id":request.id,"result":value}),
        Err(error) => json!({"session":request.session,"id":request.id,"error":error}),
    };
    delivery_script(&value).unwrap_or_else(|_| {
        delivery_script(&json!({"session":request.session,"id":request.id,"error":"EVOSTACK_RESPONSE_TOO_LARGE"})).unwrap()
    })
}

pub fn event_script(session: &str, event: Value) -> Result<String, &'static str> {
    delivery_script(&json!({"session":session,"event":event}))
}

fn delivery_script(value: &Value) -> Result<String, &'static str> {
    // Serialize both layers instead of interpolating user text into JavaScript.
    // JSON.parse also preserves own "__proto__" keys, unlike an object literal.
    let serialized = serde_json::to_string(value).map_err(|_| "EVOSTACK_INVALID_RESPONSE")?;
    if serialized.len() >= MAX_FRAME {
        return Err("EVOSTACK_RESPONSE_TOO_LARGE");
    }
    let quoted = serde_json::to_string(&serialized).map_err(|_| "EVOSTACK_INVALID_RESPONSE")?;
    Ok(format!(
        "window.__TINYCHERRY_RECEIVE__?.(JSON.parse({quoted}));"
    ))
}

#[derive(Clone, Default)]
pub struct RequestBudget(Arc<AtomicUsize>);
pub struct RequestPermit(Arc<AtomicUsize>);
impl RequestBudget {
    pub fn acquire(&self) -> Option<RequestPermit> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_PENDING).then_some(n + 1)
            })
            .ok()
            .map(|_| RequestPermit(self.0.clone()))
    }
}
impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "01234567-89ab-4cde-8fab-0123456789ab";
    fn request() -> Value {
        json!({"id":1,"session":SESSION,"command":"ipc_request","args":{"channel":"ipc-api:request","args":["app.get_info"]}})
    }
    const ORIGIN: &str = "http://tauri.localhost/windows/evostack/index.html";

    fn delivered(script: &str) -> Value {
        let quoted = script
            .strip_prefix("window.__TINYCHERRY_RECEIVE__?.(JSON.parse(")
            .unwrap()
            .strip_suffix("));")
            .unwrap();
        let json: String = serde_json::from_str(quoted).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn ipc_checks_sender_and_a_bounded_command_envelope() {
        assert!(parse_request(ORIGIN, &request().to_string()).is_ok());
        for origin in [
            "https://example.com/",
            "http://tauri.localhost.evil/",
            "file:///index.html",
            "blob:http://tauri.localhost/1",
        ] {
            assert!(parse_request(origin, &request().to_string()).is_err());
        }
        for value in [json!(0), json!(9007199254740992_u64), json!(-1), json!(1.5)] {
            let mut body = request();
            body["id"] = value;
            assert!(parse_request(ORIGIN, &body.to_string()).is_err());
        }
        let mut body = request();
        body["session"] = json!("');evil();//");
        assert!(parse_request(ORIGIN, &body.to_string()).is_err());
        let mut body = request();
        body["command"] = json!("arbitrary_shell");
        assert!(parse_request(ORIGIN, &body.to_string()).is_err());
        let mut body = request();
        body["args"]["extra"] = json!(1);
        assert!(parse_request(ORIGIN, &body.to_string()).is_err());
        assert_eq!(
            parse_request(ORIGIN, &"x".repeat(MAX_FRAME)).unwrap_err(),
            "EVOSTACK_REQUEST_TOO_LARGE"
        );
    }

    #[test]
    fn replies_preserve_document_identity_and_explicit_null_results() {
        let request = parse_request(ORIGIN, &request().to_string()).unwrap();
        let script = reply_script(&request, Ok(Value::Null));
        let parsed = delivered(&script);
        assert_eq!(parsed["session"], SESSION);
        assert!(parsed.get("result").unwrap().is_null());
        let text = "</script>');globalThis.pwned=true;//`\\\"";
        let script = reply_script(&request, Ok(json!(text)));
        assert_eq!(delivered(&script)["result"], text);
        let with_proto = json!({"__proto__":{"marker":1}});
        assert_eq!(
            delivered(&reply_script(&request, Ok(with_proto.clone())))["result"],
            with_proto
        );
        assert!(reply_script(&request, Ok(json!("x".repeat(MAX_FRAME))))
            .contains("EVOSTACK_RESPONSE_TOO_LARGE"));
    }

    #[test]
    fn capacity_is_returned_on_all_completion_and_drop_paths() {
        let budget = RequestBudget::default();
        let mut permits: Vec<_> = (0..MAX_PENDING)
            .map(|_| budget.acquire().unwrap())
            .collect();
        assert!(budget.acquire().is_none());
        permits.pop();
        assert!(budget.acquire().is_some());
        drop(permits);
        assert_eq!(budget.0.load(Ordering::Acquire), 0);
    }
}
