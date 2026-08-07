//! Follow Me — on-demand desktop screen capture (Phase 1).
//!
//! macOS-only (ScreenCaptureKit). See FOLLOW_ME_SPEC.md for the full design. This module
//! intentionally does not implement Watch Mode / continuous streaming (Phase 3) — every
//! capture here is a single, explicitly user-triggered frame, mirroring the on-demand
//! shape described in spec Section 2.2 so a later refcounted streaming loop can be added
//! without reworking this path.
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::errors::{CanopyError, Result};
use crate::models::AgentCapabilities;

/// Fixed, non-configurable blocklist (spec Section 3.1). Checked by bundle id before any
/// capture proceeds — this is the primary defense, not the (not-yet-implemented) regex
/// privacy filter.
pub const CAPTURE_BLOCKLIST_BUNDLE_IDS: &[&str] = &[
    "com.apple.mail",
    "com.apple.MobileSMS",
    "com.apple.iChat",
    "com.apple.keychainaccess",
    "com.apple.SecurityAgent",
    "com.apple.systempreferences",
    "com.apple.preference.security",
    "com.1password.1password",
    "com.1password.1password7",
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword-osx",
    "com.lastpass.LastPass",
    "com.bitwarden.desktop",
];

fn is_blocked_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty()
        && CAPTURE_BLOCKLIST_BUNDLE_IDS
            .iter()
            .any(|blocked| blocked.eq_ignore_ascii_case(bundle_id))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenSource {
    pub id: String,
    pub title: String,
    pub app_bundle_id: String,
    /// "window" | "display"
    pub kind: String,
}

/// Follow Me requires both `screen_record` (the capability gate the rest of Canopy already
/// knows about) and `vision` (so the agent can actually make sense of the resulting image),
/// mirroring how `computer_control` already requires `screen_record` in `computer_control.rs`.
pub fn validate_capabilities(capabilities: &AgentCapabilities) -> Result<()> {
    if !capabilities.screen_record {
        return Err(CanopyError::Unauthorized(
            "Follow Me capture requires the screen_record capability to be enabled for this agent."
                .into(),
        ));
    }
    if !capabilities.vision {
        return Err(CanopyError::Unauthorized(
            "Follow Me capture requires the vision capability so the agent can interpret the capture."
                .into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_core_foundation::{CFMutableData, CFRetained, CFString};
    use objc2_core_graphics::CGImage;
    use objc2_foundation::{NSArray, NSError};
    use objc2_image_io::CGImageDestination;
    use objc2_screen_capture_kit::{
        SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
    };

    use super::ScreenSource;

    fn get_shareable_content() -> std::result::Result<Retained<SCShareableContent>, String> {
        let (tx, rx) = mpsc::channel::<std::result::Result<Retained<SCShareableContent>, String>>();

        let handler =
            RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !content.is_null() {
                    // SAFETY: ScreenCaptureKit hands us a +1 object on success.
                    Ok(unsafe { Retained::retain(content) }.expect("non-null content"))
                } else {
                    Err(describe_error(error))
                };
                let _ = tx.send(result);
            });

        // SAFETY: `handler` outlives the call — ScreenCaptureKit invokes it synchronously
        // from its own queue before this function returns control to the caller (we block
        // on `rx.recv()` below).
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&handler);
        }

        rx.recv().map_err(|e| e.to_string())?
    }

    fn describe_error(error: *mut NSError) -> String {
        if error.is_null() {
            "Unknown ScreenCaptureKit error (permission not granted yet?)".to_string()
        } else {
            // SAFETY: caller (ScreenCaptureKit) guarantees a valid pointer here.
            let err = unsafe { &*error };
            err.localizedDescription().to_string()
        }
    }

    /// Enumerates capturable windows and displays. Requires the macOS Screen Recording TCC
    /// permission — pre-grant, ScreenCaptureKit returns an empty/error result rather than a
    /// black frame for this call, which callers should surface as "not yet enabled."
    pub fn list_sources() -> std::result::Result<Vec<ScreenSource>, String> {
        let content = get_shareable_content()?;
        let mut sources = Vec::new();

        let windows = unsafe { content.windows() };
        for window in windows.iter() {
            // Skip windows with no title / off-screen — not meaningfully pickable.
            if !unsafe { window.isOnScreen() } {
                continue;
            }
            let title = unsafe { window.title() }
                .map(|t| t.to_string())
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            let bundle_id = unsafe { window.owningApplication() }
                .map(|app| unsafe { app.bundleIdentifier() }.to_string())
                .unwrap_or_default();
            let window_id = unsafe { window.windowID() };
            sources.push(ScreenSource {
                id: format!("window:{}", window_id),
                title,
                app_bundle_id: bundle_id,
                kind: "window".to_string(),
            });
        }

        let displays = unsafe { content.displays() };
        for display in displays.iter() {
            let display_id = unsafe { display.displayID() };
            sources.push(ScreenSource {
                id: format!("display:{}", display_id),
                title: format!("Entire Screen {}", display_id),
                app_bundle_id: String::new(),
                kind: "display".to_string(),
            });
        }

        Ok(sources)
    }

    fn capture_image(
        filter: &SCContentFilter,
        width: usize,
        height: usize,
    ) -> std::result::Result<CFRetained<CGImage>, String> {
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(width.max(1));
            config.setHeight(height.max(1));
            config.setShowsCursor(true);
        }

        let (tx, rx) = mpsc::channel::<std::result::Result<CFRetained<CGImage>, String>>();

        let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
            let result = if !image.is_null() {
                // SAFETY: ScreenCaptureKit hands us a +1 CGImage on success.
                Ok(unsafe { CFRetained::retain(std::ptr::NonNull::new_unchecked(image)) })
            } else {
                Err(describe_error(error))
            };
            let _ = tx.send(result);
        });

        // SAFETY: same synchronous-completion contract as `get_shareable_content`.
        unsafe {
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                filter,
                &config,
                Some(&handler),
            );
        }

        rx.recv().map_err(|e| e.to_string())?
    }

    fn encode_png(image: &CGImage) -> std::result::Result<Vec<u8>, String> {
        let data = CFMutableData::new(None, 0)
            .ok_or_else(|| "Failed to allocate output buffer for capture".to_string())?;
        let png_type = CFString::from_str("public.png");

        let dest = unsafe { CGImageDestination::with_data(&data, &png_type, 1, None) }
            .ok_or_else(|| "Failed to create PNG encoder for capture".to_string())?;
        unsafe { dest.add_image(image, None) };
        if !unsafe { dest.finalize() } {
            return Err("Failed to encode capture as PNG".to_string());
        }

        Ok(data.to_vec())
    }

    /// Captures a single frame from `source_id` (as produced by `list_sources`) and returns
    /// it as raw PNG bytes. Pixels never touch disk — encoded entirely in memory and handed
    /// back to the caller, who is responsible for dropping them after the one IPC hop.
    pub fn capture_source(source_id: &str) -> std::result::Result<Vec<u8>, String> {
        let content = get_shareable_content()?;

        let (filter, width, height) = if let Some(rest) = source_id.strip_prefix("window:") {
            let target_id: u32 = rest.parse().map_err(|_| "Invalid window id".to_string())?;
            let windows = unsafe { content.windows() };
            let window = windows
                .iter()
                .find(|w| unsafe { w.windowID() } == target_id)
                .ok_or_else(|| "Window is no longer available".to_string())?;
            let frame = unsafe { window.frame() };
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            (
                filter,
                frame.size.width as usize,
                frame.size.height as usize,
            )
        } else if let Some(rest) = source_id.strip_prefix("display:") {
            let target_id: u32 = rest.parse().map_err(|_| "Invalid display id".to_string())?;
            let displays = unsafe { content.displays() };
            let display = displays
                .iter()
                .find(|d| unsafe { d.displayID() } == target_id)
                .ok_or_else(|| "Display is no longer available".to_string())?;
            let excluded: Retained<NSArray<SCWindow>> = NSArray::new();
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &excluded,
                )
            };
            (
                filter,
                unsafe { display.width() } as usize,
                unsafe { display.height() } as usize,
            )
        } else {
            return Err("Unrecognized capture source id".to_string());
        };

        let image = capture_image(&filter, width, height)?;
        encode_png(&image)
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED_PLATFORM: &str = "Follow Me screen capture requires macOS 12.3 or later.";

/// Lists capturable windows/displays, pre-filtered to strip anything on the hard blocklist
/// before it ever reaches the frontend (spec Section 7).
#[tauri::command]
pub async fn get_screen_sources(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> std::result::Result<Vec<ScreenSource>, String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Agent not found".to_string())?;
    validate_capabilities(&agent.capabilities).map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    {
        Err(UNSUPPORTED_PLATFORM.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let sources = tokio::task::spawn_blocking(mac::list_sources)
            .await
            .map_err(|e| e.to_string())??;
        Ok(sources
            .into_iter()
            .filter(|s| !is_blocked_bundle_id(&s.app_bundle_id))
            .collect())
    }
}

/// Captures one frame from `source_id`, runs the blocklist check again (defense in depth —
/// the list the user picked from may be stale), rate-limits per agent, and returns a base64
/// PNG data URL ready to drop straight into `ChatTab.tsx`'s `attachments` array. Never
/// writes the frame to disk or logs the pixel bytes — only capture metadata is audited.
#[tauri::command]
pub async fn capture_screen_source(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    source_id: String,
) -> std::result::Result<String, String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Agent not found".to_string())?;
    validate_capabilities(&agent.capabilities).map_err(|e| e.to_string())?;

    crate::rate_limiter::limiters::SCREEN_CAPTURE_LIMITER
        .check(&agent_id)
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    {
        Err(UNSUPPORTED_PLATFORM.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let lookup_id = source_id.clone();
        let sources = tokio::task::spawn_blocking(mac::list_sources)
            .await
            .map_err(|e| e.to_string())??;
        let matched = sources
            .into_iter()
            .find(|s| s.id == lookup_id)
            .ok_or_else(|| "Screen source not found or no longer available".to_string())?;

        if is_blocked_bundle_id(&matched.app_bundle_id) {
            return Err(
                "This app is on the Follow Me blocklist and cannot be captured.".to_string(),
            );
        }

        let capture_id = source_id.clone();
        let png_bytes = tokio::task::spawn_blocking(move || mac::capture_source(&capture_id))
            .await
            .map_err(|e| e.to_string())??;

        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png_bytes)
        );

        let _ = db.log_audit(
            &agent_id,
            "screen_capture",
            None,
            &format!(
                "Follow Me on-demand capture — {} ({})",
                matched.kind,
                if matched.app_bundle_id.is_empty() {
                    "display"
                } else {
                    matched.app_bundle_id.as_str()
                }
            ),
            None,
        );

        Ok(data_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_with(screen_record: bool, vision: bool) -> AgentCapabilities {
        let mut caps = AgentCapabilities::default();
        caps.screen_record = screen_record;
        caps.vision = vision;
        caps
    }

    #[test]
    fn requires_screen_record() {
        let err = validate_capabilities(&caps_with(false, true))
            .unwrap_err()
            .to_string();
        assert!(err.contains("screen_record"));
    }

    #[test]
    fn requires_vision() {
        let err = validate_capabilities(&caps_with(true, false))
            .unwrap_err()
            .to_string();
        assert!(err.contains("vision"));
    }

    #[test]
    fn passes_with_both() {
        assert!(validate_capabilities(&caps_with(true, true)).is_ok());
    }

    #[test]
    fn blocklist_matches_case_insensitively() {
        assert!(is_blocked_bundle_id("Com.Apple.Mail"));
        assert!(is_blocked_bundle_id("com.1password.1password"));
        assert!(!is_blocked_bundle_id("com.apple.dt.Xcode"));
        assert!(!is_blocked_bundle_id(""));
    }
}
