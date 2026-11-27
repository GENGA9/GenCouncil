// The meeting room art (scripts/avatar-study/cut-meeting.py, cut-seated.py).
// ROOM: the painting's size; the vanishing point (one-point perspective, the camera at the table's near
// end); the table top's far edge [left x, y, right x] and near edge [left x, y, right x] as painted;
// where the front layer (the table, drawn over the seated) starts; the seats' depths (as multiples of
// the far end's scale); and how the view crops it (the width it must show, the top it may cut on a tall
// screen, the lowest row it keeps on a wide one). Only the chair and the two seats beside it must show:
// the near seats may be cut by the edges.
export const ROOM = {
  w: 1536,
  h: 1024,
  vp: [767, 391] as [number, number],
  far: [568, 558, 966] as [number, number, number],
  near: [98, 952, 1436] as [number, number, number],
  frontY: 550,
  seatFar: 1.25,
  seatNear: 1.8,
  span: 1100,
  spanTall: 1200,
  portraitTop: 150,
  keepTo: 820,
};
// SEATED: each seated figure (facing right): size, top of the head, middle of the head, eye line (read
// off the art by eye).
export const SEATED: Record<string, { w: number; h: number; top: number; headX: number; eye: number }> = {
  claudechan: { w: 779, h: 900, top: 1, headX: 388, eye: 105 },
  gpichan: { w: 743, h: 900, top: 1, headX: 235, eye: 118 },
  gemmini: { w: 732, h: 900, top: 1, headX: 515, eye: 130 },
  "grok-x": { w: 782, h: 900, top: 1, headX: 200, eye: 72 },
  dotchan: { w: 694, h: 900, top: 1, headX: 165, eye: 115 },
};
