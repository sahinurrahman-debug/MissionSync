#!/usr/bin/env python
"""Render docs/sketch.excalidraw to docs/sketch.png (static backup).

Excalidraw's own "Export image" is the canonical path, but this script keeps the
backup reproducible from the scene file alone: it draws the same rectangles,
ellipses, arrows and text the scene contains, so the PNG can be regenerated any
time the scene changes.

Usage (from the project root):

    python scripts/render_sketch.py            # 2x export to docs/sketch.png
    python scripts/render_sketch.py --scale 3  # bigger export
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Iterable, Sequence

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE = os.path.join(ROOT, "docs", "sketch.excalidraw")
OUT = os.path.join(ROOT, "docs", "sketch.png")

PADDING = 30  # scene units of whitespace around the drawing
BG = "#ffffff"

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

Point = tuple[float, float]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def text_lines(el: dict) -> list[str]:
    return str(el.get("text", "")).split("\n")


def text_block_height(el: dict) -> float:
    size = el.get("fontSize", 16)
    line_height = el.get("lineHeight", 1.25)
    return len(text_lines(el)) * size * line_height


def bounds(elements: Iterable[dict]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for el in elements:
        x, y = el["x"], el["y"]
        w, h = el.get("width", 0), el.get("height", 0)
        if el["type"] == "arrow":
            for px, py in el.get("points", [[0, 0]]):
                xs.append(x + px)
                ys.append(y + py)
            continue
        if el["type"] == "text":
            h = text_block_height(el) or h
        xs.extend([x, x + w])
        ys.extend([y, y + h])
    return min(xs), min(ys), max(xs), max(ys)


def dashed_segment(
    draw: ImageDraw.ImageDraw,
    start: Point,
    end: Point,
    fill: str,
    width: int,
    dash: float = 12.0,
    gap: float = 8.0,
) -> None:
    length = math.hypot(end[0] - start[0], end[1] - start[1])
    if length == 0:
        return
    ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length
    pos = 0.0
    while pos < length:
        stop = min(pos + dash, length)
        draw.line(
            [
                (start[0] + ux * pos, start[1] + uy * pos),
                (start[0] + ux * stop, start[1] + uy * stop),
            ],
            fill=fill,
            width=width,
        )
        pos = stop + gap


def polyline(
    draw: ImageDraw.ImageDraw,
    pts: Sequence[Point],
    color: str,
    width: int,
    dashed: bool,
) -> None:
    for a, b in zip(pts, pts[1:]):
        if dashed:
            dashed_segment(draw, a, b, color, width)
        else:
            draw.line([a, b], fill=color, width=width)


def arrowhead(draw: ImageDraw.ImageDraw, tip: Point, tail: Point, color: str) -> None:
    """Small filled triangle at `tip`, pointing away from `tail`."""
    angle = math.atan2(tip[1] - tail[1], tip[0] - tail[0])
    size = 13.0
    spread = math.radians(26)
    left = (tip[0] - size * math.cos(angle - spread), tip[1] - size * math.sin(angle - spread))
    right = (tip[0] - size * math.cos(angle + spread), tip[1] - size * math.sin(angle + spread))
    draw.polygon([tip, left, right], fill=color)


def rounded_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    radius: float,
    outline: str,
    fill: str | None,
    width: int,
    dashed: bool,
) -> None:
    if dashed:
        # PIL's rounded_rectangle has no dash support; approximate the outline
        # with dashed edges plus solid rounded corners.
        x0, y0, x1, y1 = box
        if fill:
            draw.rounded_rectangle(box, radius=radius, fill=fill)
        polyline(draw, [(x0 + radius, y0), (x1 - radius, y0)], outline, width, True)
        polyline(draw, [(x1, y0 + radius), (x1, y1 - radius)], outline, width, True)
        polyline(draw, [(x1 - radius, y1), (x0 + radius, y1)], outline, width, True)
        polyline(draw, [(x0, y1 - radius), (x0, y0 + radius)], outline, width, True)
        for cx, cy, start in (
            (x0 + radius, y0 + radius, 180),
            (x1 - radius, y0 + radius, 270),
            (x1 - radius, y1 - radius, 0),
            (x0 + radius, y1 - radius, 90),
        ):
            draw.arc(
                [cx - radius, cy - radius, cx + radius, cy + radius],
                start=start,
                end=start + 90,
                fill=outline,
                width=width,
            )
        return
    draw.rounded_rectangle(box, radius=radius, outline=outline, fill=fill, width=width)


def render(scene: dict, scale: float) -> Image.Image:
    elements = [el for el in scene.get("elements", []) if not el.get("isDeleted")]
    min_x, min_y, max_x, max_y = bounds(elements)

    # Scene units -> pixels, with padding on all sides.
    offset_x, offset_y = PADDING - min_x, PADDING - min_y
    width = int(round((max_x - min_x + 2 * PADDING) * scale))
    height = int(round((max_y - min_y + 2 * PADDING) * scale))
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    def tp(x: float, y: float) -> Point:
        return ((x + offset_x) * scale, (y + offset_y) * scale)

    def px(v: float) -> float:
        return v * scale

    for el in elements:
        kind = el["type"]
        stroke = el.get("strokeColor", "#1e1e1e")
        background = el.get("backgroundColor", "transparent")
        fill = None if background in (None, "transparent") else background
        sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
        dashed = el.get("strokeStyle") == "dashed"
        x, y = el["x"], el["y"]
        w, h = el.get("width", 0), el.get("height", 0)

        if kind == "rectangle":
            x0, y0 = tp(x, y)
            x1, y1 = tp(x + w, y + h)
            roundness = el.get("roundness")
            radius = 0.0
            if roundness:
                radius = px(min(32.0, min(w, h) * 0.25))
            if radius > 1:
                rounded_rect(draw, (x0, y0, x1, y1), radius, stroke, fill, sw, dashed)
            else:
                if fill:
                    draw.rectangle((x0, y0, x1, y1), fill=fill)
                if dashed:
                    polyline(
                        draw,
                        [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)],
                        stroke,
                        sw,
                        True,
                    )
                else:
                    draw.rectangle((x0, y0, x1, y1), outline=stroke, width=sw)

        elif kind == "ellipse":
            box = (*tp(x, y), *tp(x + w, y + h))
            draw.ellipse(box, fill=fill, outline=stroke, width=sw)

        elif kind == "arrow":
            pts = [tp(x + p[0], y + p[1]) for p in el.get("points", [[0, 0]])]
            polyline(draw, pts, stroke, sw, dashed)
            if el.get("endArrowhead") and len(pts) >= 2:
                arrowhead(draw, pts[-1], pts[-2], stroke)
            if el.get("startArrowhead") and len(pts) >= 2:
                arrowhead(draw, pts[0], pts[1], stroke)

        elif kind == "text":
            size = el.get("fontSize", 16)
            font = load_font(int(round(size * scale)))
            color = el.get("strokeColor", "#1e1e1e")
            line_height = el.get("lineHeight", 1.25)
            lines = text_lines(el)
            if el.get("textAlign") == "center":
                anchor_x = x + w / 2
            elif el.get("textAlign") == "right":
                anchor_x = x + w
            else:
                anchor_x = x
            for i, line in enumerate(lines):
                anchor = "mm" if el.get("textAlign") == "center" else ("rm" if el.get("textAlign") == "right" else "lm")
                ty = y + i * size * line_height + size * line_height / 2
                draw.text(tp(anchor_x, ty), line, font=font, fill=color, anchor=anchor)

    return img


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", default=SCENE)
    parser.add_argument("--out", default=OUT)
    parser.add_argument("--scale", type=float, default=2.0, help="export scale (Excalidraw uses 2x)")
    args = parser.parse_args()

    with open(args.scene, encoding="utf-8") as fh:
        scene = json.load(fh)

    img = render(scene, args.scale)
    img.save(args.out)
    print(f"wrote {os.path.relpath(args.out, ROOT)} ({img.width}x{img.height}, {len(scene['elements'])} elements)")


if __name__ == "__main__":
    main()
