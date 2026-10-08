#!/usr/bin/env python3
"""Measure the Omniglot Trunic fixtures and write test/fixtures/measurements.json.

Requires Pillow and numpy (dev-only; the app and tests need neither):
    python3 -m venv /tmp/imgenv && /tmp/imgenv/bin/pip install pillow numpy
    /tmp/imgenv/bin/python tools/measure_glyphs.py

Glyph *labels* and IPA are transcribed by hand in test/trunic.test.js / trunic.js;
this script derives everything else (counts, boxes, strokes, segment masks) from pixels.
"""
import json
import os
import statistics
from collections import deque

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "test", "fixtures")

# Sample points (x, y) inside each glyph box, one per segment, in box pixels.
# Vowel boxes are 23x36, consonant boxes 30x46 (asserted below).
OUTER_PROBES = {  # vowels (outer 6); the bar is shared by every glyph
    "roofLeft": (7, 3), "roofRight": (15, 3),
    "wallUpLeft": (2, 11), "wallLowLeft": (2, 26),
    "keelLeft": (5, 31), "keelRight": (17, 31),
    # right-hand walls are probed only to prove no chart vowel uses them
    "_wallUpRight": (20, 11), "_wallLowRight": (20, 26),
}
INNER_PROBES = {  # consonants (inner 7)
    "stemUp": (14, 8), "slantUpLeft": (5, 10), "slantUpRight": (24, 10),
    "bar": (14, 21),
    "slantLowLeft": (6, 34), "slantLowRight": (23, 34), "stemLow": (14, 41),
}
VOWEL_BAR_PROBE = (11, 17)


def bands(mask_1d, merge_gap=0):
    out, start = [], None
    for i, v in enumerate(list(mask_1d) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append([start, i - 1])
            start = None
    merged = []
    for b in out:
        if merged and b[0] - merged[-1][1] - 1 <= merge_gap:
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    return merged


def measure_chart():
    path = os.path.join(FIX, "trunic.gif")
    ink = np.array(Image.open(path).convert("L")) < 128
    h, w = ink.shape
    rows = [b for b in bands(ink.any(axis=1), merge_gap=6) if b[1] - b[0] + 1 >= 30]
    glyphs = []
    for r, (y0, y1) in enumerate(rows):
        for x0, x1 in bands(ink[y0:y1 + 1].any(axis=0), merge_gap=6):
            ys = np.where(ink[y0:y1 + 1, x0:x1 + 1].any(axis=1))[0]
            glyphs.append({"row": r, "x": x0, "w": x1 - x0 + 1,
                           "y": y0 + int(ys.min()), "h": int(ys.max() - ys.min() + 1)})
    return ink, (w, h), rows, glyphs


def on(ink, x, y):
    return int(ink[y - 1:y + 2, x - 1:x + 2].sum()) >= 5


def classify(ink, glyphs, rows):
    vowels, consonants = [], []
    for g in glyphs:
        (vowels if g["w"] < 26 else consonants).append(g)
    result = {"vowels": [], "consonants": []}
    for g in vowels:
        y0 = rows[g["row"]][0]
        # vowel boxes are 23 wide, 36 tall, anchored at the row's top
        assert g["w"] == 23 and rows[g["row"]][1] - y0 + 1 == 36, g
        segs = [k for k, (px, py) in OUTER_PROBES.items() if on(ink, g["x"] + px, y0 + py)]
        assert on(ink, g["x"] + VOWEL_BAR_PROBE[0], y0 + VOWEL_BAR_PROBE[1])
        result["vowels"].append({"row": g["row"], "x": g["x"], "outer": segs, "bar": True})
    for g in consonants:
        y0 = rows[g["row"]][0]
        assert g["w"] == 30 and rows[g["row"]][1] - y0 + 1 == 46, g
        segs = [k for k, (px, py) in INNER_PROBES.items() if on(ink, g["x"] + px, y0 + py)]
        result["consonants"].append({"row": g["row"], "x": g["x"], "inner": segs})
    return result


def stroke_rows(ink, x0, w, y0, y1):
    """Rows within [y0,y1] where >=90% of the glyph width is ink: the shared bar."""
    cover = ink[y0:y1 + 1, x0:x0 + w].sum(axis=1) / w
    ys = [y0 + i for i, c in enumerate(cover) if c >= 0.9]
    return ys


def measure_spines(ink):
    """Word bars of the sample: the long horizontal runs on each line's bar row.

    A word of n glyphs has a bar of barRun + (n - 1) * pitch pixels (neighbouring
    glyph bars overlap a little), so the distinct run lengths form a ladder whose
    rung spacing is the pitch and whose first rung is one glyph's bar.
    """
    h, w = ink.shape
    counts = ink.sum(axis=1)
    # bar rows: the middle row of each band of rows holding more than 3/4 of the peak count
    peak = counts.max()
    bar_rows, band = [], []
    for y in range(h + 1):
        if y < h and counts[y] > 0.75 * peak:
            band.append(y)
        elif band:
            bar_rows.append(band[len(band) // 2])
            band = []
    lengths = []
    for y in bar_rows:
        for x0, x1 in bands(ink[y], merge_gap=0):
            if x1 - x0 + 1 >= 15:
                lengths.append(x1 - x0 + 1)
    # cluster run lengths (they jitter by a pixel from antialiasing)
    clusters = []
    for v in sorted(lengths):
        if clusters and v - clusters[-1][-1] <= 2:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    rungs = [statistics.mean(c) for c in clusters]
    gaps = [b - a for a, b in zip(rungs, rungs[1:])]
    unit = min(gaps)
    pitch = statistics.median(g / round(g / unit) for g in gaps)
    return {"runLengths": [round(r, 1) for r in rungs], "pitch": pitch, "barRun": rungs[0]}


def measure_sample():
    path = os.path.join(FIX, "smp_trunic.jpg")
    img = Image.open(path).convert("L")
    g = np.array(img).astype(int)
    ink = g < 110
    h, w = ink.shape
    lab = np.zeros(ink.shape, int)
    comps = []
    n = 0
    for y in range(h):
        for x in range(w):
            if ink[y, x] and not lab[y, x]:
                n += 1
                q = deque([(y, x)])
                lab[y, x] = n
                pts = []
                while q:
                    cy, cx = q.popleft()
                    pts.append((cy, cx))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < h and 0 <= nx < w and ink[ny, nx] and not lab[ny, nx]:
                                lab[ny, nx] = n
                                q.append((ny, nx))
                ys = [p[0] for p in pts]
                xs = [p[1] for p in pts]
                comps.append({"x": min(xs), "y": min(ys), "w": max(xs) - min(xs) + 1,
                              "h": max(ys) - min(ys) + 1, "area": len(pts)})
    # first glyph: left-most components in the first text line (upper + lower half)
    # line 1 ends near y=50; line 2 starts near y=56, so cut well between them
    first_line = [c for c in comps if c["y"] < 50]
    min_x = min(c["x"] for c in first_line)
    first = [c for c in first_line if c["x"] <= min_x + 1 and c["w"] >= 20]
    fx0 = min(c["x"] for c in first)
    fx1 = max(c["x"] + c["w"] for c in first)
    fy0 = min(c["y"] for c in first)
    fy1 = max(c["y"] + c["h"] for c in first)
    box_w, box_h = fx1 - fx0, fy1 - fy0
    bar = stroke_rows(ink, fx0, box_w, fy0, fy1 - 1)
    # circles: filled-ish 7..9 px round blobs sitting under a glyph
    circles = []
    for c in comps:
        if 7 <= c["w"] <= 9 and 7 <= c["h"] <= 9:
            above = [d for d in comps if d is not c and d["x"] < c["x"] + c["w"]
                     and d["x"] + d["w"] > c["x"] and d["y"] + d["h"] <= c["y"] + 2
                     and d["y"] + d["h"] > c["y"] - 12]
            if above:
                bottom = max(d["y"] + d["h"] for d in above)
                circles.append({"d": (c["w"] + c["h"]) / 2, "gap": c["y"] - bottom})
    spines = measure_spines(ink)
    runs = []
    for row in ink:
        runs.extend(b - a + 1 for a, b in bands(row, merge_gap=0))
    return {
        "size": [w, h],
        "firstGlyph": {"w": box_w, "h": box_h, "aspect": round(box_w / box_h, 3)},
        "medianRun": int(statistics.median(runs)),
        "spines": {
            "runLengths": spines["runLengths"],
            "pitch": round(spines["pitch"], 2),
            "pitchOverHeight": round(spines["pitch"] / box_h, 3),
            "barRun": round(spines["barRun"], 2),
            "barRunOverHeight": round(spines["barRun"] / box_h, 3),
        },
        "barRows": len(bar),
        "barThicknessOverHeight": round(len(bar) / box_h, 3),
        "barCentreFromTop": round(((bar[0] + bar[-1] + 1) / 2 - fy0) / box_h, 3),
        "circles": circles,
        "circleDiameterOverHeight": round(statistics.median(c["d"] for c in circles) / box_h, 3),
        "circleGapOverHeight": round(statistics.median(c["gap"] for c in circles) / box_h, 3),
    }


def main():
    ink, (w, h), rows, glyphs = measure_chart()
    cls = classify(ink, glyphs, rows)
    per_row = [sum(1 for g in glyphs if g["row"] == r) for r in range(len(rows))]
    vbox = next(g for g in glyphs if g["w"] < 26)
    cbox = next(g for g in glyphs if g["w"] >= 26)
    vrow = rows[vbox["row"]]
    crow = rows[cbox["row"]]
    vbar = stroke_rows(ink, vbox["x"], 23, vrow[0], vrow[1])
    cbar = stroke_rows(ink, cbox["x"], 30, crow[0], crow[1])
    out = {
        "chart": {
            "file": "trunic.gif", "size": [w, h],
            "glyphsPerRow": per_row,
            "vowelCount": len(cls["vowels"]),
            "consonantCount": len(cls["consonants"]),
            "vowelBox": {"w": 23, "h": 36, "aspect": round(23 / 36, 3),
                         "barThickness": len(vbar), "barCentreFromTop": round(((vbar[0] + vbar[-1] + 1) / 2 - vrow[0]) / 36, 3)},
            "consonantBox": {"w": 30, "h": 46, "aspect": round(30 / 46, 3),
                             "barThickness": len(cbar), "barCentreFromTop": round(((cbar[0] + cbar[-1] + 1) / 2 - crow[0]) / 46, 3)},
            "cellPitch": glyphs[1]["x"] - glyphs[0]["x"],
            "unusedOuterProbes": sorted({s for v in cls["vowels"] for s in v["outer"] if s.startswith("_")}),
        },
        "sample": measure_sample(),
        "chartMasks": cls,
    }
    with open(os.path.join(FIX, "measurements.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(json.dumps({k: v for k, v in out.items() if k != "chartMasks"}, indent=1))


if __name__ == "__main__":
    main()
