# Cuts the meeting room's seated side views (local F3c sheets, seated jobs) out of their plain
# backgrounds: a flood fill from the border over the near-background colour, a soft edge, cropped to
# the figure. Every pick faces right; the page mirrors it for the seats on the right of the table.
#   python cut-seated.py <dir with the picks> [out dir]  (default: public/avatar/meeting/seated)
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "avatar", "meeting", "seated")
# the picks (seated, near profile, a pose of their own); "flip": drawn facing left, mirrored to face right
PICKS = {"claudechan": ("claude_v2_606", False), "gpichan": ("gpt_v2_603", True), "gemmini": ("gemini_v2_603", True), "grok-x": ("grok_v2_605", False), "dotchan": ("dot_v2_602", True)}
H_OUT = 900  # height of the cut figure (head to chair casters)
os.makedirs(OUT, exist_ok=True)
meta = {}
for rig, (name, flip) in PICKS.items():
    im = Image.open(os.path.join(SRC, name + ".png")).convert("RGB")
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    a = np.asarray(im).astype(np.int16)
    # the background: its colour from the corners
    bg = np.median(np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3), a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)]), axis=0)
    d = np.abs(a - bg).max(axis=2)
    sat = a.max(axis=2) - a.min(axis=2)
    near = (d < 16) & (sat < 14)
    lab, _ = ndimage.label(near)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bgmask = np.isin(lab, list(border))
    # the floor shadow (grey, below the figure) goes too: light, unsaturated, near the bottom
    fig = ~bgmask
    ys = np.where(fig.any(axis=1))[0]
    low = ys.max() - 70
    shadow = np.zeros_like(fig)
    shadow[low:] = (sat[low:] < 14) & (a[low:].mean(axis=2) > 120)
    lab2, _ = ndimage.label(shadow | bgmask)
    keep2 = set(np.unique(lab2[bgmask])) - {0}
    bgmask = np.isin(lab2, list(keep2))
    alpha = Image.fromarray(np.where(bgmask, 0, 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    rgba = im.convert("RGBA")
    rgba.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    rgba = rgba.crop(box)
    k = H_OUT / rgba.height
    rgba = rgba.resize((round(rgba.width * k), H_OUT), Image.LANCZOS)
    # the face: the topmost rows' rightmost opaque column (the profile looks right) gives the nose side
    al = np.asarray(rgba.split()[3]) > 128
    rows = np.where(al.any(axis=1))[0]
    head_top = int(rows.min())
    # the head: the middle of what is opaque in the top 130 rows
    xs = np.where(al[head_top:head_top + 130].any(axis=0))[0]
    head_x = int((xs.min() + xs.max()) / 2)
    rgba.save(os.path.join(OUT, f"{rig}.webp"), quality=90, method=6)
    meta[rig] = {"w": rgba.width, "h": rgba.height, "top": head_top, "headX": head_x}
    print(rig, rgba.size)
# copy this into src/avatar/meetingArt.ts (SEATED)
print(json.dumps(meta))
