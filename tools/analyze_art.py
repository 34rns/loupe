"""
Pixel-level check of the design screenshots (no eyeballing available):

  .artifacts/popup.png         full popup, 358 wide
  .artifacts/popup-zoomed.png  same with the preview lens zoomed
  .artifacts/icons.png         the four icon sizes on light and dark plates

Reports whether the brass accent actually renders, whether the lens artwork has
real content, whether anything bleeds off the right edge, and whether the 16px
icon carries more than a blob of one colour.
"""

import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.normpath(os.path.join(HERE, "..", ".artifacts"))

GRAPHITE = (12, 15, 18)


def is_brass(px):
    r, g, b = px[:3]
    return r > 120 and 90 < g < 205 and b < 150 and r > b + 30


def brass_count(img, box):
    region = img.crop(box)
    return sum(1 for px in region.getdata() if is_brass(px))


def distinct(img, box):
    return len(set(img.crop(box).getdata()))


def non_bg(img, box, bg=GRAPHITE, tol=6):
    region = img.crop(box)
    return sum(
        1
        for px in region.getdata()
        if abs(px[0] - bg[0]) > tol or abs(px[1] - bg[1]) > tol or abs(px[2] - bg[2]) > tol
    )


def main():
    popup = Image.open(os.path.join(ART, "popup.png")).convert("RGB")
    zoomed = Image.open(os.path.join(ART, "popup-zoomed.png")).convert("RGB")
    icons = Image.open(os.path.join(ART, "icons.png")).convert("RGB")

    w, h = popup.size
    print(f"popup image: {w}x{h}   corner pixel: {popup.getpixel((2, 2))}")

    lens_box = (16, 61, 342, 212)
    print(
        "lens artwork: brass px=%d distinct colours=%d non-bg px=%d"
        % (brass_count(popup, lens_box), distinct(popup, lens_box), non_bg(popup, lens_box))
    )
    print(
        "zoomed lens: brass px=%d distinct colours=%d  (brass must grow when zooming in)"
        % (brass_count(zoomed, lens_box), distinct(zoomed, lens_box))
    )

    header_box = (16, 16, 200, 52)
    print("header: non-bg px=%d (wordmark + glyph render)" % non_bg(popup, header_box))

    right_edge = non_bg(popup, (w - 2, 0, w, h))
    left_edge = non_bg(popup, (0, 0, 2, h))
    bottom = non_bg(popup, (0, h - 2, w, h))
    print(f"edge bleed: right={right_edge} left={left_edge} bottom={bottom}")

    # icons.png: two strips of four sizes (16,32,48,128) with 26px tags
    iw, ih = icons.size
    print(f"icon sheet: {iw}x{ih}")
    half = ih // 2
    for name, box in (("light", (0, 0, iw, half)), ("dark", (0, half, iw, ih))):
        strip = icons.crop(box)
        print(f"  {name} strip brass px={sum(1 for p in strip.getdata() if is_brass(p))}")

    # 16px icon is the smallest one on each strip; count its palette
    icon16 = Image.open(os.path.join(ART, "..", "icons", "icon16.png")).convert("RGBA")
    opaque = [p for p in icon16.getdata() if p[3] > 40]
    print(
        "icon16: opaque px=%d distinct=%d brass=%d  (needs a ring, glass and a handle)"
        % (len(opaque), len(set(opaque)), sum(1 for p in opaque if is_brass(p)))
    )


if __name__ == "__main__":
    main()
