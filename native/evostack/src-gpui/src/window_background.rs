use serde_json::Value;
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
    pub(crate) fn color(self, system_dark: bool) -> (u8, u8, u8, u8) {
        match self {
            Self::Dark => (31, 31, 31, 255),
            Self::System if system_dark => (31, 31, 31, 255),
            _ => (255, 255, 255, 255),
        }
    }
    pub(crate) fn from_event(event: &Value) -> Option<Self> {
        if event["channel"] == "preference:changed" && event["args"][0] == THEME_PREFERENCE {
            Some(Self::from_preference(event["args"][1].as_str()))
        } else {
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_follows_explicit_and_system_themes() {
        let color = |preference, os| WindowTheme::from_preference(preference).color(os).0;
        assert_eq!(color(Some("dark"), false), 31);
        assert_eq!(color(Some("light"), true), 255);
        assert_eq!(color(Some("system"), true), 31);
        assert_eq!(color(Some("system"), false), 255);
        assert_eq!(color(None, true), 31);
    }
}
