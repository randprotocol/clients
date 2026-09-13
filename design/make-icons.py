#!/usr/bin/env python3
"""Generate every app icon from one drawing: a rounded square filled with the aurora gradient and
a white shield-and-R mark. Outputs into ios/, android/, chrome/, firefox/ and design/out."""
import os, sys, math
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FROM, TO = (0x5B, 0x7C, 0xFF), (0x9B, 0x6B, 0xFF)

def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(FROM[i] + (TO[i] - FROM[i]) * t) for i in range(3))
    return img

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def font(px):
    for p in ["/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
              "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
              "/Library/Fonts/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()

def mark(size, bg=True, fg=(255, 255, 255, 255), pad_ratio=0.0):
    """The drawing at `size`. bg=False gives a transparent foreground layer (Android adaptive)."""
    S = size
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if bg:
        g = gradient(S).convert("RGBA")
        g.putalpha(rounded_mask(S, int(S * 0.22)))
        base = Image.alpha_composite(base, g)
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Shield: a soft rounded shape slightly smaller than the tile.
    cx, top, w, h = S / 2, S * 0.20, S * 0.50, S * 0.60
    pts = [(cx - w/2, top), (cx + w/2, top), (cx + w/2, top + h*0.55), (cx, top + h), (cx - w/2, top + h*0.55)]
    d.polygon(pts, fill=(255, 255, 255, 235))
    # Round the shield's corners by overlaying a blurred-ish smaller copy: simple approach, draw
    # circles at the two upper corners.
    r = S * 0.06
    d.ellipse([cx - w/2 - r*0.0, top - r*0.0, cx - w/2 + 2*r, top + 2*r], fill=(255,255,255,235))
    d.ellipse([cx + w/2 - 2*r, top, cx + w/2, top + 2*r], fill=(255,255,255,235))
    # The R, in the gradient colour, centred in the shield.
    f = font(int(S * 0.40))
    txt = "R"
    bbox = d.textbbox((0, 0), txt, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx, ty = cx - tw / 2 - bbox[0], top + h * 0.44 - th / 2 - bbox[1]
    d.text((tx, ty), txt, font=f, fill=(0x6A, 0x74, 0xFF, 255))
    return Image.alpha_composite(base, layer)

def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", path)

def main():
    big = mark(1024)
    out = os.path.join(ROOT, "design", "out")
    save(big, f"{out}/icon-1024.png")
    save(big.convert("RGB"), f"{out}/icon-1024-opaque.png")
    # iOS: a single 1024 opaque icon in the asset catalog.
    save(big.convert("RGB"), f"{ROOT}/ios/RandWallet/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
    # Android: legacy mipmaps + adaptive layers (108dp canvas, 72dp safe zone).
    for name, dp in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
        save(big.resize((dp, dp), Image.LANCZOS), f"{ROOT}/android/app/src/main/res/mipmap-{name}/ic_launcher.png")
        save(big.resize((dp, dp), Image.LANCZOS), f"{ROOT}/android/app/src/main/res/mipmap-{name}/ic_launcher_round.png")
        # adaptive foreground: the mark on transparent, inset to the safe zone
        canvas = int(dp * 108 / 48)
        fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        m = mark(int(canvas * 0.62), bg=False)
        fg.alpha_composite(m, ((canvas - m.width) // 2, (canvas - m.height) // 2))
        save(fg, f"{ROOT}/android/app/src/main/res/mipmap-{name}/ic_launcher_foreground.png")
    save(big.resize((512, 512), Image.LANCZOS).convert("RGB"), f"{out}/play-store-512.png")
    # Extensions: 16/32/48/128, plus a 128 with transparent corners kept.
    for s in (16, 32, 48, 128):
        for browser in ("chrome", "firefox"):
            save(big.resize((s, s), Image.LANCZOS), f"{ROOT}/extension/shared/icons/icon-{s}.png")
    # Website: a 256 for the clients page and a favicon-ish 64.
    save(big.resize((256, 256), Image.LANCZOS), f"{out}/icon-256.png")
    save(big.resize((64, 64), Image.LANCZOS), f"{out}/icon-64.png")

if __name__ == "__main__":
    main()
