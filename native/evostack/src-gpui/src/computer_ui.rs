use super::*;

pub(super) fn app_keys(app: &Value) -> Vec<String> {
    let mut keys = vec![format!(
        "name:{}",
        app["name"].as_str().unwrap_or("").to_lowercase()
    )];
    if let Some(identity) = app["identity"].as_str().filter(|id| !id.is_empty()) {
        keys.push(format!("identity:{}", identity.to_lowercase()));
    }
    keys
}

pub(super) fn ensure_app_available(task: &Task, session: &str) -> Result<(), ControlError> {
    if task.cancelled.load(Ordering::Acquire) {
        return Err(closed());
    }
    let app_id = task.sessions.lock().unwrap().get(session).cloned();
    if app_id.as_ref().is_some_and(|id| {
        task.apps
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|app| matches!(app.status, "stopping" | "stopped" | "unconfirmed"))
    }) {
        return Err(ControlError::new(
            "USER_STOPPED",
            "The user stopped this application's control in this turn",
        ));
    }
    Ok(())
}

impl Controller {
    pub(super) fn approval_app(&self, input: &Value) -> ControlResult {
        object_fields(input, &["operation", "epoch", "taskId", "ownerId", "appId"])?;
        let (_, task) = self.task(input)?;
        let app_id = string(input, "appId")?;
        let app = task
            .known_apps
            .lock()
            .unwrap()
            .get(&app_id)
            .cloned()
            .ok_or_else(|| {
                ControlError::new(
                    "UNKNOWN_APP",
                    "Select an application discovered in this desktop task",
                )
            })?;
        if !app["identity"]
            .as_str()
            .is_some_and(|value| !value.is_empty() && value.encode_utf16().count() <= 512)
        {
            return Err(ControlError::new(
                "APPROVAL_UNAVAILABLE",
                "Application approval requires a stable native identity",
            ));
        }
        {
            let mut apps = task.apps.lock().unwrap();
            if apps.get(&app_id).is_some_and(|control| {
                matches!(control.status, "stopping" | "stopped" | "unconfirmed")
            }) {
                return Err(ControlError::new(
                    "USER_STOPPED",
                    "The user stopped this application's control",
                ));
            }
            // Register the pending target before the prompt so Stop App also
            // revokes an opening that has not reached the native helper yet.
            apps.entry(app_id).or_insert_with(|| AppControl {
                app: app.clone(),
                status: "opening",
                opening: false,
            });
        }
        self.emit_controls();
        Ok(app)
    }

    pub fn set_control_events(&self, send: ControlEvents) {
        *self.control_events.lock().unwrap() = Some(send);
    }

    pub(super) fn emit_controls(&self) {
        let send = self.control_events.lock().unwrap().clone();
        if let Some(send) = send {
            send(self.controls());
        }
    }

    fn controls(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut controls = Vec::new();
        for task in state.tasks.values() {
            let apps = task.apps.lock().unwrap();
            let status = |actual: &str| {
                if task.cleanup_unconfirmed.load(Ordering::Acquire) {
                    "unconfirmed".to_owned()
                } else if task.cancelled.load(Ordering::Acquire) {
                    "stopping".to_owned()
                } else {
                    actual.to_owned()
                }
            };
            if apps.is_empty() {
                controls.push(json!({"ownerId":task.owner,"label":task.label,"status":status(if task.initialized.load(Ordering::Acquire) {"active"} else {"opening"})}));
            }
            for (id, control) in apps.iter() {
                let mut row = json!({"ownerId":task.owner,"label":task.label,"appId":id,"appName":control.app["name"],"status":status(control.status)});
                if let Some(identity) = control.app["identity"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 512)
                {
                    row["appIdentity"] = json!(identity);
                }
                controls.push(row);
            }
        }
        controls.sort_by_key(|row| {
            (
                row["ownerId"].as_str().unwrap_or("").to_owned(),
                row["appId"].as_str().unwrap_or("").to_owned(),
            )
        });
        json!(controls)
    }

    fn stop_all_controls(&self) -> ControlResult {
        let tasks = {
            let mut state = self.state.lock().unwrap();
            // Includes grants whose first native call has not arrived yet. A late
            // model acknowledgement cannot resurrect work after this user stop.
            state.global_version = state.global_version.saturating_add(1);
            state.grants.clear();
            state
                .tasks
                .iter()
                .map(|(id, task)| (id.clone(), task.clone()))
                .collect::<Vec<_>>()
        };
        for (_, task) in &tasks {
            task.cancel();
        }
        self.emit_controls();
        let results = std::thread::scope(|scope| {
            let workers = tasks
                .iter()
                .map(|(id, _)| scope.spawn(move || self.close_task(id)))
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| {
                    worker.join().unwrap_or_else(|_| {
                        Err(ControlError::uncertain(
                            "CLEANUP_UNCONFIRMED",
                            "Desktop cleanup worker failed",
                            "possible",
                        ))
                    })
                })
                .collect::<Vec<_>>()
        });
        for result in results {
            if let Err(error) = result {
                let mut state = self.state.lock().unwrap();
                state.cleanup_blocked = true;
                state.enabled = false;
                return Err(error);
            }
        }
        Ok(Value::Null)
    }

    fn stop_app_control(&self, owner: &str, app_id: &str) -> ControlResult {
        let tasks = {
            let state = self.state.lock().unwrap();
            state
                .tasks
                .iter()
                .filter(|(_, task)| {
                    task.owner == owner && task.apps.lock().unwrap().contains_key(app_id)
                })
                .map(|(id, task)| (id.clone(), task.clone()))
                .collect::<Vec<_>>()
        };
        for (id, task) in tasks {
            {
                let mut apps = task.apps.lock().unwrap();
                let Some(app) = apps.get_mut(app_id) else {
                    continue;
                };
                if app.status == "stopped" {
                    continue;
                }
                app.status = "stopping";
            }
            let stopped_sessions = task
                .sessions
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, app)| *app == app_id)
                .map(|(session, _)| session.clone())
                .collect::<HashSet<_>>();
            task.snapshots
                .lock()
                .unwrap()
                .retain(|session, _| !stopped_sessions.contains(session));
            self.emit_controls();
            let deadline = Instant::now() + CALL_TIMEOUT + Duration::from_secs(2);
            let session = loop {
                let session = task
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .find_map(|(session, app)| (app == app_id).then(|| session.clone()));
                if session.is_some() {
                    break session;
                }
                let opening = task
                    .apps
                    .lock()
                    .unwrap()
                    .get(app_id)
                    .is_some_and(|app| app.opening);
                if !opening || task.cancelled.load(Ordering::Acquire) {
                    break None;
                }
                if Instant::now() >= deadline {
                    self.close_task(&id)?;
                    return Err(ControlError::uncertain(
                        "CLEANUP_UNCONFIRMED",
                        "Application opening did not settle before stop; the owned task was closed",
                        "possible",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            if task.cancelled.load(Ordering::Acquire) {
                self.close_task(&id)?;
                continue;
            }
            let result = (|| {
                if let Some(session) = &session {
                    let runtime = task.runtime.lock().unwrap().clone().ok_or_else(closed)?;
                    let ack =
                        runtime.call("stopAppSession", json!({"appSessionId":session}), "none")?;
                    if ack["appSessionId"] != *session
                        || ack["status"] != "stopped"
                        || ack["cleanup"] != "complete"
                    {
                        return Err(ControlError::uncertain(
                            "CLEANUP_UNCONFIRMED",
                            "Application stop acknowledgement did not confirm the owned session",
                            "possible",
                        ));
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                if let Some(app) = task.apps.lock().unwrap().get_mut(app_id) {
                    app.status = "unconfirmed";
                }
                self.emit_controls();
                self.close_task(&id)?;
                return Err(error);
            }
            if let Some(session) = &session {
                task.sessions.lock().unwrap().remove(session);
                task.snapshots.lock().unwrap().remove(session);
            }
            let retained = {
                let mut apps = task.apps.lock().unwrap();
                if let Some(app) = apps.get_mut(app_id) {
                    app.opening = false;
                    app.status = "stopped";
                }
                apps.values()
                    .filter(|app| app.status != "stopped")
                    .flat_map(|app| app_keys(&app.app))
                    .collect::<HashSet<_>>()
            };
            self.state
                .lock()
                .unwrap()
                .app_owners
                .retain(|key, owner| owner != &id || retained.contains(key));
            self.emit_controls();
        }
        Ok(Value::Null)
    }

    fn app_icon(&self, identity: &str) -> ControlResult {
        let _standalone = self.standalone.lock().unwrap();
        let runtime = self.start_standalone()?;
        let result = (|| {
            runtime.initialize()?;
            let result = runtime.call("getAppIcon", json!({"identity":identity}), "none")?;
            match result["status"].as_str() {
                Some("unavailable") => Ok(json!({"status":"unavailable"})),
                Some("available") => {
                    let icon = &result["icon"];
                    let data = icon["dataBase64"].as_str().ok_or_else(invalid)?;
                    let content = data.trim_end_matches('=');
                    if icon["mimeType"] != "image/png"
                        || data.is_empty()
                        || data.len() > 65536
                        || data.len() % 4 != 0
                        || data.len() - content.len() > 2
                        || !content
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
                    {
                        return Err(invalid());
                    }
                    Ok(
                        json!({"status":"available","icon":{"mimeType":"image/png","dataBase64":data}}),
                    )
                }
                _ => Err(invalid()),
            }
        })();
        let cleanup = self.finish_standalone(&runtime);
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }

    pub(super) fn control_request(
        &self,
        route: &str,
        input: &Value,
    ) -> Option<Result<Value, String>> {
        let operation = match route {
            "computer_use.get_controls" if input.is_null() => Ok(self.controls()),
            "computer_use.stop_all" if input.is_null() => self.stop_all_controls(),
            "computer_use.stop_app" => object_fields(input, &["ownerId", "appId"]).and_then(|_| {
                let owner = string(input, "ownerId")?;
                let app = string(input, "appId")?;
                self.stop_app_control(&owner, &app)
            }),
            "computer_use.get_app_icon" => object_fields(input, &["identity"]).and_then(|_| {
                let identity = input["identity"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 512)
                    .ok_or_else(invalid)?;
                self.app_icon(identity)
            }),
            "computer_use.get_call_apps" => {
                return Some(Err(
                    "EVOSTACK_NOT_MIGRATED: Automation REPL call applications".into(),
                ))
            }
            "computer_use.get_controls" | "computer_use.stop_all" => Err(invalid()),
            _ => return None,
        };
        Some(operation.map_err(|error| format!("{}: {}", error.code, error.message)))
    }
}
