#!/usr/bin/env python3
"""Generate every app icon from one drawing: the entropy mark on an ink tile.

The mark is the brand tile of ui/lib/entropy.js (`markSvg`): one 4x4 Bayer tile at a single
threshold, bone cells on ink, one cell in the signal colour. Every size is drawn natively and
snapped to whole pixels rather than downscaled from 1024, so a 16 px toolbar icon is as crisp as
the store artwork. Outputs into ios/, android/, extension/shared/icons/, desktop/assets/,
web/public/clients/ and design/out.

    python3 design/make-icons.py        (needs Pillow; macOS for iconutil's .icns)
"""
import os, shutil, subprocess, tempfile
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# design/tokens.json: field.ink, field.grain, dark.accent.
INK = (0x0E, 0x12, 0x20, 255)
GRAIN = (0xEC, 0xE9, 0xE2, 255)
HOT = (0xFF, 0x5C, 0x9D, 255)

# The lit cells of the 4x4 tile and the one hot cell — the same as markSvg() in ui/lib/entropy.js.
ON = [0, 2, 5, 7, 8, 10, 13, 15, 1, 11]
HOT_CELL = 11


def draw_mark(img, box, grid):
    """Draw the mark into `img` inside the square `box` = (x, y, size), on whole pixels.
    `grid` is (cell, gap) in pixels; the mark is 4*cell + 3*gap wide, centred in the box."""
    x0, y0, size = box
    cell, gap = grid
    span = 4 * cell + 3 * gap
    ox, oy = x0 + (size - span) // 2, y0 + (size - span) // 2
    d = ImageDraw.Draw(img)
    for i in ON:
        cx, cy = ox + (i % 4) * (cell + gap), oy + (i // 4) * (cell + gap)
        d.rectangle([cx, cy, cx + cell - 1, cy + cell - 1], fill=HOT if i == HOT_CELL else GRAIN)


def grid_for(mark_px):
    """(cell, gap) for a mark about `mark_px` wide: the SVG's 5:1 cell-to-gap ratio on whole
    pixels. Below that scale the gap stays at 1 px and the cells shrink instead — touching cells
    merge into a blob at toolbar sizes, and the gaps are what make it read as dither."""
    unit = mark_px / 23
    if unit >= 1:
        u = round(unit)
        return 5 * u, u
    return max(2, round((mark_px - 3) / 4)), 1


def tile(size, shape="rounded", inset=0.0, mark=0.5):
    """An ink tile with the mark. shape: 'rounded' (a 22% squircle-ish radius), 'square'
    (full bleed, for iOS which masks it itself), 'circle' (Android's round launcher).
    inset: transparent margin as a fraction of size (macOS's icon grid). mark: mark width as a
    fraction of the tile body."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pad = round(size * inset)
    body = size - 2 * pad
    d = ImageDraw.Draw(img)
    box = [pad, pad, pad + body - 1, pad + body - 1]
    if shape == "square":
        d.rectangle(box, fill=INK)
    elif shape == "circle":
        d.ellipse(box, fill=INK)
    else:
        d.rounded_rectangle(box, radius=round(body * 0.22), fill=INK)
    draw_mark(img, (pad, pad, body), grid_for(body * mark))
    return img


def foreground(size, mark=0.34):
    """Android adaptive foreground: the mark alone on transparent. The 108 dp canvas is cropped to
    a 72 dp shape and only the central 66 dp is guaranteed visible, so the mark stays well inside."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(img, (0, 0, size), grid_for(size * mark))
    return img


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT))


def icns(path):
    """macOS .icns from an iconset drawn on Apple's icon grid (an 824 body in a 1024 canvas)."""
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for pt in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = pt * scale
                name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
                tile(px, inset=100 / 1024).save(os.path.join(iconset, name))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path], check=True)
    print("wrote", os.path.relpath(path, ROOT))


def main():
    out = os.path.join(ROOT, "design", "out")
    big = tile(1024)
    save(big, f"{out}/icon-1024.png")
    save(tile(1024, shape="square").convert("RGB"), f"{out}/icon-1024-opaque.png")
    save(tile(512, shape="square").convert("RGB"), f"{out}/play-store-512.png")
    save(tile(256), f"{out}/icon-256.png")
    # The /clients download page's copy (web/README.md publishes it to the site repo).
    save(tile(256), f"{ROOT}/web/public/clients/icon-256.png")
    save(tile(64), f"{out}/icon-64.png")

    # iOS: one opaque full-bleed 1024 in the asset catalog; the system applies the mask.
    save(tile(1024, shape="square").convert("RGB"),
         f"{ROOT}/ios/RandWallet/Assets.xcassets/AppIcon.appiconset/icon-1024.png")

    # Android: legacy mipmaps (rounded and round) + the adaptive foreground (108 dp canvas). The
    # adaptive background is drawable/ic_launcher_background.xml, a flat ink fill.
    for name, dp in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
        res = f"{ROOT}/android/app/src/main/res/mipmap-{name}"
        save(tile(dp), f"{res}/ic_launcher.png")
        save(tile(dp, shape="circle"), f"{res}/ic_launcher_round.png")
        save(foreground(dp * 108 // 48), f"{res}/ic_launcher_foreground.png")

    # Extensions (Chrome and Firefox both pack extension/shared/icons/).
    for s in (16, 32, 48, 128):
        save(tile(s), f"{ROOT}/extension/shared/icons/icon-{s}.png")

    # Desktop (tauri.conf.json bundle.icon): PNGs, a Windows .ico, a macOS .icns.
    desk = f"{ROOT}/desktop/assets"
    save(tile(1024, inset=100 / 1024), f"{desk}/icon-1024.png")
    for name, px in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128),
                     ("128x128@2x.png", 256), ("icon.png", 512)]:
        save(tile(px), f"{desk}/icons/{name}")
    # Each .ico frame drawn at its own size, not resampled from the largest.
    frames = [tile(s) for s in (256, 128, 64, 48, 32, 16)]
    frames[0].save(f"{desk}/icons/icon.ico", format="ICO", sizes=[f.size for f in frames],
                   append_images=frames[1:])
    print("wrote desktop/assets/icons/icon.ico")
    if shutil.which("iconutil"):
        icns(f"{desk}/icons/icon.icns")
    else:
        print("skipped icon.icns: iconutil is macOS-only")


if __name__ == "__main__":
    main()
