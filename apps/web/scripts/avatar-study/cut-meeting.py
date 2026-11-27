# The meeting room painted by Codex $imagegen (a GPT member), seen down the length of the table: the room
# as it is, and the table (its top, what stands on it, and its near face) as a layer drawn over the seated
# members, so their knees go under it. The table top is the quad between its far and near edges.
#   python cut-meeting.py <room.png> <far: lx,y,rx> <near: lx,y,rx>   (see src/avatar/meetingArt.ts)
import os, sys
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
fl, fy, fr = (int(v) for v in sys.argv[2].split(","))
nl, ny, nr = (int(v) for v in sys.argv[3].split(","))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "avatar", "meeting")
os.makedirs(OUT, exist_ok=True)
room = Image.open(SRC).convert("RGB")
W, H = room.size
room.save(os.path.join(OUT, "room.webp"), quality=86, method=6)
# the top (a pixel out all round), then its near face straight down to the bottom of the picture
mask = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(mask)
d.polygon([(fl - 1, fy - 1), (fr + 1, fy - 1), (nr + 1, ny), (nl - 1, ny)], fill=255)
d.rectangle([nl - 1, ny, nr + 1, H], fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(0.7))
front = room.convert("RGBA")
front.putalpha(mask)
top = fy - 8
front.crop((0, top, W, H)).save(os.path.join(OUT, "front.webp"), quality=88, method=6)
print("front from", top)
