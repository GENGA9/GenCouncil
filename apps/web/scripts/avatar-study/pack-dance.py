# Packs a dance video for the avatar mode: the dancer cut out by SAM3 masks (one PNG per frame, from
# ComfyUI SAM3_VideoTrack), cropped to where she ever is, colour on the left and the mask (as grey) on
# the right in one ordinary H.264 video with the original sound, since Safari plays no transparent WebM
# (side by side keeps the frame an ordinary size; an iPhone did not play one twice as tall as wide).
# The page puts the two halves back together in WebGL.
#   python pack-dance.py <video.mp4> <masks dir> <out base, e.g. public/avatar/claudechan-full/dance1> [--fx]
# --fx keeps what was laid over the video too (captions, sparkles), found by their colour (see fx_of).
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageFilter

args = [a for a in sys.argv[1:] if not a.startswith("--")]
FX = "--fx" in sys.argv
video, mask_dir, out = args[0], args[1], args[2]
tmp = out + ".frames"
os.makedirs(tmp, exist_ok=True)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, os.path.join(tmp, "f%04d.png")], check=True)
frames = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
masks = sorted(f for f in os.listdir(mask_dir) if f.endswith(".png"))
n = min(len(frames), len(masks))
fps = 24


def clean(m: np.ndarray) -> np.ndarray:
    """keep what is joined to the body (reconstruction from its core at a quarter size), soft edge"""
    b = m > 127
    small = np.asarray(Image.fromarray(b.astype(np.uint8) * 255).resize((m.shape[1] // 4, m.shape[0] // 4), Image.BILINEAR)) > 60
    core = np.asarray(Image.fromarray(small.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(9))) > 0
    keep = core.copy()
    for _ in range(400):
        grown = keep.copy()
        grown[1:] |= keep[:-1]
        grown[:-1] |= keep[1:]
        grown[:, 1:] |= keep[:, :-1]
        grown[:, :-1] |= keep[:, 1:]
        grown &= small
        if (grown == keep).all():
            break
        keep = grown
    keep_full = np.asarray(Image.fromarray(keep.astype(np.uint8) * 255).resize((m.shape[1], m.shape[0]), Image.NEAREST).filter(ImageFilter.MaxFilter(9))) > 0
    a = Image.fromarray(((b & keep_full) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.9))
    return np.asarray(a)


# the masks may be tracked on a smaller copy of the video: they are scaled up to the frames
size0 = Image.open(os.path.join(tmp, frames[0])).size
alphas = []
for i in range(n):
    m = Image.open(os.path.join(mask_dir, masks[i])).convert("L")
    if m.size != size0:
        m = m.resize(size0, Image.BILINEAR)
    alphas.append(clean(np.asarray(m)))

def load(i: int) -> np.ndarray:
    return np.asarray(Image.open(os.path.join(tmp, frames[i])).convert("RGB"))


def fx_of(rgb: np.ndarray, dancer: np.ndarray):
    """the captions and sparkles laid over the video: warm, strong colours (orange, red, yellow, pink) and
    the white outlines round them; the camera moves, so they are found by colour, not against a still
    background. Returns their alpha and colour."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    warm = (r > b + 70) & (r >= g - 10) & (sat > 0.5) & (mx > 150)
    warm &= dancer < 8
    core = Image.fromarray(warm.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    # how far an outline or fill may lie from the colour, in pixels of a 608-wide frame
    reach = int(15 * rgb.shape[1] / 608) | 1
    near = np.asarray(core.filter(ImageFilter.MaxFilter(reach))) > 0
    # the fills and outlines next to them: white, cream, peach (warmer than the blue sky behind)
    light = ((mn > 222) & (mx - mn < 26)) | ((r > b + 6) & (mx > 170))
    a = (np.asarray(core) > 0) | (light & near)
    a &= np.asarray(Image.fromarray(dancer).filter(ImageFilter.MaxFilter(5))) < 8
    im = Image.fromarray(a.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(0.7))
    return np.asarray(im, dtype=np.float32) / 255, rgb


fxa = []
if FX:
    for i in range(n):
        a, _ = fx_of(load(i).astype(np.float32), alphas[i])
        fxa.append((a * 255).astype(np.uint8))
union = np.zeros_like(alphas[0], dtype=bool)
for i, a in enumerate(alphas):
    union |= a > 8
    if FX:
        union |= fxa[i] > 8
ys, xs = np.nonzero(union)
pad = 16
H0, W0 = alphas[0].shape
x0, x1 = max(0, xs.min() - pad), min(W0, xs.max() + pad)
y0, y1 = max(0, ys.min() - pad), min(H0, ys.max() + pad)
W, H = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
x1, y1 = x0 + W, y0 + H
print("crop", (x0, y0, W, H), "of", (W0, H0))

# where she stands in the first frame: feet (lowest row, middle of it) and height (head to feet)
a0 = alphas[0][y0:y1, x0:x1] > 127
rows = np.nonzero(a0.any(axis=1))[0]
foot_row = rows.max()
cols = np.nonzero(a0[max(0, foot_row - 40) : foot_row + 1].any(axis=0))[0]
meta = {"w": int(W), "h": int(H), "fps": fps, "frames": int(n), "feet": [int((cols.min() + cols.max()) / 2), int(foot_row)], "height": int(foot_row - rows.min()), "duration": round(n / fps, 3)}
print(meta)

enc = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W * 2}x{H}", "-r", str(fps), "-i", "-", "-i", video, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "libx264", "-profile:v", "high", "-level", "5.1", "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", out + ".mp4"],
    stdin=subprocess.PIPE,
)
for i in range(n):
    full = np.asarray(Image.open(os.path.join(tmp, frames[i])).convert("RGB"), dtype=np.float32)
    rgb = full[y0:y1, x0:x1]
    a = alphas[i][y0:y1, x0:x1].astype(np.float32) / 255
    if FX:
        # the dancer over the effects: alpha and colour of the two together
        af, colf = fx_of(full, alphas[i])
        af, colf = af[y0:y1, x0:x1], colf[y0:y1, x0:x1]
        A = a + af * (1 - a)
        rgb = (rgb * a[..., None] + colf * (af * (1 - a))[..., None]) / np.maximum(A, 1e-4)[..., None]
        a = A
    # behind her, her own edge colours spread outwards, so compression smears nothing foreign into her outline
    w = Image.fromarray((a * 255).astype(np.uint8))
    wb = np.asarray(w.filter(ImageFilter.GaussianBlur(10)), dtype=np.float32) / 255 + 1e-4
    fill = np.stack([np.asarray(Image.fromarray((rgb[..., c] * a).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10)), dtype=np.float32) / wb for c in range(3)], -1)
    color = rgb * a[..., None] + np.clip(fill, 0, 255) * (1 - a[..., None])
    alpha = np.repeat((a * 255)[..., None], 3, -1)
    enc.stdin.write(np.concatenate([color, alpha], 1).astype(np.uint8).tobytes())
enc.stdin.close()
enc.wait()
json.dump(meta, open(out + ".json", "w"), indent=1)
for f in frames:
    os.remove(os.path.join(tmp, f))
os.rmdir(tmp)
print("ok", os.path.getsize(out + ".mp4") // 1024, "KB")
