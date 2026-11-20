//! Read-only embedded frontend. No path in a URL is ever opened on the filesystem.
use percent_encoding::percent_decode_str;

pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

struct Asset {
    path: &'static str,
    content: &'static [u8],
}
include!(concat!(env!("OUT_DIR"), "/frontend_assets.rs"));

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: &'static [u8],
}

pub fn respond(method: &str, raw_url: &str) -> Response {
    lookup(EMBEDDED_ASSETS, method, raw_url)
}

fn lookup(assets: &[Asset], method: &str, raw_url: &str) -> Response {
    let error = |status| Response {
        status,
        content_type: "text/plain; charset=utf-8",
        body: b"",
    };
    if !matches!(method, "GET" | "HEAD") {
        return error(405);
    }
    let Ok(url) = url::Url::parse(raw_url) else {
        return error(400);
    };
    if !crate::host::trusted_origin(&url)
        || url.scheme() == "file"
        || !matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
    {
        return error(403);
    }
    let Ok(path) = percent_decode_str(url.path()).decode_utf8() else {
        return error(400);
    };
    if path.contains(['\\', '\0']) || path.split('/').any(|part| matches!(part, "." | "..")) {
        return error(400);
    }
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() {
        "windows/evostack/index.html"
    } else {
        path
    };
    let Some(asset) = assets.iter().find(|asset| asset.path == path) else {
        return error(404);
    };
    Response {
        status: 200,
        content_type: mime(path),
        body: if method == "HEAD" { b"" } else { asset.content },
    }
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURES: &[Asset] = &[
        Asset {
            path: "windows/evostack/index.html",
            content: b"<!doctype html>",
        },
        Asset {
            path: "assets/chat.js",
            content: b"export default 1",
        },
        Asset {
            path: "assets/chat.woff2",
            content: b"font",
        },
    ];
    #[test]
    fn embedded_assets_have_the_types_required_by_modules_and_fonts() {
        let js = lookup(FIXTURES, "GET", "tauri://localhost/assets/chat.js?v=1");
        assert_eq!(js.status, 200);
        assert_eq!(js.content_type, "text/javascript; charset=utf-8");
        assert_eq!(js.body, b"export default 1");
        assert_eq!(
            lookup(FIXTURES, "HEAD", "http://tauri.localhost/assets/chat.woff2").content_type,
            "font/woff2"
        );
        assert!(
            lookup(FIXTURES, "HEAD", "http://tauri.localhost/assets/chat.js")
                .body
                .is_empty()
        );
        assert_eq!(
            lookup(FIXTURES, "GET", "http://tauri.localhost/").status,
            200
        );
    }
    #[test]
    fn unknown_paths_never_fall_back_to_html_or_local_files() {
        for path in [
            "assets/missing.js",
            "%2e%2e%2fpackage.json",
            "assets%5cchat.js",
            "C:%5cWindows%5cwin.ini",
            "assets/chat.js%00",
        ] {
            assert!(lookup(FIXTURES, "GET", &format!("tauri://localhost/{path}")).status >= 400);
        }
        assert_eq!(
            lookup(FIXTURES, "GET", "tauri://attacker/assets/chat.js").status,
            403
        );
        assert_eq!(
            lookup(FIXTURES, "POST", "tauri://localhost/assets/chat.js").status,
            405
        );
    }
}
