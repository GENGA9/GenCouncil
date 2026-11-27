// Reproduction record for the 2026-11-26 built-in image_gen edit.
// node run.mjs [manifest.json] prints/writes exact prompts; it never launches other agents.
// Keep full-size references/candidates in an ignored work directory.
import fs from 'node:fs';

export const STUDY_GENERATION = {
  "engine": "Codex built-in image_gen",
  "size": [
    1536,
    1024
  ],
  "roomCandidates": [
    "Use case: precise-object-edit. Edit target: reference-room.png, the existing warm anime study background. Produce ONE 1536x1024 landscape 3:2 image, same exact framing, no crop, no camera change.\nPreserve the warm painterly cel-shaded style, polished amber wood, lighting and original composition. Preserve bookshelf boundaries and shelves, the globe, all existing plants, wall panels, clock, red curtains, window frame and brass desk lamp. Window glass stays solid #00FF00; no scenery, characters, chair, UI, text or watermark.\nChange ONLY these two things:\n1. Books in the left bookcase: orderly natural hardcover books, consistent adult book proportions, within each shelf similar heights (70–85% of shelf opening) and thicknesses with subtle small variation. No tiny books alongside giant books.\n2. Desk objects: enlarge the existing silver laptop, three-book stack, floral teacup/saucer and ceramic potted plant to plausible scale next to a seated adult anime character whose shoulders span about 850 pixels. The laptop should be substantially bigger, approximately 320 pixels wide and 250 pixels high, like a 13–15 inch notebook next to that adult, viewed from behind with screen open as in original. Keep laptop on right around x1120–1415, book stack on its right, cup on left around x270–405, plant at far left. Three stacked books should be adult hardcover size, about 210–240px long in perspective. Preserve relative order and all objects. Do not add or remove props. Keep central x450–1100 free for the seated character.\nCritical exact geometry: desk rear/top line y756, desk front lip y825; glass bounding box x1194 y46 w274 h621; clock center x481.5 y198.5 diameter120; brass lamp light center x1424 y612. Keep these locations and the room margins exactly unchanged. Larger props may rise higher from the same desktop. No change to the clock face, lamp or desk front.",
    "Use case: precise-object-edit. Edit target: reference-room.png, the existing warm anime study background. Produce ONE 1536x1024 landscape 3:2 image, same exact framing, no crop, no camera change.\nPreserve the warm painterly cel-shaded style, polished amber wood, lighting and original composition. Preserve bookshelf boundaries and shelves, the globe, all existing plants, wall panels, clock, red curtains, window frame and brass desk lamp. Window glass stays solid #00FF00; no scenery, characters, chair, UI, text or watermark.\nChange ONLY these two things:\n1. Books in the left bookcase: orderly natural hardcover books, consistent adult book proportions, within each shelf similar heights (70–85% of shelf opening) and thicknesses with subtle small variation. No tiny books alongside giant books.\n2. Desk objects: enlarge the existing silver laptop, three-book stack, floral teacup/saucer and ceramic potted plant to plausible scale next to a seated adult anime character whose shoulders span about 850 pixels. The laptop should be substantially bigger, approximately 320 pixels wide and 250 pixels high, like a 13–15 inch notebook next to that adult, viewed from behind with screen open as in original. Keep laptop on right around x1120–1415, book stack on its right, cup on left around x270–405, plant at far left. Three stacked books should be adult hardcover size, about 210–240px long in perspective. Preserve relative order and all objects. Do not add or remove props. Keep central x450–1100 free for the seated character.\nCritical exact geometry: desk rear/top line y756, desk front lip y825; glass bounding box x1194 y46 w274 h621; clock center x481.5 y198.5 diameter120; brass lamp light center x1424 y612. Keep these locations and the room margins exactly unchanged. Larger props may rise higher from the same desktop. No change to the clock face, lamp or desk front.\nVariant 2 specific correction: The entire laptop including keyboard must remain on RIGHT side, x1080–1390; screen width about270 and screen height230, keyboard extends left at most to x1080. Do NOT move it toward the middle. The center x450–1080 must be fully empty plain wall and desktop. Cup diameter110, plant width240; keep all shelf book tops at similar height (especially top shelf). Books stacked at x1300–1480 can partially overlap laptop in depth, three volumes only. Preserve lamp and clock precisely.",
    "Use case: precise-object-edit. Edit target: reference-room.png, the existing warm anime study background. Produce ONE 1536x1024 landscape 3:2 image, same exact framing, no crop, no camera change.\nPreserve the warm painterly cel-shaded style, polished amber wood, lighting and original composition. Preserve bookshelf boundaries and shelves, the globe, all existing plants, wall panels, clock, red curtains, window frame and brass desk lamp. Window glass stays solid #00FF00; no scenery, characters, chair, UI, text or watermark.\nChange ONLY these two things:\n1. Books in the left bookcase: orderly natural hardcover books, consistent adult book proportions, within each shelf similar heights (70–85% of shelf opening) and thicknesses with subtle small variation. No tiny books alongside giant books.\n2. Desk objects: enlarge the existing silver laptop, three-book stack, floral teacup/saucer and ceramic potted plant to plausible scale next to a seated adult anime character whose shoulders span about 850 pixels. The laptop should be substantially bigger, approximately 320 pixels wide and 250 pixels high, like a 13–15 inch notebook next to that adult, viewed from behind with screen open as in original. Keep laptop on right around x1120–1415, book stack on its right, cup on left around x270–405, plant at far left. Three stacked books should be adult hardcover size, about 210–240px long in perspective. Preserve relative order and all objects. Do not add or remove props. Keep central x450–1100 free for the seated character.\nCritical exact geometry: desk rear/top line y756, desk front lip y825; glass bounding box x1194 y46 w274 h621; clock center x481.5 y198.5 diameter120; brass lamp light center x1424 y612. Keep these locations and the room margins exactly unchanged. Larger props may rise higher from the same desktop. No change to the clock face, lamp or desk front.\nVariant 3, stricter placement: reproduce reference positions without any leftward movement of right-hand props. Laptop is 1.3x original width: entire laptop bounding box x1070–1385, y560–795 (including keyboard), screen approximately270x220. Laptop's LEFTMOST pixel must be x1070 or greater. Empty character area x450–1070. Keep a three-book stack on right x1305–1490 y670–800, allowing partial occlusion behind laptop, do not shift laptop to make space. Cup width130 including handle/saucer around x245–375. Plant remains far left width245. Shelf hardcover books have uniform realistic proportions; within each shelf almost same heights, modest thickness variation, each only 70–85% shelf opening height."
  ],
  "selected": "candidate-02.png",
  "wide": "Use case: precise-object-edit / outpainting. Input image1 wide-reference.png is the target wider warm anime study. Input image2 room.png is the finished close room that MUST remain exactly in the wide image at a 0.6 scale with top-left (307,120) in a 1536x1024 canvas. Output 1536x1024, same exact camera/framing as input1.\nRefine only OUTSIDE that central room rectangle (x307..1229, y120..734): smoothly continue its ceiling molding, left bookcase shelving and regular adult hardcover books, desk ends and legs, floorboards, and the same red gold rug. Preserve all existing outside objects including left vase, vines, right standing floor lamp; do not add/remove any. Same amber wood colors, warm light, anime painterly cel-shaded style.\nCritical: connect all shelves, wooden desk lip y615, desk front bottom y730, and curtain edges across that central rectangle with NO visible seam or doubled molding. Keep the central room itself including larger laptop/books/cup/plant unchanged. Keep window glass PURE solid #00FF00 without scenery; original glass frame and clock positions unchanged. No characters, no people, no UI, no text, no watermark. This is an outpaint of the exact room, not a redesign.",
  "registration": {
    "laptopShiftX": 115,
    "unchanged": {
      "window": [
        1194,
        46,
        274,
        621
      ],
      "deskY": 756,
      "deskFront": 825,
      "clock": [
        481.5,
        198.5,
        120
      ],
      "lamp": [
        1424,
        612
      ]
    },
    "wide": {
      "scale": 0.6,
      "x": 307,
      "y": 120
    },
    "notes": "Apply only edited bookshelf/prop masks; preserve remaining pixels. Foreground props extend desk crop upward. Composite registered room over wide outpaint; feather only outside room footprint."
  }
};

const json = JSON.stringify(STUDY_GENERATION, null, 2) + '\n';
if (process.argv[2]) fs.writeFileSync(process.argv[2], json);
else process.stdout.write(json);
