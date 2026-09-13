//! design/tokens.json as egui visuals. Dark by default, light as a full theme; the aurora
//! gradient is approximated by its two stops on the balance card and the primary button.

use egui::{Color32, CornerRadius, Stroke, Visuals};

#[derive(Clone, Copy)]
pub struct Palette {
    pub bg: Color32,
    pub bg_soft: Color32,
    pub surface: Color32,
    pub surface2: Color32,
    pub border: Color32,
    pub border_soft: Color32,
    pub text: Color32,
    pub text_soft: Color32,
    pub text_mute: Color32,
    pub text_strong: Color32,
    pub accent: Color32,
    pub accent2: Color32,
    pub positive: Color32,
    pub negative: Color32,
    pub warning: Color32,
}

const fn c(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

pub const DARK: Palette = Palette {
    bg: c(0x0B0D14),
    bg_soft: c(0x10131E),
    surface: c(0x151A2B),
    surface2: c(0x1D2338),
    border: c(0x262D48),
    border_soft: c(0x1E2439),
    text: c(0xEEF0F7),
    text_soft: c(0xA6ADC8),
    text_mute: c(0x6F7797),
    text_strong: c(0xFFFFFF),
    accent: c(0x6F7EFF),
    accent2: c(0x9B6BFF),
    positive: c(0x33D69F),
    negative: c(0xFF6B6B),
    warning: c(0xFFB84D),
};

pub const LIGHT: Palette = Palette {
    bg: c(0xF5F6FB),
    bg_soft: c(0xEDEFF7),
    surface: c(0xFFFFFF),
    surface2: c(0xF2F3F9),
    border: c(0xDCDFEC),
    border_soft: c(0xE8EAF3),
    text: c(0x141A2E),
    text_soft: c(0x4A5270),
    text_mute: c(0x7B8299),
    text_strong: c(0x0A0F1F),
    accent: c(0x4F5FE8),
    accent2: c(0x8457E6),
    positive: c(0x1BA97A),
    negative: c(0xD94F4F),
    warning: c(0xD98A1E),
};

pub const AURORA_FROM: Color32 = c(0x5B7CFF);
pub const AURORA_TO: Color32 = c(0x9B6BFF);

pub fn apply(ctx: &egui::Context, dark: bool) {
    let p = if dark { DARK } else { LIGHT };
    let mut v = if dark { Visuals::dark() } else { Visuals::light() };
    v.panel_fill = p.bg;
    v.window_fill = p.surface;
    v.extreme_bg_color = p.surface2;
    v.faint_bg_color = p.bg_soft;
    v.override_text_color = Some(p.text);
    v.hyperlink_color = p.accent;
    v.selection.bg_fill = p.accent.gamma_multiply(0.35);
    v.widgets.noninteractive.bg_fill = p.surface;
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, p.border_soft);
    v.widgets.inactive.bg_fill = p.surface2;
    v.widgets.inactive.weak_bg_fill = p.surface2;
    v.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, p.border);
    v.widgets.hovered.bg_fill = p.border;
    v.widgets.hovered.weak_bg_fill = p.border;
    v.widgets.active.bg_fill = p.accent;
    v.widgets.active.weak_bg_fill = p.accent;
    v.widgets.open.bg_fill = p.surface2;
    for w in [&mut v.widgets.noninteractive, &mut v.widgets.inactive, &mut v.widgets.hovered, &mut v.widgets.active, &mut v.widgets.open] {
        w.corner_radius = CornerRadius::same(10);
    }
    v.window_corner_radius = CornerRadius::same(16);
    v.window_stroke = Stroke::new(1.0_f32, p.border);
    ctx.set_visuals(v);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(10.0, 10.0);
    style.spacing.button_padding = egui::vec2(14.0, 9.0);
    style.spacing.interact_size.y = 36.0;
    use egui::{FontFamily, FontId, TextStyle};
    style.text_styles = [
        (TextStyle::Heading, FontId::new(22.0, FontFamily::Proportional)),
        (TextStyle::Body, FontId::new(15.0, FontFamily::Proportional)),
        (TextStyle::Button, FontId::new(15.0, FontFamily::Proportional)),
        (TextStyle::Small, FontId::new(12.0, FontFamily::Proportional)),
        (TextStyle::Monospace, FontId::new(13.0, FontFamily::Monospace)),
    ]
    .into();
    ctx.set_style(style);
}
