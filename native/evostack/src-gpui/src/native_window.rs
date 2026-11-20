//! Windows operations that GPUI 0.2.2 cannot provide directly.
//!
//! Call these functions on the GPUI UI thread. Wry's child WebView and its parent
//! HWND must remain on that thread for their entire lifetime.

#![cfg(target_os = "windows")]

use std::{ffi::c_void, marker::PhantomData, rc::Rc};
use wry::raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};

type Hwnd = *mut c_void;
type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;

const WM_GETMINMAXINFO: u32 = 0x0024;
const WM_NCDESTROY: u32 = 0x0082;
const WM_NCLBUTTONDOWN: u32 = 0x00a1;
const WM_APPLY_MINIMUM_SIZE: u32 = 0x8457;
const HTCAPTION: usize = 2;
const SW_MAXIMIZE: i32 = 3;
const SW_RESTORE: i32 = 9;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const MINIMUM_SIZE_SUBCLASS: usize = 0x5443_4750;

#[repr(C)]
#[derive(Default)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct MinMaxInfo {
    reserved: Point,
    max_size: Point,
    max_position: Point,
    min_track_size: Point,
    max_track_size: Point,
}

struct MinimumSize {
    width: f64,
    height: f64,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ReleaseCapture() -> i32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn PostMessageW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> i32;
    fn ShowWindowAsync(hwnd: Hwnd, command: i32) -> i32;
    fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, flags: u32) -> i32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
    fn IsIconic(hwnd: Hwnd) -> i32;
    fn IsZoomed(hwnd: Hwnd) -> i32;
    fn SetWindowPos(
        hwnd: Hwnd,
        insert_after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
}

#[link(name = "comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(hwnd: Hwnd, callback: SubclassProc, id: usize, data: usize) -> i32;
    fn GetWindowSubclass(hwnd: Hwnd, callback: SubclassProc, id: usize, data: *mut usize) -> i32;
    fn RemoveWindowSubclass(hwnd: Hwnd, callback: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
}

/// A UI-thread-only parent handle for creating Wry outside a GPUI window borrow.
///
/// This snapshot does not own or destroy the native window. Its creator must
/// keep the parent alive until startup has finished and this snapshot is dropped.
pub struct StartupParent {
    raw: RawWindowHandle,
    _ui_thread: PhantomData<Rc<()>>,
}

impl StartupParent {
    /// Capture the HWND without keeping a GPUI `Window` borrow during startup.
    ///
    /// # Safety
    ///
    /// Call on the window's UI thread and keep the parent HWND alive until this
    /// snapshot is dropped. In particular, close requests during Wry's native
    /// message pump must defer parent destruction until the constructor returns.
    /// Drop this snapshot before allowing the deferred close to destroy the parent.
    pub unsafe fn capture(window: &gpui::Window) -> Result<Self, String> {
        let handle = HasWindowHandle::window_handle(window).map_err(|error| error.to_string())?;
        let raw = handle.as_raw();
        if !matches!(raw, RawWindowHandle::Win32(_)) {
            return Err("DESKTOP_WINDOW_HANDLE_UNAVAILABLE".into());
        }
        Ok(Self {
            raw,
            _ui_thread: PhantomData,
        })
    }
}

impl HasWindowHandle for StartupParent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        // SAFETY: capture requires the parent to outlive this snapshot, and the
        // Rc marker prevents using the snapshot from another thread.
        Ok(unsafe { WindowHandle::borrow_raw(self.raw) })
    }
}

fn hwnd(window: &gpui::Window) -> Result<Hwnd, String> {
    // Window::window_handle() is GPUI's own handle, hence the qualified trait call.
    let handle = HasWindowHandle::window_handle(window).map_err(|error| error.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as Hwnd),
        _ => Err("DESKTOP_WINDOW_HANDLE_UNAVAILABLE".into()),
    }
}

fn last_error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

/// Report a launch failure even in a release build without a console window.
pub fn show_startup_error(message: &str) {
    let message: Vec<u16> = message
        .replace('\0', "\u{fffd}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let caption: Vec<u16> = "TinyCherry — startup failed"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            0x10,
        );
    }
}

pub fn start_dragging(window: &gpui::Window) -> Result<(), String> {
    let hwnd = hwnd(window)?;
    // GPUI's start_window_move is currently a no-op on Windows. Release the
    // child view's mouse capture and let the OS perform the native move loop.
    unsafe {
        let mut cursor = Point::default();
        if GetCursorPos(&mut cursor) == 0 {
            return Err(last_error("DESKTOP_WINDOW_DRAG_FAILED"));
        }
        ReleaseCapture();
        let position = (cursor.x as u16 as isize) | ((cursor.y as u16 as isize) << 16);
        if PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, position) == 0 {
            return Err(last_error("DESKTOP_WINDOW_DRAG_FAILED"));
        }
    }
    Ok(())
}

pub fn is_maximized(window: &gpui::Window) -> bool {
    window.is_maximized()
}

pub fn set_maximized(window: &gpui::Window, maximized: bool) -> Result<(), String> {
    let hwnd = hwnd(window)?;
    // GPUI 0.2.2's Windows zoom() only maximizes, despite its toggle-like name.
    // Async dispatch avoids re-entering GPUI during an entity update.
    unsafe {
        if ShowWindowAsync(hwnd, if maximized { SW_MAXIMIZE } else { SW_RESTORE }) == 0 {
            return Err(last_error("DESKTOP_WINDOW_STATE_FAILED"));
        }
    }
    Ok(())
}

pub fn minimize(window: &gpui::Window) -> Result<(), String> {
    window.minimize_window();
    Ok(())
}

pub fn is_fullscreen(window: &gpui::Window) -> bool {
    window.is_fullscreen()
}

pub fn set_fullscreen(window: &gpui::Window, fullscreen: bool) -> Result<(), String> {
    if window.is_fullscreen() != fullscreen {
        window.toggle_fullscreen();
    }
    Ok(())
}

fn track_size(hwnd: Hwnd, size: &MinimumSize) -> Point {
    let mut outer = Rect::default();
    let mut client = Rect::default();
    // Query the real non-client border rather than assuming the system caption
    // height: this window has a custom React title bar. Recompute for each
    // WM_GETMINMAXINFO so moving between monitors honors the destination DPI.
    let (scale, border_width, border_height) = unsafe {
        let dpi = GetDpiForWindow(hwnd);
        let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
        let has_rects =
            GetWindowRect(hwnd, &mut outer) != 0 && GetClientRect(hwnd, &mut client) != 0;
        let borders = if has_rects {
            (
                (outer.right - outer.left - client.right + client.left).max(0),
                (outer.bottom - outer.top - client.bottom + client.top).max(0),
            )
        } else {
            (0, 0)
        };
        (scale, borders.0, borders.1)
    };
    Point {
        x: ((size.width * scale).ceil() as i32).saturating_add(border_width),
        y: ((size.height * scale).ceil() as i32).saturating_add(border_height),
    }
}

unsafe extern "system" fn minimum_size_proc(
    hwnd: Hwnd,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    if message == WM_NCDESTROY {
        // Subclass state belongs to the HWND, not a global map. The native
        // destruction notification is the single owner that releases it.
        unsafe {
            RemoveWindowSubclass(hwnd, minimum_size_proc, id);
            if data != 0 {
                drop(Box::from_raw(data as *mut MinimumSize));
            }
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
    }
    if message == WM_APPLY_MINIMUM_SIZE && data != 0 {
        // The resize message runs after the current GPUI entity lease has been
        // released, so WM_SIZE cannot re-enter the model that requested it.
        unsafe {
            let normal_resizable_window = IsIconic(hwnd) == 0
                && IsZoomed(hwnd) == 0
                && GetWindowLongPtrW(hwnd, -16) & 0x0004_0000 != 0;
            if normal_resizable_window {
                let minimum = track_size(hwnd, &*(data as *const MinimumSize));
                let mut outer = Rect::default();
                if GetWindowRect(hwnd, &mut outer) != 0 {
                    let old_width = outer.right - outer.left;
                    let old_height = outer.bottom - outer.top;
                    if old_width < minimum.x || old_height < minimum.y {
                        SetWindowPos(
                            hwnd,
                            std::ptr::null_mut(),
                            0,
                            0,
                            old_width.max(minimum.x),
                            old_height.max(minimum.y),
                            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                }
            }
        }
        return 0;
    }

    // Preserve GPUI's default/maximized bounds handling before replacing only
    // its creation-time minimum with the current renderer-requested minimum.
    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    if message == WM_GETMINMAXINFO && lparam != 0 && data != 0 {
        unsafe {
            let size = &*(data as *const MinimumSize);
            (*(lparam as *mut MinMaxInfo)).min_track_size = track_size(hwnd, size);
        }
    }
    result
}

pub fn set_minimum_size(window: &gpui::Window, width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > 1_000_000.0
        || height > 1_000_000.0
    {
        return Err("DESKTOP_WINDOW_INVALID_MINIMUM_SIZE".into());
    }
    let hwnd = hwnd(window)?;
    let size = MinimumSize { width, height };
    let mut state = 0;
    unsafe {
        if GetWindowSubclass(hwnd, minimum_size_proc, MINIMUM_SIZE_SUBCLASS, &mut state) != 0
            && state != 0
        {
            *(state as *mut MinimumSize) = size;
        } else {
            let state = Box::into_raw(Box::new(size));
            if SetWindowSubclass(
                hwnd,
                minimum_size_proc,
                MINIMUM_SIZE_SUBCLASS,
                state as usize,
            ) == 0
            {
                drop(Box::from_raw(state));
                return Err(last_error("DESKTOP_WINDOW_MINIMUM_SIZE_FAILED"));
            }
        }
    }

    // Clamp a smaller normal window after the current GPUI update completes.
    // Maximized/fullscreen placement and the user's position remain intact.
    unsafe {
        if PostMessageW(hwnd, WM_APPLY_MINIMUM_SIZE, 0, 0) == 0 {
            return Err(last_error("DESKTOP_WINDOW_RESIZE_FAILED"));
        }
    }
    Ok(())
}
