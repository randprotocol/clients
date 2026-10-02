#!/usr/bin/env python3
"""The three promotional graphics the stores require beside the icon, from the same drawing:

    design/out/play-feature-1024x500.png     Google Play's feature graphic
    design/out/chrome-promo-440x280.png      the Chrome Web Store's small promo tile
    design/out/chrome-marquee-1400x560.png   the Chrome Web Store's marquee promo tile

Each is the mark and the name on ink, over an ordered-dither field that thickens towards the far
corner — the entropy field of ui/lib/entropy.js reduced to a gradient, so it is the same on every
run. No store badge, no price, no claim: both stores refuse graphics that carry them.

    python3 design/make-store-art.py        (needs Pillow)
"""
import importlib.util, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("icons", os.path.join(HERE, "make-icons.py"))
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)

INK, GRAIN, HOT = icons.INK, icons.GRAIN, icons.HOT
BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
FONTS = os.path.join(ROOT, "ios", "RandWallet", "Fonts")
MONO = os.path.join(FONTS, "DepartureMono-Regular.otf")
SANS = os.path.join(FONTS, "InterVariable.ttf")


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)


def field(img, cell):
    """Dither cells whose density rises from nothing at the left to about a half at the bottom
    right. Drawn dim, so the type over the sparse side stays the brightest thing in the frame."""
    w, h = img.size
    d = ImageDraw.Draw(img)
    dim, hot = mix(INK, GRAIN, 0.22), mix(INK, HOT, 0.85)
    cols, rows = w // cell + 1, h // cell + 1
    for y in range(rows):
        for x in range(cols):
            fx, fy = x / cols, y / rows
            density = max(0.0, fx - 0.38) * 0.75 + max(0.0, fx - 0.5) * fy * 0.5
            if density > (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16:
                # One cell in the signal colour per 16x12 block, where the field is dense enough.
                is_hot = (x % 16 == 11 and y % 12 == 7 and density > 0.3)
                d.rectangle([x * cell, y * cell, x * cell + cell - 2, y * cell + cell - 2],
                            fill=hot if is_hot else dim)


def art(w, h, cell, mark_px, title_px, sub_px, pad, path):
    img = Image.new("RGBA", (w, h), INK)
    field(img, cell)
    icons.draw_mark(img, (pad, (h - mark_px) // 2 - title_px // 2, mark_px), icons.grid_for(mark_px))
    d = ImageDraw.Draw(img)
    title = ImageFont.truetype(MONO, title_px)
    sub = ImageFont.truetype(SANS, sub_px)
    tx = pad + mark_px + round(mark_px * 0.32)
    ty = (h - mark_px) // 2 - title_px // 2
    d.text((tx, ty + (mark_px - title_px) // 2 - sub_px // 2), "Rand Wallet", font=title, fill=GRAIN)
    d.text((tx, ty + (mark_px - title_px) // 2 - sub_px // 2 + title_px + round(sub_px * 0.6)),
           "Shielded wallet for RAND", font=sub, fill=mix(INK, GRAIN, 0.62))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.convert("RGB").save(path, optimize=True)
    print(path)


if __name__ == "__main__":
    out = os.path.join(HERE, "out")
    art(1024, 500, 12, 138, 64, 26, 84, os.path.join(out, "play-feature-1024x500.png"))
    art(440, 280, 7, 69, 30, 14, 34, os.path.join(out, "chrome-promo-440x280.png"))
    art(1400, 560, 14, 190, 88, 36, 120, os.path.join(out, "chrome-marquee-1400x560.png"))
