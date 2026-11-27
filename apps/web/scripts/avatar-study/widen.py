# Widens a rig's bust so its arms are drawn whole. A GPT member (Codex image edit) paints the arms on
# the bust padded with flat green, with a strip just inside each old cut line blanked too (so it paints
# across the cut instead of leaving a seam: jobs/arms/msg3.txt). The original art stays pixel for
# pixel everywhere else (the eye and mouth patches must keep lining up).
#   python widen.py pad <rig base.png> <padded-in.png>          writes the padded, blanked input
#   python widen.py merge <rig base.png> <painted.png> <out.webp>
import sys
from PIL import Image, ImageChops, ImageFilter

PAD, BAND, FROM_Y = 192, 56, 820

base = Image.open(sys.argv[2]).convert("RGBA")
w, H = base.size
W = w + 2 * PAD

def keep_mask():
    """where the original is used: all of it but the blanked strips, softened at their inner edge"""
    m = Image.new("L", (W, H), 0)
    m.paste(255, (PAD, 0, PAD + w, H))
    m.paste(0, (PAD, FROM_Y, PAD + BAND + 10, H))
    m.paste(0, (PAD + w - BAND - 10, FROM_Y, PAD + w, H))
    return m.filter(ImageFilter.GaussianBlur(4))

if sys.argv[1] == "pad":
    can = Image.new("RGBA", (W, H), (0, 255, 0, 255))
    can.alpha_composite(base, (PAD, 0))
    g = Image.new("RGBA", (BAND, H - FROM_Y), (0, 255, 0, 255))
    can.paste(g, (PAD, FROM_Y))
    can.paste(g, (PAD + w - BAND, FROM_Y))
    can.convert("RGB").save(sys.argv[3])
    sys.exit(0)

paint = Image.open(sys.argv[3]).convert("RGB")
if paint.size != (W, H):
    paint = paint.resize((W, H), Image.LANCZOS)
orig = Image.new("RGB", (W, H), (0, 255, 0))
orig.paste(base.convert("RGB"), (PAD, 0), base)
d = ImageChops.difference(orig.crop((PAD + 100, 100, PAD + w - 100, 800)), paint.crop((PAD + 100, 100, PAD + w - 100, 800))).convert("L").resize((64, 64))
print("mean drift", sum(d.tobytes()) / len(d.tobytes()))

# the painted figure: everything that is not the green screen, with the green fringe pulled down
r, g, b = paint.split()
key = ImageChops.darker(ImageChops.subtract(g, r), ImageChops.subtract(g, b)).point(lambda v: 255 if v > 60 else 0)
alpha = ImageChops.invert(key).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
fig = paint.convert("RGBA")
fig.putalpha(alpha)
px = fig.load()
for y in range(H):
    for x in range(W):
        R, G, B, A = px[x, y]
        m = max(R, B)
        if A and G > m + 12:
            px[x, y] = (R, m + 6, B, A)

top = Image.new("RGBA", (W, H), (0, 0, 0, 0))
top.paste(base, (PAD, 0))
top.putalpha(ImageChops.multiply(top.split()[3], keep_mask()))
fig.alpha_composite(top)
fig.save(sys.argv[4], "WEBP", quality=90, method=6)
print("saved", fig.size)
