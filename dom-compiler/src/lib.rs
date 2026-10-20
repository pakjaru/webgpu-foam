//! Compiles a live DOM subtree into a flat GPU instance buffer.
//!
//! Every element marked `data-gl` becomes one instance of 8 floats:
//! `[x, y, w, h, r, g, b, depth]` — document-space pixels, background colour
//! in 0..1, and `depth` = how many `data-gl` ancestors it has (its layer).
//! The browser still does layout; Rust only reads it and packs it.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::Element;

pub const STRIDE: usize = 8;

#[wasm_bindgen]
pub fn compile(root: &Element, selector: &str, color_prop: &str) -> Result<Vec<f32>, JsValue> {
    let win = web_sys::window().ok_or("no window")?;
    let (sx, sy) = (win.scroll_x()? as f32, win.scroll_y()? as f32);
    let nodes = root.query_selector_all(selector)?;
    let mut out = Vec::with_capacity(nodes.length() as usize * STRIDE);

    for i in 0..nodes.length() {
        let el: Element = nodes.get(i).ok_or("missing node")?.dyn_into()?;
        let r = el.get_bounding_client_rect();
        let bg = win
            .get_computed_style(&el)?
            .and_then(|s| s.get_property_value(color_prop).ok())
            .and_then(|c| parse_rgb(&c))
            .unwrap_or([1.0, 1.0, 1.0]);

        out.extend_from_slice(&[
            r.left() as f32 + sx,
            r.top() as f32 + sy,
            r.width() as f32,
            r.height() as f32,
            bg[0],
            bg[1],
            bg[2],
            layer_depth(&el) as f32,
        ]);
    }
    Ok(out)
}

fn layer_depth(el: &Element) -> u32 {
    let mut depth = 0;
    let mut cur = el.parent_element();
    while let Some(p) = cur {
        if p.has_attribute("data-gl") {
            depth += 1;
        }
        cur = p.parent_element();
    }
    depth
}

/// Parses computed-style colours: `rgb(r, g, b)` / `rgba(r, g, b, a)`.
/// Fully transparent backgrounds return `None` so the caller falls back.
fn parse_rgb(s: &str) -> Option<[f32; 3]> {
    let inner = s.trim().strip_prefix("rgba(").or_else(|| s.trim().strip_prefix("rgb("))?;
    let nums: Vec<f32> = inner
        .trim_end_matches(')')
        .split(|c| c == ',' || c == '/' || c == ' ')
        .filter(|p| !p.is_empty())
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    if nums.len() < 3 || nums.get(3) == Some(&0.0) {
        return None;
    }
    Some([nums[0] / 255.0, nums[1] / 255.0, nums[2] / 255.0])
}

#[cfg(test)]
mod tests {
    use super::parse_rgb;

    #[test]
    fn parses_computed_colours() {
        assert_eq!(parse_rgb("rgb(255, 0, 51)"), Some([1.0, 0.0, 0.2]));
        assert_eq!(parse_rgb("rgba(0, 255, 0, 0.5)"), Some([0.0, 1.0, 0.0]));
        assert_eq!(parse_rgb("rgba(0, 0, 0, 0)"), None);
        assert_eq!(parse_rgb("transparent"), None);
    }
}
