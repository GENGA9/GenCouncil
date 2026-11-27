# Finds each rig's two irises (centre and radius, on the rig's base art) for the avatar mode's gaze:
# within the rig's eye region, the iris is the coloured, mid-dark blob of each half (not the white,
# not the skin, not the black lash line). Prints them and draws a check sheet with circles.
#   python find-irises.py <check.png>
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw

RIGS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../resources/agentg/assets/rigs"))
NAMES = ["claudechan", "gpichan", "gemmini", "grok-x", "dotchan", "claudechan-full"]

out = {}
tiles = []
for name in NAMES:
    d = os.path.join(RIGS, name)
    j = json.load(open(os.path.join(d, "rig.json"), encoding="utf8"))
    x0, y0, w, h = j["regions"]["eyes"]
    base = Image.open(os.path.join(d, "base.png")).convert("RGB")
    a = np.asarray(base.crop((x0, y0, x0 + w, y0 + h)), dtype=np.float32) / 255
    mx, mn = a.max(-1), a.min(-1)
    lum = a.mean(-1)
    sat = (mx - mn) / (mx + 1e-4)
    # skin is light and only a little saturated; the white is light; the lash line is near black
    iris = (lum < 0.62) & (lum > 0.08) & ((sat > 0.28) | (lum < 0.35)) & ~((a[..., 0] > 0.75) & (a[..., 1] > 0.55))
    res = []
    for half in (0, 1):
        sub = iris[:, half * w // 2 : (half + 1) * w // 2]
        ys, xs = np.nonzero(sub)
        if len(xs) < 20:
            res.append(None)
            continue
        # the blob's core: trim the outer 10% so stray lash pixels do not pull it
        cx, cy = np.median(xs) + half * w // 2, np.median(ys)
        rx = (np.percentile(xs, 92) - np.percentile(xs, 8)) / 2
        ry = (np.percentile(ys, 92) - np.percentile(ys, 8)) / 2
        res.append([round(float(cx + x0)), round(float(cy + y0)), round(float(rx)), round(float(ry))])
    out[name] = res
    t = base.crop((x0 - 20, y0 - 20, x0 + w + 20, y0 + h + 20)).copy()
    dr = ImageDraw.Draw(t)
    for r in res:
        if r:
            cx, cy, rx, ry = r[0] - x0 + 20, r[1] - y0 + 20, r[2], r[3]
            dr.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), outline=(0, 255, 0), width=2)
            dr.line((cx - 4, cy, cx + 4, cy), fill=(255, 0, 0), width=2)
    tiles.append(t.resize((t.width * 300 // t.height, 300)))
print(json.dumps(out))
W = sum(t.width for t in tiles) + 10 * len(tiles)
sheet = Image.new("RGB", (W, 300), (40, 30, 30))
x = 0
for t in tiles:
    sheet.paste(t, (x, 0))
    x += t.width + 10
sheet.save(sys.argv[1])
