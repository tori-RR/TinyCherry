//! GPUI owns the native window and event loop; Wry owns the React document.
use crate::{
    assets,
    bridge::{self, EventChannel, Request, RequestBudget, RequestPermit},
    build_info, desktop_response,
    host::{trusted_origin, verify_backend_info},
    native_window, platform, smoke,
    window_background::{WindowTheme, THEME_PREFERENCE},
    Backend, Reply,
};
use async_channel::{Receiver, Sender};
use gpui::{
    div, prelude::*, px, rgb, size, App, Application, Bounds, Context, PathPromptOptions,
    Subscription, Task, TitlebarOptions, Window, WindowAppearance, WindowBounds, WindowOptions,
};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    cell::RefCell,
    path::PathBuf,
    process::Command,
    rc::{Rc, Weak},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use wry::{
    dpi::{LogicalPosition, LogicalSize},
    WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows,
};

const FRONTEND_PATH: &str = "windows/evostack/index.html";

fn skill_picker_has_no_input(args: &[Value]) -> bool {
    // The renderer facade serializes unused input and metadata slots as null.
    matches!(args, [_] | [_, Value::Null] | [_, Value::Null, Value::Null])
}

enum UiMessage {
    Request(Request, RequestPermit),
    Reply(Request, Reply, RequestPermit),
    Event(String, Value),
    Theme(WindowTheme),
    NavigationStarted,
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_arch = "x86_64") {
        return Err("TinyCherry currently supports Windows x64 only".into());
    }
    // Native child HWNDs cannot appear through GPUI's DirectComposition surface.
    // The GPUI renderer still uses its GPU renderer, with a regular HWND swapchain.
    std::env::set_var("GPUI_DISABLE_DIRECT_COMPOSITION", "true");
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
    let smoke_arguments = smoke::browser_arguments(
        std::env::var("TINYCHERRY_EVOSTACK_SMOKE_TOKEN")
            .ok()
            .as_deref(),
        std::env::var("TINYCHERRY_EVOSTACK_SMOKE_PORT")
            .ok()
            .as_deref(),
        std::env::var_os("TINYCHERRY_EVOSTACK_DATA_DIR").is_some(),
    )?;
    std::fs::create_dir_all(data_dir.join("webview"))?;
    let (sender, receiver) = async_channel::bounded(256);
    let theme_sender = sender.clone();
    let backend = Arc::new(Backend::start(data_dir.clone(), move |event| {
        if let Some(theme) = WindowTheme::from_event(event) {
            // This callback runs on the sidecar reader thread. Backpressure is
            // bounded and closing the window closes the queue and wakes writers.
            let _ = theme_sender.send_blocking(UiMessage::Theme(theme));
        }
    })?);
    let info = backend
        .request("backend.info", Value::Null)
        .map_err(std::io::Error::other)?;
    verify_backend_info(&info).map_err(std::io::Error::other)?;
    backend
        .diagnostics
        .record("host: sidecar identity verified");
    let theme = backend
        .request(
            "ipc.invoke",
            json!({"channel":"preference:get","args":[THEME_PREFERENCE]}),
        )
        .ok();
    let theme = WindowTheme::from_preference(theme.as_ref().and_then(Value::as_str));
    let running = backend.clone();
    let shutdown_sender = sender.clone();
    backend.diagnostics.record("host: initializing GPUI");
    let application = Application::new();
    backend.diagnostics.record("host: GPUI initialized");
    application.run(move |cx: &mut App| {
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.on_app_quit(move |_| {
            shutdown_sender.close();
            async {}
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(1280.), px(850.)), cx);
        running.diagnostics.record("host: creating GPUI window");
        let result = cx.open_window(
            WindowOptions {
                // Activation is queued after the root and close handler exist.
                // WebView2 is created in a later foreground task.
                show: false,
                focus: false,
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("TinyCherry".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                window_min_size: Some(size(px(900.), px(600.))),
                app_id: Some("com.tinycherry.evostack".into()),
                ..Default::default()
            },
            move |window, cx| {
                running.diagnostics.record("host: GPUI window created");
                let view = cx.new(|cx| Desktop::new(window, cx, running, theme, sender));
                let weak = view.downgrade();
                window.on_window_should_close(cx, move |_, cx| {
                    weak.update(cx, |view, cx| {
                        let should_close = view.request_close();
                        cx.notify();
                        should_close
                    })
                    .unwrap_or(true)
                });
                // GPUI schedules this activation after the current App borrow.
                window.activate_window();
                view.read(cx)
                    .backend
                    .diagnostics
                    .record("host: window activation scheduled");
                view.update(cx, |view, cx| {
                    view.initialize(window, cx, data_dir, smoke_arguments, receiver);
                });
                view
            },
        );
        if let Err(error) = result {
            native_window::show_startup_error(&format!(
                "Could not create the TinyCherry window: {error}"
            ));
            cx.quit();
        } else {
            cx.activate(true);
        }
    });
    // GPUI has destroyed the WebView on its UI thread before sidecar shutdown.
    // Keep an owning Arc here so background requests cannot skip the final reap.
    backend.shutdown();
    Ok(())
}

struct Desktop {
    webview: Option<Rc<WebView>>,
    backend: Arc<Backend>,
    sender: Sender<UiMessage>,
    session: Option<String>,
    skill_picker_open: bool,
    desired_fullscreen: Option<bool>,
    fullscreen_transition: Option<bool>,
    theme: WindowTheme,
    startup_error: Option<String>,
    initializing: bool,
    close_requested: bool,
    initialization: Option<Task<()>>,
    pump: Option<Task<()>>,
    subscriptions: Vec<Subscription>,
}

impl Desktop {
    fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        backend: Arc<Backend>,
        theme: WindowTheme,
        sender: Sender<UiMessage>,
    ) -> Self {
        let mut desktop = Self {
            webview: None,
            backend,
            sender,
            session: None,
            skill_picker_open: false,
            desired_fullscreen: None,
            fullscreen_transition: None,
            theme,
            startup_error: None,
            initializing: true,
            close_requested: false,
            initialization: None,
            pump: None,
            subscriptions: Vec::new(),
        };
        desktop
            .subscriptions
            .push(cx.observe_window_bounds(window, |view, window, _| {
                let _ = view.reconcile_fullscreen(window);
                if let Some(webview) = &view.webview {
                    if webview.set_bounds(webview_bounds(window)).is_err() {
                        view.backend
                            .diagnostics
                            .record("host: WebView resize failed");
                    }
                    // Wry's child-view path does not install its parent subclass.
                    // Notify WebView2 as the parent moves (including monitor/DPI changes).
                    unsafe {
                        let _ = webview.controller().NotifyParentWindowPositionChanged();
                    }
                }
            }));
        desktop
            .subscriptions
            .push(cx.observe_window_activation(window, |view, window, _| {
                if window.is_window_active() {
                    if let Some(webview) = &view.webview {
                        let _ = webview.focus();
                    }
                }
            }));
        desktop.subscriptions.push(cx.observe_window_appearance(window, |view, window, cx| {
            view.apply_background(window);
            view.emit(json!({"channel":"ipc-api:event","args":["system.native_theme_updated",system_theme(window)]}));
            cx.notify();
        }));
        let _ = native_window::set_minimum_size(window, 900., 600.);
        desktop
    }

    fn initialize(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
        data_dir: PathBuf,
        smoke_arguments: Option<String>,
        receiver: Receiver<UiMessage>,
    ) {
        self.initialization = Some(cx.spawn_in(window, async move |view, cx| {
            let startup = view.update_in(cx, |view, window, _| {
                if view.close_requested {
                    view.initializing = false;
                    view.close();
                    window.remove_window();
                    return None;
                }
                // SAFETY: this foreground task stays on the HWND's UI thread.
                // request_close defers parent destruction while initializing;
                // build_webview consumes the snapshot before that gate opens.
                let parent = unsafe { native_window::StartupParent::capture(window) };
                Some((
                    parent,
                    view.backend.clone(),
                    view.sender.clone(),
                    webview_bounds(window),
                    view.theme.color(is_dark(window)),
                ))
            });
            let Ok(Some((parent, backend, sender, bounds, color))) = startup else {
                return;
            };
            backend.diagnostics.record("host: creating WebView2");
            // Wry runs a nested Win32 message pump here. No GPUI App, Window,
            // or entity borrow may span this call: its callbacks need all three.
            let webview = parent.and_then(|parent| {
                Self::build_webview(
                    parent,
                    &backend,
                    sender,
                    data_dir,
                    bounds,
                    color,
                    smoke_arguments,
                )
            });
            let _ = view.update_in(cx, move |view, window, cx| {
                view.initializing = false;
                if view.close_requested {
                    // The snapshot is gone; destroy any child before its parent.
                    drop(webview);
                    view.close();
                    window.remove_window();
                    return;
                }
                let webview = webview.and_then(|webview| {
                    // Resize and appearance can change during the native pump.
                    webview
                        .set_bounds(webview_bounds(window))
                        .map_err(|error| error.to_string())?;
                    webview
                        .set_background_color(view.theme.color(is_dark(window)))
                        .map_err(|error| error.to_string())?;
                    webview
                        .set_visible(true)
                        .map_err(|error| error.to_string())?;
                    Ok(webview)
                });
                match webview {
                    Ok(webview) => {
                        if window.is_window_active() {
                            let _ = webview.focus();
                        }
                        view.webview = Some(webview);
                        view.backend.diagnostics.record("host: WebView2 created");
                        // Initial navigation and subscribe messages remain queued
                        // until the child exists and can receive their replies.
                        view.start_pump(window, cx, receiver);
                    }
                    Err(error) => {
                        view.backend
                            .diagnostics
                            .record("host: WebView2 initialization failed");
                        view.startup_error = Some(format!("TinyCherry could not initialize WebView2. Verify that the Microsoft Edge WebView2 Runtime is installed.\n\n{error}"));
                    }
                }
                cx.notify();
            });
        }));
    }

    fn start_pump(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
        receiver: Receiver<UiMessage>,
    ) {
        let diagnostics = self.backend.diagnostics.clone();
        self.pump = Some(cx.spawn_in(window, async move |view, cx| {
            diagnostics.record("host: renderer dispatch started");
            let mut processed = 0_u8;
            while let Ok(message) = receiver.recv().await {
                if view
                    .update_in(cx, |view, window, cx| view.receive(message, window, cx))
                    .is_err()
                {
                    diagnostics.record("host: renderer dispatch lost its window");
                    break;
                }
                processed += 1;
                if processed == 32 {
                    // An always-ready stream must not starve the native Windows
                    // message pump, input, paints, or WebView2's own callbacks.
                    cx.background_executor()
                        .timer(Duration::from_millis(1))
                        .await;
                    processed = 0;
                }
            }
        }));
    }

    fn build_webview(
        parent: native_window::StartupParent,
        backend: &Arc<Backend>,
        sender: Sender<UiMessage>,
        data_dir: PathBuf,
        bounds: wry::Rect,
        color: (u8, u8, u8, u8),
        smoke_arguments: Option<String>,
    ) -> Result<Rc<WebView>, String> {
        let mut context = wry::WebContext::new(Some(data_dir.join("webview")));
        let budget = RequestBudget::default();
        let diagnostics = backend.diagnostics.clone();
        let asset_diagnostics = backend.diagnostics.clone();
        let weak_view = Rc::new(RefCell::new(Weak::<WebView>::new()));
        let ipc_view = weak_view.clone();
        let page_sender = sender.clone();
        let mut builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(frontend_url())
            .with_bounds(bounds)
            .with_visible(false)
            .with_focused(false)
            .with_background_color(color)
            .with_clipboard(true)
            .with_devtools(cfg!(any(debug_assertions, feature = "inspection")))
            .with_custom_protocol("tauri".into(), move |_, request| {
                let response =
                    assets::respond(request.method().as_str(), &request.uri().to_string());
                if response.status != 200 {
                    asset_diagnostics.record(&format!(
                        "host: frontend asset response status {}",
                        response.status
                    ));
                } else if response.content_type.starts_with("text/html") {
                    asset_diagnostics.record("host: frontend document served");
                }
                wry::http::Response::builder()
                    .status(response.status)
                    .header("Content-Type", response.content_type)
                    .header("Content-Security-Policy", assets::CSP)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Referrer-Policy", "no-referrer")
                    .header("Cache-Control", "no-cache")
                    .body(Cow::Borrowed(response.body))
                    .expect("fixed asset response headers")
            })
            .with_navigation_handler(|raw| {
                url::Url::parse(&raw)
                    .ok()
                    .is_some_and(|url| trusted_origin(&url))
            })
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_on_page_load_handler(move |event, _| {
                if matches!(event, wry::PageLoadEvent::Started) {
                    let _ = page_sender.try_send(UiMessage::NavigationStarted);
                }
            })
            .with_ipc_handler(move |incoming| {
                let request =
                    match bridge::parse_request(&incoming.uri().to_string(), incoming.body()) {
                        Ok(request) => request,
                        Err(_) => {
                            diagnostics.record("host: rejected invalid WebView IPC");
                            return;
                        }
                    };
                let reject = |request: &Request| {
                    if let Some(view) = ipc_view.borrow().upgrade() {
                        let _ = view.evaluate_script(&bridge::reply_script(
                            request,
                            Err("EVOSTACK_BUSY: request was not queued".into()),
                        ));
                    }
                };
                let Some(permit) = budget.acquire() else {
                    reject(&request);
                    return;
                };
                if let Err(error) = sender.try_send(UiMessage::Request(request, permit)) {
                    if let UiMessage::Request(request, _) = error.into_inner() {
                        reject(&request);
                    }
                }
            });
        if let Some(arguments) = smoke_arguments {
            builder = builder.with_additional_browser_args(arguments);
        }
        let webview = Rc::new(
            builder
                .build_as_child(&parent)
                .map_err(|error| error.to_string())?,
        );
        *weak_view.borrow_mut() = Rc::downgrade(&webview);
        #[cfg(any(debug_assertions, feature = "inspection"))]
        if std::env::var_os("TINYCHERRY_EVOSTACK_DEVTOOLS").is_some() {
            webview.open_devtools();
        }
        Ok(webview)
    }

    fn receive(&mut self, message: UiMessage, window: &mut Window, cx: &mut Context<Self>) {
        if self.webview.is_none() {
            return;
        }
        match message {
            UiMessage::Request(request, permit) => self.request(request, permit, window, cx),
            UiMessage::Reply(request, result, _permit) => self.reply(&request, result),
            UiMessage::Event(session, event) if self.session.as_deref() == Some(&session) => {
                self.emit(event)
            }
            UiMessage::Theme(theme) => {
                self.theme = theme;
                self.apply_background(window);
                cx.notify();
            }
            UiMessage::NavigationStarted => {
                self.backend
                    .diagnostics
                    .record("host: renderer navigation started");
                self.session = None;
                self.backend.events.lock().unwrap().take();
            }
            _ => {}
        }
    }

    fn request(
        &mut self,
        request: Request,
        permit: RequestPermit,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if request.command == "subscribe" {
            self.backend.diagnostics.record("host: renderer subscribed");
            self.session = Some(request.session.clone());
            let sender = self.sender.clone();
            let session = request.session.clone();
            *self.backend.events.lock().unwrap() = Some(EventChannel::new(move |event| {
                sender
                    .send_blocking(UiMessage::Event(session.clone(), event))
                    .map_err(|_| "EVOSTACK_RENDERER_CLOSED".into())
            }));
            self.reply(&request, Ok(Value::Null));
            if !self.backend.alive.load(Ordering::Acquire) {
                self.emit(json!({"channel":"evostack:backend-exited","args":[]}));
            }
            return;
        }
        if self.session.as_deref() != Some(&request.session) {
            // A document must subscribe before issuing operations. Stale queued
            // requests from a previous document are never replayed into its successor.
            self.reply(&request, Err("EVOSTACK_RENDERER_SESSION_EXPIRED".into()));
            return;
        }
        let local = match request.command.as_str() {
            "desktop_info" => Some(Ok(platform::info())),
            "start_dragging" => Some(native_window::start_dragging(window).map(|_| Value::Null)),
            "ipc_request" => {
                let channel = request.args["channel"].as_str().unwrap();
                let args = request.args["args"].as_array().unwrap();
                if channel == "evostack:zoom" {
                    let factor = args
                        .first()
                        .and_then(Value::as_f64)
                        .unwrap_or(1.)
                        .clamp(0.5, 2.);
                    Some(
                        self.webview
                            .as_ref()
                            .unwrap()
                            .zoom(factor)
                            .map(|_| Value::Null)
                            .map_err(|e| e.to_string()),
                    )
                } else if channel == "ipc-api:request" {
                    let route = args.first().and_then(Value::as_str).unwrap_or("");
                    if let Some(kind) = match route {
                        "skill.install_from_zip" => Some("zip"),
                        "skill.install_from_directory" => Some("directory"),
                        _ => None,
                    } {
                        if !skill_picker_has_no_input(args) {
                            self.reply(
                                &request,
                                Ok(desktop_response(Err(
                                    "EVOSTACK_INVALID_SKILL_SELECTION".into()
                                ))),
                            );
                        } else {
                            self.pick_skill(request, permit, kind, window, cx);
                        }
                        return;
                    }
                    self.window_request(route, args.get(1).unwrap_or(&Value::Null), window, cx)
                        .map(|reply| Ok(desktop_response(reply)))
                } else {
                    None
                }
            }
            _ => Some(Err("EVOSTACK_INVALID_COMMAND".into())),
        };
        if let Some(result) = local {
            self.reply(&request, result);
            return;
        }
        let backend = self.backend.clone();
        let sender = self.sender.clone();
        // Blocking pipe IO and native computer-control operations never hold the
        // GPUI entity lease or the Windows message pump. Permits bound workers.
        std::thread::spawn(move || {
            let result = background_request(&backend, &request.args);
            let _ = sender.send_blocking(UiMessage::Reply(request, result, permit));
        });
    }

    fn pick_skill(
        &mut self,
        request: Request,
        permit: RequestPermit,
        kind: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.skill_picker_open {
            self.reply(
                &request,
                Ok(desktop_response(Err("EVOSTACK_SKILL_PICKER_BUSY".into()))),
            );
            return;
        }
        self.skill_picker_open = true;
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: kind == "zip",
            directories: kind == "directory",
            multiple: false,
            prompt: Some("Import a TinyCherry skill".into()),
        });
        let backend = self.backend.clone();
        let sender = self.sender.clone();
        cx.spawn_in(window, async move |view, cx| {
            let selection = selection.await;
            let current = view
                .update_in(cx, |view, _, _| {
                    view.skill_picker_open = false;
                    !view.close_requested && view.session.as_deref() == Some(&request.session)
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let result = match selection {
                Ok(Ok(None)) => Ok(json!({"cancelled": true})),
                Ok(Ok(Some(paths))) if paths.len() == 1 => {
                    if let Some(path) = paths[0].to_str().map(str::to_owned) {
                        cx.background_executor()
                            .spawn(async move {
                                backend.request(
                                    "skill.import_selected",
                                    json!({"kind":kind,"path":path}),
                                )
                            })
                            .await
                    } else {
                        Err("EVOSTACK_INVALID_SKILL_SELECTION".into())
                    }
                }
                _ => Err("EVOSTACK_SKILL_PICKER_FAILED".into()),
            };
            let _ = sender
                .send(UiMessage::Reply(
                    request,
                    Ok(desktop_response(result)),
                    permit,
                ))
                .await;
        })
        .detach();
    }

    fn window_request(
        &mut self,
        route: &str,
        input: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Reply> {
        let null = |value: Result<(), String>| value.map(|_| Value::Null);
        Some(match route {
            "window.get_init_data" => Ok(Value::Null),
            "window.is_maximized" => Ok(json!(native_window::is_maximized(window))),
            "window.is_full_screen" => Ok(json!(native_window::is_fullscreen(window))),
            "window.close" => {
                // Defer until the close acknowledgement has been submitted, and
                // destroy the child WebView before removing its parent HWND.
                cx.defer_in(window, |view, window, _| {
                    view.close();
                    window.remove_window();
                });
                Ok(Value::Null)
            }
            "window.minimize" => null(native_window::minimize(window)),
            "window.maximize" => null(native_window::set_maximized(window, true)),
            "window.unmaximize" => null(native_window::set_maximized(window, false)),
            "window.set_full_screen" => {
                self.desired_fullscreen = Some(input.as_bool().unwrap_or(false));
                null(self.reconcile_fullscreen(window))
            }
            "window.main.reset_minimum_size" => {
                null(native_window::set_minimum_size(window, 900., 600.))
            }
            "window.main.set_minimum_size" => null(native_window::set_minimum_size(
                window,
                input["width"].as_f64().unwrap_or(900.),
                input["height"].as_f64().unwrap_or(600.),
            )),
            "window.main.reload" => {
                cx.defer_in(window, |view, _, _| {
                    if let Some(webview) = &view.webview {
                        let _ = webview.reload();
                    }
                });
                Ok(Value::Null)
            }
            "system.get_native_theme" => Ok(json!(system_theme(window))),
            "system.get_device_type" => Ok(json!("desktop")),
            "system.toggle_dev_tools" => {
                #[cfg(any(debug_assertions, feature = "inspection"))]
                {
                    let webview = self.webview.as_ref().unwrap();
                    if webview.is_devtools_open() {
                        webview.close_devtools();
                    } else {
                        webview.open_devtools();
                    }
                    Ok(Value::Null)
                }
                #[cfg(not(any(debug_assertions, feature = "inspection")))]
                Err("DESKTOP_UNAVAILABLE: developer tools".into())
            }
            _ => return None,
        })
    }

    fn reconcile_fullscreen(&mut self, window: &Window) -> Result<(), String> {
        let actual = native_window::is_fullscreen(window);
        if let Some(in_progress) = self.fullscreen_transition {
            if actual != in_progress {
                return Ok(());
            }
            self.fullscreen_transition = None;
        }
        if let Some(desired) = self.desired_fullscreen {
            if desired == actual {
                self.desired_fullscreen = None;
            } else {
                // GPUI implements fullscreen as an asynchronous toggle. Retain
                // the target until the bounds notification confirms it, then
                // reconcile any newer target instead of toggling twice.
                native_window::set_fullscreen(window, desired)?;
                self.fullscreen_transition = Some(desired);
            }
        }
        Ok(())
    }

    fn reply(&self, request: &Request, result: Reply) {
        if let Some(webview) = &self.webview {
            if webview
                .evaluate_script(&bridge::reply_script(request, result))
                .is_err()
            {
                self.backend
                    .diagnostics
                    .record("host: WebView reply delivery failed");
            }
        }
    }
    fn emit(&self, event: Value) {
        if let (Some(session), Some(webview)) = (&self.session, &self.webview) {
            let script = bridge::event_script(session, event).unwrap_or_else(|_| {
                bridge::event_script(
                    session,
                    json!({"channel":"evostack:backend-exited","args":[]}),
                )
                .unwrap()
            });
            if webview.evaluate_script(&script).is_err() {
                self.backend
                    .diagnostics
                    .record("host: WebView event delivery failed");
            }
        }
    }
    fn apply_background(&self, window: &Window) {
        if let Some(webview) = &self.webview {
            let _ = webview.set_background_color(self.theme.color(is_dark(window)));
        }
    }
    fn request_close(&mut self) -> bool {
        if self.initializing {
            self.close_requested = true;
            return false;
        }
        self.close();
        true
    }
    fn close(&mut self) {
        self.sender.close();
        self.backend.events.lock().unwrap().take();
        self.session = None;
        self.pump.take();
        self.webview.take();
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.close();
    }
}
impl Render for Desktop {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (r, g, b, _) = self.theme.color(is_dark(window));
        div()
            .size_full()
            .bg(rgb((u32::from(r) << 16)
                | (u32::from(g) << 8)
                | u32::from(b)))
            .when(self.initializing, |view| {
                view.p_8()
                    .text_color(rgb(0x808080))
                    .child(if self.close_requested {
                        "Closing TinyCherry…"
                    } else {
                        "Starting TinyCherry…"
                    })
            })
            .when_some(self.startup_error.clone(), |view, error| {
                view.p_8().text_color(rgb(0xb00020)).child(error)
            })
    }
}

fn webview_bounds(window: &Window) -> wry::Rect {
    let size = window.viewport_size();
    wry::Rect {
        position: LogicalPosition::new(0., 0.).into(),
        size: LogicalSize::new(
            f64::from(size.width).max(1.),
            f64::from(size.height).max(1.),
        )
        .into(),
    }
}
fn is_dark(window: &Window) -> bool {
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}
fn system_theme(window: &Window) -> &'static str {
    if is_dark(window) {
        "dark"
    } else {
        "light"
    }
}
fn frontend_url() -> String {
    if cfg!(debug_assertions) {
        format!("http://127.0.0.1:17420/{FRONTEND_PATH}")
    } else {
        format!("tauri://localhost/{FRONTEND_PATH}")
    }
}

fn background_request(backend: &Backend, envelope: &Value) -> Reply {
    let channel = envelope["channel"].as_str().ok_or("Missing channel")?;
    let args = envelope["args"].as_array().ok_or("Missing arguments")?;
    // Local revocation still precedes the backend's authoritative preference
    // update and never waits behind its SQLite/AI request queue.
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
        let input = args.get(1).unwrap_or(&Value::Null);
        if let Some(result) = desktop_request(backend, route, input) {
            return Ok(desktop_response(result));
        }
    }
    if channel == "evostack:renderer-ready" {
        let phase = args
            .first()
            .and_then(Value::as_str)
            .ok_or("Missing renderer phase")?;
        if !matches!(phase, "onboarding" | "workspace") {
            return Err("EVOSTACK_INVALID_RENDERER_PHASE".into());
        }
        backend
            .diagnostics
            .record("host: React renderer ready (GPUI + Wry)");
        if let Ok(token) = std::env::var("TINYCHERRY_EVOSTACK_SMOKE_TOKEN") {
            std::fs::write(backend.data_dir.join("renderer-ready.json"), serde_json::to_vec(&json!({"token":token,"pid":std::process::id(),"phase":phase,"build":build_info()})).map_err(|_| "EVOSTACK_RENDERER_HANDSHAKE_FAILED")?)
                .map_err(|_| "EVOSTACK_RENDERER_HANDSHAKE_FAILED")?;
        }
        return Ok(Value::Null);
    }
    backend.request("ipc.invoke", json!({"channel":channel,"args":args}))
}

fn desktop_request(backend: &Backend, route: &str, input: &Value) -> Option<Reply> {
    if matches!(
        route,
        "computer_use.stop_all" | "computer_use.stop_app" | "computer_use.revoke_approval"
    ) {
        let cancelled = backend.request_with_timeout(
            "ipc.invoke",
            json!({"channel":"ipc-api:request","args":[route,input]}),
            Duration::from_secs(5),
        );
        let native = backend.controls.request(route, input)?;
        return Some(match (cancelled, native) {
            (Ok(reply), Ok(value)) if reply["ok"] == true => Ok(value),
            (_, Err(error)) => Err(error),
            _ => Err("EVOSTACK_APPROVAL_REVOCATION_UNCONFIRMED".into()),
        });
    }
    if let Some(result) = backend.controls.request(route, input) {
        return Some(result);
    }
    Some(match route {
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
            "version":build_info()["version"],"platform":platform::name(),"arch":platform::info()["arch"],"isPackaged":!cfg!(debug_assertions),
            "appPath":std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.to_path_buf())),
            "resourcesPath":backend.data_dir,"userDataPath":backend.data_dir,"logsPath":backend.data_dir,
            "homePath":backend.data_dir,"notesPath":backend.data_dir,"configPath":backend.data_dir,
            "appDataPath":backend.data_dir,"isPortable":true,"canCheckForUpdates":false,
            "installPath":std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.to_path_buf()))
        })),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_picker_accepts_void_ipc_and_rejects_extra_data() {
        let route = json!("skill.install_from_zip");
        let null = Value::Null;
        assert!(skill_picker_has_no_input(&[
            route.clone(),
            null.clone(),
            null.clone()
        ]));
        assert!(!skill_picker_has_no_input(&[
            route.clone(),
            json!({"path":"fixture.zip"}),
            null.clone()
        ]));
        assert!(!skill_picker_has_no_input(&[
            route.clone(),
            null,
            json!({"path":"fixture.zip"})
        ]));
        assert!(!skill_picker_has_no_input(&[
            route,
            Value::Null,
            Value::Null,
            Value::Null
        ]));
    }
}
