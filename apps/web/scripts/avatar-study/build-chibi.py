# Builds the desk members' chibi sprites from Agentg's chibi-anim-v1 (resources/agentg/local/
# chibi-anim-v1/, git-ignored, copied from %LOCALAPPDATA%/Agentg/art; <char>/<action>/frame_NN.png, 512x512, feet on y=480, anim.json for timing):
# one horizontal WebP sheet per action at SIZE px a frame, and chibi.json with the timing.
#   python build-chibi.py
import json, os
from PIL import Image

SRC = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../resources/agentg/local/chibi-anim-v1"))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "avatar", "chibi")
SIZE = 288
# Agentg's character ids -> this app's rig ids
CHARS = {"claudechan": "claudechan", "gpichan": "gpichan", "gemmini": "gemmini", "grokchan": "grok-x", "dotchan": "dotchan"}
# picked: dangling while held (held by grab_point, the top of the head); dropped: the fall, the landing
# and getting up again (once)
ACTIONS = ["walk", "run", "write", "happy", "sulk", "sleep", "fall", "getup", "picked", "dropped"]

# actions: the timing (the first character's); rigs: each character's own frame count and timing where
# it differs (dropped has 9 frames for some, 8 for others)
meta = {"size": SIZE, "actions": {}, "rigs": {}}
total = 0
for src_id, rig in CHARS.items():
    os.makedirs(os.path.join(OUT, rig), exist_ok=True)
    for a in ACTIONS:
        d = os.path.join(SRC, src_id, a)
        j = json.load(open(os.path.join(d, "anim.json"), encoding="utf8"))
        frames = [Image.open(os.path.join(d, f)).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS) for f in j["frames"]]
        sheet = Image.new("RGBA", (SIZE * len(frames), SIZE), (0, 0, 0, 0))
        for i, f in enumerate(frames):
            sheet.paste(f, (i * SIZE, 0))
        p = os.path.join(OUT, rig, a + ".webp")
        sheet.save(p, "WEBP", quality=88, method=6)
        total += os.path.getsize(p)
        k = SIZE / j["frame_size"][0]
        meta["rigs"].setdefault(rig, {})[a] = {"frames": len(frames), "durations": j["frame_durations_ms"]}
        if a in meta["actions"]:
            continue
        meta["actions"][a] = {
            "frames": len(frames),
            "durations": j["frame_durations_ms"],
            "loop": j["loop"],
            "flip": j.get("flip_x_allowed", False),
            "facing": j.get("source_direction", "front"),
            "floor": round(j.get("floor_y", 480) * k, 1),
            "root": round(j["root_x"] * k, 1),
            **({"grab": [round(j["grab_point"][0] * k, 1), round(j["grab_point"][1] * k, 1)]} if j.get("grab_point") else {}),
        }
json.dump(meta, open(os.path.join(OUT, "chibi.json"), "w"), indent=1)
# the page reads the timing from its sources
json.dump(meta, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "avatar", "chibi.json"), "w"), indent=1)
print("ok", total // 1024, "KB")
