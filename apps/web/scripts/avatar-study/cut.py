"""Split a built-in image_gen study into room/foreground/wide layers.

python cut.py [deskY [deskFront]] --src <ignored source dir>
An optional window-alpha.png preserves the registered glass matte, and
props-mask.png includes enlarged desk objects above the desktop in the foreground.
Existing seasonal views are untouched unless --views is explicitly supplied.
"""
import argparse
import json
import time
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter

HERE = Path(__file__).resolve().parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('deskY', type=int, nargs='?', default=756)
p.add_argument('deskFront', type=int, nargs='?', default=825)
p.add_argument('--src', type=Path, default=HERE / 'out')
p.add_argument('--out', type=Path, default=HERE / '../../public/avatar/study')
p.add_argument('--meta', type=Path, default=HERE / '../../src/avatar/study.json')
p.add_argument('--views', action='store_true', help='Explicitly replace seasonal view images')
a = p.parse_args()
a.out.mkdir(parents=True, exist_ok=True)
old = json.loads(a.meta.read_text()) if a.meta.exists() else {}
room = Image.open(a.src / 'room.png').convert('RGB')
W, H = room.size
if (W, H) != (1536, 1024):
    raise ValueError(f'Normalize room to 1536x1024 before cutting, got {(W, H)}')

def glass_alpha(im):
    r, g, b = im.convert('RGB').split()
    key = ImageChops.darker(ImageChops.subtract(g, r), ImageChops.subtract(g, b))
    return ImageChops.invert(key.point(lambda v: 255 if v > 70 else 0).filter(ImageFilter.GaussianBlur(.6)))

ap = a.src / 'window-alpha.png'
alpha = Image.open(ap).convert('L') if ap.exists() else glass_alpha(room)
if alpha.size != room.size:
    raise ValueError('Window alpha and room dimensions differ')
window = ImageChops.invert(alpha).getbbox()
if window is None:
    raise ValueError('No transparent window found')
if ap.exists() and old.get('window'):
    x, y, w, h = old['window']
    window = (x, y, x+w, y+h)
rgba = room.convert('RGBA')
rgba.putalpha(alpha)
# Remove chroma color under antialiased glass edges before WebP encoding.
px = rgba.load()
for y in range(window[1], window[3]):
    for x in range(window[0], window[2]):
        r, g, b, opacity = px[x, y]
        if opacity < 255 and g > max(r, b) + 20:
            px[x, y] = (r, max(r, b), b, opacity)
# Lossless storage keeps the room and foreground identical where they overlap.
rgba.save(a.out / 'room.webp', lossless=True, method=6)

foreground = Image.new('L', (W, H))
foreground.paste(255, (0, a.deskY - 2, W, H))
foreground = foreground.filter(ImageFilter.GaussianBlur(1.2))
fp = a.src / 'props-mask.png'
if fp.exists():
    props = Image.open(fp).convert('L')
    if props.size != room.size:
        raise ValueError('Props mask and room dimensions differ')
    foreground = ImageChops.lighter(foreground, props)
top = min(a.deskY - 8, foreground.getbbox()[1])
desk = rgba.copy()
desk.putalpha(ImageChops.multiply(alpha, foreground))
desk.crop((0, top, W, H)).save(a.out / 'desk.webp', lossless=True, method=6)

wide = old.get('wide')
wp = a.src / 'room-wide.png'
if wp.exists():
    # Source is 2560x1707; its world extent preserves the original 0.6 placement.
    big = Image.open(wp).convert('RGBA')
    wap = a.src / 'wide-alpha.png'
    ba = Image.open(wap).convert('L') if wap.exists() else glass_alpha(big)
    if ba.size != big.size:
        raise ValueError('Wide alpha and image dimensions differ')
    big.putalpha(ba)
    big.save(a.out / 'wide.webp', lossless=True, method=6)
    wide = {'x': -511.7, 'y': -200.0, 'w': 2560.0, 'h': 1706.7}

views = old.get('views', [])
if a.views:
    views = []
    for f in sorted(a.src.glob('view-*.png')):
        view = Image.open(f).convert('RGB')
        view.thumbnail((768, 768), Image.Resampling.LANCZOS)
        view.save(a.out / (f.stem + '.webp'), quality=84, method=6)
        views.append(f.stem[5:])
meta = {'rev': time.strftime('%Y%m%d%H%M%S'), 'w': W, 'h': H,
        'deskY': a.deskY, 'deskTop': top, 'deskFront': a.deskFront,
        'window': [window[0], window[1], window[2]-window[0], window[3]-window[1]],
        'views': views, 'wide': wide}
a.meta.write_text(json.dumps(meta, indent=1) + '\n', encoding='utf-8')
print(json.dumps(meta))
