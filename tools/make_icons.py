"""
Draw the Loupe toolbar mark locally (no downloaded assets) and write the four
PNG sizes Chrome wants: 16, 32, 48, 128.

The mark is a brass-ringed lens with aperture seams and a short handle. Detail
is dropped below 28px so the 16px icon stays legible instead of turning to mush.

Usage:  python tools/make_icons.py
Output: icons/icon16.png ... icons/icon128.png
"""

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "icons"))

SS = 8  # supersampling factor
GRAPHITE = (12, 15, 18, 255)
GLASS = (16, 21, 26, 246)
BRASS = (201, 169, 97, 255)
BRASS_SOFT = (201, 169, 97, 105)
SEAM = (9, 12, 15, 170)
HIGHLIGHT = (255, 255, 255, 52)


def render(size: int) -> Image.Image:
    w = size * SS
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx, cy = w * 0.435, w * 0.415
    r = w * 0.285
    ring = max(SS * 1.7, w * 0.070)
    detail = size >= 28

    # handle: short brass bar at 45 degrees with rounded ends
    hx1, hy1 = cx + r * 0.74, cy + r * 0.74
    hx2, hy2 = w * 0.795, w * 0.795
    hw = w * 0.105
    d.line([(hx1, hy1), (hx2, hy2)], fill=BRASS, width=int(hw))
    for px, py in ((hx1, hy1), (hx2, hy2)):
        d.ellipse([px - hw / 2, py - hw / 2, px + hw / 2, py + hw / 2], fill=BRASS)

    # glass
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLASS)

    if detail:
        # aperture seams
        for k in range(6):
            a = math.radians(k * 60 + 18)
            d.line(
                [
                    (cx + math.cos(a) * r * 0.16, cy + math.sin(a) * r * 0.16),
                    (cx + math.cos(a) * r * 0.93, cy + math.sin(a) * r * 0.93),
                ],
                fill=SEAM,
                width=max(SS, int(w * 0.010)),
            )
        # inner engraved ring
        d.ellipse(
            [cx - r * 0.60, cy - r * 0.60, cx + r * 0.60, cy + r * 0.60],
            outline=BRASS_SOFT,
            width=max(SS, int(w * 0.012)),
        )

    # brass barrel ring
    d.ellipse(
        [cx - r - ring / 2, cy - r - ring / 2, cx + r + ring / 2, cy + r + ring / 2],
        outline=BRASS,
        width=int(ring),
    )

    if detail:
        # single specular arc, top-left, like a coated element
        d.arc(
            [cx - r * 0.80, cy - r * 0.80, cx + r * 0.80, cy + r * 0.80],
            start=196,
            end=256,
            fill=HIGHLIGHT,
            width=int(w * 0.022),
        )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT, f"icon{size}.png")
        render(size).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
