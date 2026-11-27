from PIL import Image, ImageDraw, ImageFilter, ImageChops
from pathlib import Path
import argparse
parser=argparse.ArgumentParser(description='Register candidate-02 edits while preserving room anchors; then stitch the wide outpaint.')
parser.add_argument('source',type=Path)
P=parser.parse_args().source
base=Image.open(P/'reference-room.png').convert('RGB')
new=Image.open(P/'candidate-02.png').convert('RGB')
mask=Image.new('L',base.size); d=ImageDraw.Draw(mask)
for box in [(0,44,220,176),(136,215,339,360),(0,382,238,517),(0,540,339,672),(0,522,375,815)]: d.rectangle(box,fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(2))
room=Image.composite(new,base,mask)
# Reconstruct the narrow red curtain strip uncovered by the registered laptop.
curtain=Image.new('RGB',base.size)
for y in range(625,760):
 for x in range(1090,1185):
  curtain.putpixel((x,y),tuple(round(v*(1-.08*(y-634)/126)) for v in base.getpixel((x,634))))
cm=Image.new('L',base.size)
ImageDraw.Draw(cm).polygon([(1112,633),(1180,633),(1150,759),(1095,759)],fill=255)
cm=cm.filter(ImageFilter.GaussianBlur(3))
room=Image.composite(curtain,room,cm); mask=ImageChops.lighter(mask,cm)
# Register the enlarged laptop back to the original right-hand placement.
lm=Image.new('L',base.size); ImageDraw.Draw(lm).polygon([(1067,599),(1302,599),(1316,607),(1276,756),(1280,796),(1040,801),(955,773),(954,758),(1025,754),(1057,614)],fill=255)
lm=lm.filter(ImageFilter.GaussianBlur(.7))
shift=115
layer=Image.new('RGB',base.size); layer.paste(new,(shift,0))
shiftmask=Image.new('L',base.size); shiftmask.paste(lm,(shift,0))
room=Image.composite(layer,room,shiftmask)
mask=ImageChops.lighter(mask,shiftmask)
# The three enlarged books stay to the right, in front of the laptop's edge.
bm=Image.new('L',base.size); ImageDraw.Draw(bm).polygon([(1285,692),(1420,685),(1464,692),(1460,804),(1267,807),(1264,777),(1271,740),(1276,714)],fill=255)
bm=bm.filter(ImageFilter.GaussianBlur(.7))
room=Image.composite(new,room,bm); mask=ImageChops.lighter(mask,bm)
# Preserve the original brass shade and its light anchor where the larger screen passes behind it.
protect=Image.new('L',base.size); ImageDraw.Draw(protect).polygon([(1366,603),(1383,579),(1406,556),(1428,547),(1447,550),(1455,570),(1474,612),(1476,634),(1428,629)],fill=255)
room=Image.composite(base,room,protect); mask=ImageChops.subtract(mask,protect)
room.save(P/'room.png'); mask.save(P/'edit-mask.png')
outside=ImageChops.difference(base,room); outside.paste((0,0,0),(0,0),mask.point(lambda v:255 if v else 0))
assert outside.getbbox() is None
# Preserve the old window matte outside edited props; key the new screen outline locally.
original_alpha=Image.open(P/'window-alpha-original.png').convert('L')
r,g,b=room.convert('RGB').split()
key=ImageChops.darker(ImageChops.subtract(g,r),ImageChops.subtract(g,b)).point(lambda v:255 if v>70 else 0)
new_alpha=ImageChops.invert(key.filter(ImageFilter.GaussianBlur(.6)))
alpha=Image.composite(new_alpha,original_alpha,mask)
alpha.save(P/'window-alpha.png')
props=Image.new('L',base.size)
ImageDraw.Draw(props).rectangle((0,522,375,815),fill=255)
props=ImageChops.lighter(props,shiftmask)
props=ImageChops.lighter(props,bm)
props.save(P/'props-mask.png')

wp=P/'room-wide-generated.png'
if wp.exists():
 big=Image.open(wp).convert('RGB').resize((2560,1707),Image.Resampling.LANCZOS)
 # Exact inverse of Room.tsx's wide world transform, including its fractional offset.
 sy=1707/1706.7
 pad=32; w,h=1536,1024
 padded=Image.new('RGB',(w+pad*2,h+pad*2))
 padded.paste(room,(pad,pad))
 padded.paste(room.crop((0,0,w,1)).resize((w,pad)),(pad,0))
 padded.paste(room.crop((0,h-1,w,h)).resize((w,pad)),(pad,h+pad))
 padded.paste(room.crop((0,0,1,h)).resize((pad,h)),(0,pad))
 padded.paste(room.crop((w-1,0,w,h)).resize((pad,h)),(w+pad,pad))
 for cx,cy in [(0,0),(w-1,0),(0,h-1),(w-1,h-1)]:
  padded.paste(room.getpixel((cx,cy)),(0 if cx==0 else w+pad,0 if cy==0 else h+pad,pad if cx==0 else w+2*pad,pad if cy==0 else h+2*pad))
 transform=(1,0,pad-511.7,0,1/sy,pad-200)
 overlay=padded.transform(big.size,Image.Transform.AFFINE,transform,Image.Resampling.BICUBIC)
 m=Image.new('L',padded.size); ImageDraw.Draw(m).rectangle((pad,pad,pad+w-1,pad+h-1),fill=255)
 m=m.filter(ImageFilter.GaussianBlur(9))
 ImageDraw.Draw(m).rectangle((pad,pad,pad+w-1,pad+h-1),fill=255)
 m=m.transform(big.size,Image.Transform.AFFINE,transform,Image.Resampling.BICUBIC)
 big=Image.composite(overlay,big,m)
 big.save(P/'room-wide.png')
 # Only this room's glass is transparent; preserve all extended shelves and vines.
 hole=ImageChops.invert(alpha).transform(big.size,Image.Transform.AFFINE,(1,0,-511.7,0,1/sy,-200),Image.Resampling.BICUBIC)
 ImageChops.invert(hole).save(P/'wide-alpha.png')
 print('wide output 2560x1707; central room registered, feather outside only')
print('selected candidate-02; laptop registered +115px; mask outside diff=0')
