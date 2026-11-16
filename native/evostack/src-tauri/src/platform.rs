use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn name() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub fn sibling(name: &str) -> Result<PathBuf, String> {
    let path = sibling_path(name)?;
    if !Path::new(&path).is_file() {
        return Err(format!("DESKTOP_HELPER_MISSING: {name}"));
    }
    Ok(path)
}

pub fn sibling_path(name: &str) -> Result<PathBuf, String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("DESKTOP_UNAVAILABLE: native helpers on this platform".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = executable
        .parent()
        .ok_or("Executable parent missing")?
        .join(name);
    Ok(path)
}

pub fn info() -> Value {
    let build = crate::host::build_info();
    json!({
        "platform": name(), "arch": if cfg!(target_arch = "x86_64") {"x64"} else {std::env::consts::ARCH},
        "version": build["version"], "revision": build["revision"], "protocol": build["protocol"],
        "capabilities": {
            "chat": true, "knowledge": true, "prompts": true, "skills": true,
            "computerUse": cfg!(all(target_os = "windows", target_arch = "x86_64")),
            "markdownPreview": true, "notifications": true, "archives": true,
            "agents": false, "mcp": false, "attachments": false, "backups": false,
            "browser": false, "painting": false, "translation": false, "downloads": false,
            "globalShortcuts": false, "extraWindows": false, "skillExecution": false
        }
    })
}
