use serde_json::Value;
use std::sync::Mutex;
use tauri::{window::Color, AppHandle, Manager, Theme, WebviewWindow};

pub(crate) const THEME_PREFERENCE: &str = "ui.theme_mode";

#[derive(Clone, Copy)]
pub(crate) enum WindowTheme {
    System,
    Light,
    Dark,
}

impl WindowTheme {
    pub(crate) fn from_preference(mode: Option<&str>) -> Self {
        match mode {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            _ => Self::System,
        }
    }

    fn color(self, system: Option<Theme>) -> Color {
        match self {
            Self::Dark => Color(31, 31, 31, 255),
            Self::System if system == Some(Theme::Dark) => Color(31, 31, 31, 255),
            _ => Color(255, 255, 255, 255),
        }
    }
}

pub(crate) fn apply(window: &WebviewWindow, system: Option<Theme>) {
    let state = window.state::<Mutex<WindowTheme>>();
    let color = state.lock().unwrap().color(system);
    // Paint the native client area while WebView2 prepares its next frame.
    let _ = window.as_ref().window().set_background_color(Some(color));
}

pub(crate) fn preference_changed(app: &AppHandle, event: &Value) {
    if event["channel"] != "preference:changed" || event["args"][0] != THEME_PREFERENCE {
        return;
    }
    let theme = WindowTheme::from_preference(event["args"][1].as_str());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        *handle.state::<Mutex<WindowTheme>>().lock().unwrap() = theme;
        if let Some(window) = handle.get_webview_window("main") {
            apply(&window, window.theme().ok());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_follows_explicit_and_system_themes() {
        let color = |preference, os| WindowTheme::from_preference(preference).color(os).0;
        assert_eq!(color(Some("dark"), Some(Theme::Light)), 31);
        assert_eq!(color(Some("light"), Some(Theme::Dark)), 255);
        assert_eq!(color(Some("system"), Some(Theme::Dark)), 31);
        assert_eq!(color(Some("system"), Some(Theme::Light)), 255);
        assert_eq!(color(Some("auto"), Some(Theme::Dark)), 31);
        assert_eq!(color(None, None), 255);
    }
}
