# Fits the eye and mouth patches to the face under them: a patch was painted apart from the base, so its
# skin is a shade off (lighter, the blush gone), a box round the mouth while she talks. The patch's skin
# takes the face's soft shading (each one's skin with its lines filled over, blurred; the difference added),
# so no line of either is copied; its lips, the mouth's inside and lashes stay as drawn.
#   python blend-patches.py <public/avatar> <positions.json> [backup dir]   (run on patches once: it is also
#   applied by import-agentg.py to each mouth it brings in, so only use it on mouths not just imported)
# positions.json: [{"rig": "claudechan", "eyes": [x, y, w, h], "mouth": [x, y, w, h]}, ...] (cast.ts)
import json, os, shutil, sys
import numpy as np
from PIL import Image, ImageFilter



def laplace_fill(img: np.ndarray, known: np.ndarray, iters: int = 2500) -> np.ndarray:
    """img with the unknown pixels filled smoothly from the known ones round them"""
    out = img.copy()
    out[~known] = img[known].mean(0) if known.any() else 0
    free = ~known
    for _ in range(iters):
        p = np.pad(out, ((1, 1), (1, 1), (0, 0)), mode="edge")
        out[free] = ((p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4)[free]
    return out


def blur(img: np.ndarray, r: float) -> np.ndarray:
    return np.stack([np.asarray(Image.fromarray(np.clip(img[..., c], 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) for c in range(3)], -1)


def skin_of(img: np.ndarray, solid: np.ndarray) -> np.ndarray:
    """where an image is plain skin: near its usual skin colour and not a dark line"""
    ref = np.median(img[solid], axis=0)
    lum = img.mean(-1)
    # a tongue or lips are a stronger pink than skin
    sat = (img.max(-1) - img.min(-1)) / np.maximum(img.max(-1), 1)
    ref_sat = (ref.max() - ref.min()) / max(ref.max(), 1)
    return solid & (np.sqrt(((img - ref) ** 2).sum(-1)) < 38) & (lum > ref.mean() - 22) & (sat < ref_sat + 0.07)


def outer(mask: np.ndarray, solid: np.ndarray) -> np.ndarray:
    """the part of a mask reached from the patch's edge (where it turns transparent) without crossing out
    of it: the skin round the mouth, not the tongue inside its outline"""
    p = np.pad(~solid, 2, constant_values=True)
    edge = np.zeros_like(mask)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            edge |= p[2 + dy : 2 + dy + mask.shape[0], 2 + dx : 2 + dx + mask.shape[1]]
    reach = mask & edge
    while True:
        p = np.pad(reach, 1)
        grown = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | reach) & mask
        if (grown == reach).all():
            return reach
        reach = grown


def fit(patch: np.ndarray, under: np.ndarray) -> tuple[np.ndarray, float]:
    rgb, a = patch[..., :3], patch[..., 3] / 255
    solid = a > 0.05
    base = under[..., :3]
    # the soft shading (blush, shadow) of each one's skin alone: lines filled over, then blurred
    bs = skin_of(base, np.ones_like(solid))
    ps = outer(skin_of(rgb, solid), solid)
    if ps.sum() < 20 or bs.sum() < 20:
        return patch, 0.0
    shade_b = blur(laplace_fill(base, bs), 5)
    shade_p = blur(laplace_fill(rgb, ps), 5)
    # the patch's skin takes the face's shading; its lips, the mouth's inside, lashes stay as drawn
    w = np.asarray(Image.fromarray((ps * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32) / 255
    out = patch.copy()
    out[..., :3][solid] = np.clip(rgb + (shade_b - shade_p) * w[..., None], 0, 255)[solid]
    moved = float(np.abs((shade_b - shade_p)[ps]).mean())
    # a big shift means the inside of the mouth (a light tongue) was taken for skin: left as drawn
    if moved > 12:
        return patch, -moved
    return out, moved


def main():
    root, pos = sys.argv[1], json.load(open(sys.argv[2], encoding="utf8"))
    backup = sys.argv[3] if len(sys.argv) > 3 else None
    for r in pos:
        d = os.path.join(root, r["rig"])
        base = np.asarray(Image.open(os.path.join(d, "base.webp")).convert("RGBA"), dtype=np.float32)
        for f in sorted(os.listdir(d)):
            # the mouths only: the eye patches sit under the glasses and their lids, where this smears
            kind = "mouth" if f.startswith("mouth-") else None
            if not kind or not f.endswith(".webp"):
                continue
            x, y, w, h = r[kind]
            path = os.path.join(d, f)
            im = Image.open(path).convert("RGBA")
            if im.size != (w, h):
                print(r["rig"], f, "size", im.size, "is not the box", (w, h), "- skipped")
                continue
            if backup:
                os.makedirs(os.path.join(backup, r["rig"]), exist_ok=True)
                if not os.path.exists(os.path.join(backup, r["rig"], f)):
                    shutil.copy2(path, os.path.join(backup, r["rig"], f))
            out, shift = fit(np.asarray(im, dtype=np.float32), base[y : y + h, x : x + w])
            if shift > 0:
                Image.fromarray(out.astype(np.uint8), "RGBA").save(path, "WEBP", lossless=True)
            print(r["rig"], f, "shading moved", round(shift, 2))


if __name__ == "__main__":
    main()
