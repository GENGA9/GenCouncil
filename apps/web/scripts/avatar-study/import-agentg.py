# Brings Agentg's character resources into the app, in one go, whenever Agentg has new ones:
#  - each rig's expression layers (eyes / mouth / skin states: smile, sad, wide, o, blush, ...) as
#    public/avatar/<rig>/<layer>-<state>.webp, and the rig's regions, states, mouth sets and chest physics
#    in src/avatar/expressions.json;
#  - the touch-reaction lines (voice-lines/touch.json: each preset's lines from personas/reactions and
#    their English, all recorded; or, without it, personas/reactions alone) in src/avatar/reactions.json;
#  - the recorded voice lines (voice-lines/audio) in public/avatar/voice/<char>/.
# Mouth layers are fitted to the face as they come in (blend-patches.py: a painted patch's skin takes the
# face's shading). Rigs whose art this app changed keep it: Claude's bust was widened (its layers move right by the added
# margin), her standing art was mirrored (its layers are mirrored too); for those only the states the app
# lacks are added. Every other rig is synced whole (base and layers) when Agentg's differs.
#   python import-agentg.py [path to the sources]   (default: resources/agentg in this repo, where
#   Agentg's sources were copied when Agentg was folded into GenCouncil; the recordings are in its
#   git-ignored voice-lines/audio)
import json, os, shutil, sys
import importlib.util
import numpy as np
from PIL import Image

# the mouth fit (blend-patches.py): each mouth brought in takes the face's shading
_spec = importlib.util.spec_from_file_location("blend_patches", os.path.join(os.path.dirname(os.path.abspath(__file__)), "blend-patches.py"))
blend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(blend)

HERE = os.path.dirname(os.path.abspath(__file__))
AG = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(HERE, "../../../../resources/agentg"))
WEB = os.path.normpath(os.path.join(HERE, "../.."))
PUB = os.path.join(WEB, "public/avatar")
RIGS = ["claudechan", "gpichan", "gemmini", "grok-x", "dotchan", "claudechan-full", "gpichan-full", "gemmini-full", "grok-x-full", "dotchan-full"]
# the app's own edits: margin added at each side, mirrored
KEEP = {"claudechan": {"dx": 192, "mirror": False}, "claudechan-full": {"dx": 0, "mirror": True}}
# each character's speech preset (personas/*.json) and its voice folder in voice-lines/audio
PRESET = {"claudechan": "kind-secretary", "gpichan": "brief-reporter", "gemmini": "cheerful-junior", "grok-x": "playful-friend", "dotchan": "calm-butler"}
VOICE_DIR = {"claudechan": "claudechan", "gpichan": "gpichan", "gemmini": "gemmini", "grok-x": "grokchan", "dotchan": "dotchan"}


def webp(img: Image.Image, path: str, lossless: bool) -> None:
    img.save(path, "WEBP", lossless=lossless, quality=92, method=6)


def place(box, w0, keep):
    """a region [x, y, w, h] of Agentg's canvas (width w0) in the app's art"""
    x, y, w, h = box
    if keep and keep["mirror"]:
        x = w0 - x - w
    return [x + (keep["dx"] if keep else 0), y, w, h]


expr = {}
changed = []
for rig in RIGS:
    src = os.path.join(AG, "assets/rigs", rig)
    dst = os.path.join(PUB, rig)
    j = json.load(open(os.path.join(src, "rig.json"), encoding="utf8"))
    keep = KEEP.get(rig)
    w0 = j["canvas"][0]
    sync = keep is None
    if sync:
        a = np.asarray(Image.open(os.path.join(src, "base.png")).convert("RGBA"), dtype=np.int16)
        mine = os.path.join(dst, "base.webp")
        o = np.asarray(Image.open(mine).convert("RGBA"), dtype=np.int16) if os.path.exists(mine) else None
        if o is None or o.shape != a.shape or np.abs(a - o).mean() > 3:
            webp(Image.open(os.path.join(src, "base.png")).convert("RGBA"), mine, False)
            changed.append(f"{rig}/base")
    for layer in ("eyes", "mouth", "skin"):
        for state in j["states"][layer]:
            if layer == "skin" and state == "normal":
                continue
            out = os.path.join(dst, f"{layer}-{state}.webp")
            if not sync and os.path.exists(out):
                continue
            im = Image.open(os.path.join(src, layer, f"{state}.png")).convert("RGBA")
            if keep and keep["mirror"]:
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            if layer == "mouth":
                x, y, w, h = place(j["regions"]["mouth"], w0, keep)
                face = np.asarray(Image.open(os.path.join(dst, "base.webp")).convert("RGBA"), dtype=np.float32)[y : y + h, x : x + w]
                fitted, moved = blend.fit(np.asarray(im, dtype=np.float32), face)
                if moved > 0:
                    im = Image.fromarray(fitted.astype(np.uint8), "RGBA")
            webp(im, out, True)
            changed.append(f"{rig}/{layer}-{state}")
    phys = {}
    p = os.path.join(src, "physics.json")
    if os.path.exists(p):
        ph = json.load(open(p, encoding="utf8"))
        for side in ("chest_left", "chest_right"):
            if side in ph:
                c = ph[side]
                x = c["x"]
                fx = c["focus"][0]
                if keep and keep["mirror"]:
                    x, fx = w0 - x, w0 - fx
                dx = keep["dx"] if keep else 0
                phys[side] = {"x": x + dx, "y": c["y"], "rx": c["rx"], "ry": c["ry"], "focus": [fx + dx, c["focus"][1]], "max": c["max_displacement"]}
    entry = {
        "regions": {k: place(v, w0, keep) for k, v in j["regions"].items()},
        "states": j["states"],
        "sets": j.get("mouth_sets", {}),
        "chest": [phys[s] for s in ("chest_left", "chest_right") if s in phys],
    }
    if "anchor" in j:
        entry["anchor"] = j["anchor"]
    if rig.endswith("-full"):
        # where the head starts: the first row with anything drawn
        al = np.asarray(Image.open(os.path.join(dst, "base.webp")).convert("RGBA"))[..., 3]
        entry["top"] = int(np.nonzero((al > 40).any(axis=1))[0][0])
    expr[rig] = entry

json.dump(expr, open(os.path.join(WEB, "src/avatar/expressions.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)

reactions = {}
touch = os.path.join(AG, "voice-lines/touch.json")
if os.path.exists(touch):
    # the recorded touch lines (ko, ja and en, voice-lines/audio/<char>/touch_<n>_<lang>.mp3)
    by_char = {v: k for k, v in VOICE_DIR.items()}
    for l in json.load(open(touch, encoding="utf8"))["lines"]:
        reactions.setdefault(by_char[l["char"]], []).append({"text": l["text"], "lang": l["lang"], "file": l["file"], **({"sub": l["subtitle_ko"]} if l.get("subtitle_ko") else {})})
else:
    for rig, preset in PRESET.items():
        r = json.load(open(os.path.join(AG, "personas/reactions", f"{preset}.json"), encoding="utf8"))
        reactions[rig] = [{"text": l["text"], "lang": l.get("lang", "ko"), **({"sub": l["subtitle_ko"]} if l.get("subtitle_ko") else {})} for l in r["lines"]]
json.dump(reactions, open(os.path.join(WEB, "src/avatar/reactions.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)

voices = 0
for char, folder in VOICE_DIR.items():
    s = os.path.join(AG, "voice-lines/audio", folder)
    d = os.path.join(PUB, "voice", folder)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(s):
        if f.endswith(".mp3") and not os.path.exists(os.path.join(d, f)):
            shutil.copy2(os.path.join(s, f), os.path.join(d, f))
            voices += 1

print("changed", len(changed), changed[:60])
print("voices added", voices)
