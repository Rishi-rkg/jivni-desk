"""Draw the Jivni "J+" mark and write every icon file from one description of its shape.

    python packaging/make_icons.py

Writes the vector master (SVG, colour and one-colour), PNGs, the Windows .ico and the macOS .icns
into packaging/icons, and the browser icon into frontend/public. The geometry lives in SHAPES below,
on a 1024-unit square, and is used for both the SVG text and the Pillow drawing, so they cannot drift apart.

The mark: a bold J whose hook ends in a leaf, as a stem does, and a plus set high on its right like a
superscript. The leaf is for homeopathy; the plus is for care.
The one-colour version is for the black-and-white thermal label printer.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packaging" / "icons"
PUBLIC = ROOT / "frontend" / "public"

SIZE = 1024
TEAL_TOP, TEAL_BOTTOM = (47, 111, 132), (27, 70, 86)
WHITE, GOLD, BLACK, LEAF = (255, 255, 255), (246, 196, 83), (0, 0, 0), (146, 214, 130)

STROKE = 124  # thickness of the J
STEM_X, STEM_TOP, STEM_BOTTOM = 566, 262, 628  # centre line of the J's upright
HOOK_RADIUS = 168  # centre line of the hook
HOOK_CX, HOOK_CY = STEM_X - HOOK_RADIUS, STEM_BOTTOM
HOOK_END_DEGREES = 138  # the hook runs from the upright (0 degrees) round the bottom to here, where the leaf begins
BAR_LEFT = 356  # the J's top bar reaches left from the upright
PLUS_CX, PLUS_CY, PLUS_ARM, PLUS_THICK = 772, 262, 96, 66
TILE_RADIUS = 228
# The leaf grows from the end of the hook: how far its tip is from there, how full each side is, and its vein.
LEAF_TIP_OFFSET = (-108, -296)
LEAF_BULGE_OUTER, LEAF_BULGE_INNER = 176, 118
LEAF_VEIN, LEAF_VEIN_REACH = 15, 0.74


def hook_end():
    angle = math.radians(HOOK_END_DEGREES)
    return HOOK_CX + HOOK_RADIUS * math.cos(angle), HOOK_CY + HOOK_RADIUS * math.sin(angle)


def leaf():
    """Base, tip, the two control points of its curved sides, and the end of its vein."""
    base = hook_end()
    tip = (base[0] + LEAF_TIP_OFFSET[0], base[1] + LEAF_TIP_OFFSET[1])
    middle = ((base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2)
    length = math.hypot(tip[0] - base[0], tip[1] - base[1])
    across = ((tip[1] - base[1]) / length, -(tip[0] - base[0]) / length)  # unit vector pointing to the leaf's outer side
    outer = (middle[0] + across[0] * LEAF_BULGE_OUTER, middle[1] + across[1] * LEAF_BULGE_OUTER)
    inner = (middle[0] - across[0] * LEAF_BULGE_INNER, middle[1] - across[1] * LEAF_BULGE_INNER)
    vein = (base[0] + (tip[0] - base[0]) * LEAF_VEIN_REACH, base[1] + (tip[1] - base[1]) * LEAF_VEIN_REACH)
    return base, tip, outer, inner, vein


def curve(start, control, end, steps=48):
    """Points along a quadratic curve, for drawing the leaf with Pillow."""
    for step in range(steps + 1):
        t = step / steps
        yield (
            (1 - t) ** 2 * start[0] + 2 * (1 - t) * t * control[0] + t**2 * end[0],
            (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * control[1] + t**2 * end[1],
        )


def svg(mono=False):
    j, plus, green, vein_colour = ("#000", "#000", "#000", "#fff") if mono else ("#fff", "#f6c453", "#92d682", "#1f5062")
    end_x, end_y = hook_end()
    base, tip, outer, inner, vein = leaf()
    tile = (
        ""
        if mono
        else (
            '<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#2f6f84"/><stop offset="1" stop-color="#1b4656"/></linearGradient></defs>'
            f'<rect width="{SIZE}" height="{SIZE}" rx="{TILE_RADIUS}" fill="url(#t)"/>'
        )
    )
    half = PLUS_THICK / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="Jivni">'
        f"{tile}"
        f'<path d="M{BAR_LEFT} {STEM_TOP}H{STEM_X}V{STEM_BOTTOM}A{HOOK_RADIUS} {HOOK_RADIUS} 0 0 1 {end_x:.1f} {end_y:.1f}" '
        f'fill="none" stroke="{j}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="M{base[0]:.1f} {base[1]:.1f}Q{outer[0]:.1f} {outer[1]:.1f} {tip[0]:.1f} {tip[1]:.1f}'
        f'Q{inner[0]:.1f} {inner[1]:.1f} {base[0]:.1f} {base[1]:.1f}Z" fill="{green}"/>'
        f'<path d="M{base[0]:.1f} {base[1]:.1f}L{vein[0]:.1f} {vein[1]:.1f}" '
        f'stroke="{vein_colour}" stroke-width="{LEAF_VEIN}" stroke-linecap="round"/>'
        f'<rect x="{PLUS_CX - PLUS_ARM}" y="{PLUS_CY - half}" width="{PLUS_ARM * 2}" height="{PLUS_THICK}" rx="{half}" fill="{plus}"/>'
        f'<rect x="{PLUS_CX - half}" y="{PLUS_CY - PLUS_ARM}" width="{PLUS_THICK}" height="{PLUS_ARM * 2}" rx="{half}" fill="{plus}"/>'
        "</svg>\n"
    )


def draw(mono=False, scale=4):
    """The same mark with Pillow, drawn large and reduced so the edges are smooth."""
    size = SIZE * scale

    def s(value):
        return int(round(value * scale))

    if mono:
        image = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        j_colour, plus_colour, leaf_colour, vein_colour = BLACK, BLACK, BLACK, WHITE
    else:
        gradient = Image.new("RGBA", (1, size))
        for y in range(size):
            mix = y / (size - 1)
            gradient.putpixel((0, y), tuple(int(TEAL_TOP[i] + (TEAL_BOTTOM[i] - TEAL_TOP[i]) * mix) for i in range(3)) + (255,))
        gradient = gradient.resize((size, size))
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=s(TILE_RADIUS), fill=255)
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        image.paste(gradient, (0, 0), mask)
        j_colour, plus_colour, leaf_colour, vein_colour = WHITE, GOLD, LEAF, (31, 80, 98)
    pen = ImageDraw.Draw(image)
    half = STROKE / 2

    def dot(x, y):
        pen.ellipse([s(x - half), s(y - half), s(x + half), s(y + half)], fill=j_colour)

    # Top bar and upright, with round ends and a round outer corner.
    pen.rectangle([s(BAR_LEFT), s(STEM_TOP - half), s(STEM_X), s(STEM_TOP + half)], fill=j_colour)
    pen.rectangle([s(STEM_X - half), s(STEM_TOP), s(STEM_X + half), s(STEM_BOTTOM)], fill=j_colour)
    dot(BAR_LEFT, STEM_TOP)
    dot(STEM_X, STEM_TOP)
    # Hook: a thick arc from the upright round the bottom, finished with a round end.
    outer = HOOK_RADIUS + half
    box = [s(HOOK_CX - outer), s(HOOK_CY - outer), s(HOOK_CX + outer), s(HOOK_CY + outer)]
    pen.arc(box, start=0, end=HOOK_END_DEGREES, fill=j_colour, width=s(STROKE))
    dot(*hook_end())
    # Leaf, over the end of the hook, with its vein.
    base, tip, outer, inner, vein = leaf()
    outline = list(curve(base, outer, tip)) + list(curve(tip, inner, base))
    pen.polygon([(s(x), s(y)) for x, y in outline], fill=leaf_colour)
    pen.line([s(base[0]), s(base[1]), s(vein[0]), s(vein[1])], fill=vein_colour, width=s(LEAF_VEIN))
    for x, y in (base, vein):
        pen.ellipse([s(x - LEAF_VEIN / 2), s(y - LEAF_VEIN / 2), s(x + LEAF_VEIN / 2), s(y + LEAF_VEIN / 2)], fill=vein_colour)
    # Plus.
    thick = PLUS_THICK / 2
    pen.rounded_rectangle(
        [s(PLUS_CX - PLUS_ARM), s(PLUS_CY - thick), s(PLUS_CX + PLUS_ARM), s(PLUS_CY + thick)], radius=s(thick), fill=plus_colour
    )
    pen.rounded_rectangle(
        [s(PLUS_CX - thick), s(PLUS_CY - PLUS_ARM), s(PLUS_CX + thick), s(PLUS_CY + PLUS_ARM)], radius=s(thick), fill=plus_colour
    )
    return image.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (OUT / "jivni.svg").write_text(svg(), encoding="utf-8", newline="\n")
    (OUT / "jivni-mono.svg").write_text(svg(mono=True), encoding="utf-8", newline="\n")
    (PUBLIC / "logo.svg").write_text(svg(), encoding="utf-8", newline="\n")
    colour, mono = draw(), draw(mono=True)
    colour.save(OUT / "jivni.png")
    mono.save(OUT / "jivni-mono.png")
    colour.resize((256, 256), Image.LANCZOS).save(OUT / "jivni-256.png")
    colour.resize((64, 64), Image.LANCZOS).save(OUT / "jivni-tray.png")
    colour.save(OUT / "jivni.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    colour.save(OUT / "jivni.icns")
    colour.resize((180, 180), Image.LANCZOS).save(PUBLIC / "apple-touch-icon.png")
    print("Wrote", ", ".join(sorted(path.name for path in OUT.iterdir())))


if __name__ == "__main__":
    main()
