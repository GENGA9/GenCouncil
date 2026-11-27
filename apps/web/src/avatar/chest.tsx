// The chest's secondary motion, as Agentg's ChestSecondaryMotion / FocusChestWarpMap: each side has its
// own point (the focus near its outer, lower curve) driven by its own springs, vertical and sideways,
// so the two sides swing on their own. The art is warped by inverse mapping around each focus with
// Agentg's formula
//     offset = (sigma · (p − focus) − D) · W,   W = (1 − s²)²,
// s being the distance from the focus normalised to the ellipse's edge (nothing outside the ellipse
// moves), D the spring's displacement and sigma = 1/scale − 1 its squash and stretch, scale =
// 1 + scale_amount · D.y / max. It runs as a WebGL shader, on the GPU (Safari draws SVG filters on the
// CPU every frame, which stutters), and only while something is moving.
import { useEffect, useRef, useState } from "react";

/** an iris on the art: centre and radii (measured by hand, scripts/avatar-study/find-irises.py helps) */
export interface Iris {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/** where the eyes look, shared without re-rendering: `g` is -1..1 across and down */
export interface GazeBus {
  g: [number, number];
  fns: Set<() => void>;
}

export interface ChestRegion {
  x: number;
  y: number;
  rx: number;
  ry: number;
  focus: [number, number];
  /** the largest displacement, art pixels */
  max: number;
}

const FREQ = (3.0 * 60) / 65; // Agentg: frequency × 60 / lag_ms ≈ 2.77 Hz
const ZETA = 0.3;
const ASYM = 0.12;
const HORIZONTAL = 0.14;
const SCALE_AMOUNT = 0.36;
/** px/s pushed into the springs: a touch lands like a jump, a step a little softer */
export const KICK_TOUCH = 560;
export const KICK_STEP = 300;
/** the small push at each turn of the nod while talking */
export const KICK_TALK = 120;

const VERT = `attribute vec2 a; varying vec2 v; void main(){ v = a; gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); gl_Position.y = -gl_Position.y; }`;
const FRAG = `precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform vec2 size;
uniform vec4 ell[2];   // x, y, rx, ry
uniform vec2 foc[2];
uniform vec2 disp[2];  // D, art px (down and outward positive)
uniform float sig[2];
uniform vec4 iris[2];  // x, y, rx, ry
uniform vec2 gaze;     // where the eyes look: -1..1 across, -1..1 down
uniform vec3 body;     // a standing figure: hip line (art y), breath (stretch), lean (shear); 0 = none
// (GLSL ES 1.0 indexes uniform arrays only with constants: each side's values come in as arguments)
vec2 warp(vec4 e, vec2 f, vec2 D, float sg, vec2 p) {
  vec2 d = p - f; float len = length(d);
  if (len < 0.001) return -D;
  vec2 u = d / len;
  vec2 o = (f - e.xy) / e.zw; vec2 w = u / e.zw;
  float A = dot(w, w); float B = 2.0 * dot(o, w); float C = dot(o, o) - 1.0;
  float t = (-B + sqrt(max(0.0, B * B - 4.0 * A * C))) / (2.0 * A);
  float s = len / t;
  if (s >= 1.0) return vec2(0.0);
  float W = (1.0 - s * s); W *= W;
  return (sg * d - D) * W;
}
// the iris moves by the gaze inside a soft ellipse a little larger than itself; less toward its top,
// so the upper lash line it tucks under stays where it is
vec2 look(vec4 e, vec2 p) {
  vec2 r = e.zw * 1.35;
  vec2 d = (p - e.xy) / r;
  float s2 = dot(d, d);
  if (s2 >= 1.0) return vec2(0.0);
  float W = (1.0 - s2); W *= W;
  W *= mix(0.25, 1.0, smoothstep(e.y - e.w, e.y - e.w * 0.3, p.y));
  return -gaze * vec2(e.z * 0.38, e.w * 0.28) * W;
}
void main(){
  vec2 p = v * size;
  vec2 q = p + warp(ell[0], foc[0], disp[0], sig[0], p) + warp(ell[1], foc[1], disp[1], sig[1], p) + look(iris[0], p) + look(iris[1], p);
  // standing: only what is above the hips breathes and leans; the legs and feet stay where they are
  if (p.y < body.x) {
    float dd = body.x - p.y;
    float w = smoothstep(0.0, 160.0, dd);
    q += vec2(-dd * body.z * w, dd * body.y * w);
  }
  gl_FragColor = texture2D(tex, q / size);
}`;

interface Side {
  /** vertical and sideways springs: position, velocity, angular frequency */
  y: number;
  vy: number;
  wy: number;
  x: number;
  vx: number;
  wx: number;
  max: number;
  /** +1 for the right side, -1 for the left: sideways is outward */
  out: number;
}

/**
 * The art with its chest swinging. `kick` changes on a touch; while `walking` each footfall pushes,
 * the side of the stepping foot harder. Without regions, or without WebGL, it is the plain image.
 */
export function ChestArt({ src, cw, ch, regions, irises, gazeBus, body, kick, walking, talking = false, onError, className }: { src: string; cw: number; ch: number; regions?: [ChestRegion, ChestRegion]; irises?: [Iris, Iris]; gazeBus?: GazeBus; body?: { hip: number }; kick: number; walking: boolean; talking?: boolean; onError: () => void; className?: string }) {
  // a standing figure breathes and, talking, leans a little: always moving, drawn about 30 times a second
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const talkingRef = useRef(talking && !walking);
  talkingRef.current = talking && !walking;
  /** the eyes' direction now, moving toward `gaze` in a quick saccade */
  const eye = useRef<[number, number]>([0, 0]);
  const eyeTarget = useRef<[number, number]>([0, 0]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const draw = useRef<((d: number[][], sig: number[]) => void) | null>(null);
  const sides = useRef<Side[]>([]);
  const raf = useRef(0);
  const ready = useRef(false);
  const still = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  // no WebGL (or a shader that will not build): the plain image
  const [glFailed, setGlFailed] = useState(false);
  const useGl = Boolean(regions) && !still.current && !glFailed;

  // the GL program and the art as a texture
  useEffect(() => {
    if (!useGl || !regions) return;
    const c = canvas.current;
    const gl = c?.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!c || !gl) {
      setGlFailed(true);
      return;
    }
    const sh = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setGlFailed(true);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform2f(U("size"), cw, ch);
    gl.uniform4fv(U("ell"), regions.flatMap((r) => [r.x, r.y, r.rx, r.ry]));
    gl.uniform2fv(U("foc"), regions.flatMap((r) => r.focus));
    // no irises: a zero-size ellipse moves nothing
    gl.uniform4fv(U("iris"), irises ? irises.flatMap((i) => [i.x, i.y, i.rx, i.ry]) : [0, 0, 0.001, 0.001, 0, 0, 0.001, 0.001]);
    const uGaze = U("gaze");
    const uBody = U("body");
    const uDisp = U("disp");
    const uSig = U("sig");
    const tex = gl.createTexture();
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      draw.current = (d, sig) => {
        gl.viewport(0, 0, c.width, c.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2fv(uDisp, d.flat());
        gl.uniform1fv(uSig, sig);
        gl.uniform2fv(uGaze, eye.current);
        const b = bodyRef.current;
        if (b) {
          const t = performance.now() / 1000;
          const breath = 0.006 * Math.sin((2 * Math.PI * t) / 4.4);
          const lean = talkingRef.current ? 0.006 * Math.sin((2 * Math.PI * t) / 1.3) : 0.0015 * Math.sin((2 * Math.PI * t) / 7);
          gl.uniform3f(uBody, b.hip, breath, lean);
        } else gl.uniform3f(uBody, 0, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      draw.current([[0, 0], [0, 0]], [0, 0]);
      ready.current = true;
      if (bodyRef.current) startRef.current();
    };
    img.onerror = onError;
    img.src = src;
    return () => {
      alive = false;
      ready.current = false;
      draw.current = null;
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useGl, src, cw, ch, regions, irises]);

  useEffect(() => {
    if (!regions) return;
    const w = 2 * Math.PI * FREQ;
    // each side its own frequencies (Agentg's asym), the sideways springs further apart still
    sides.current = regions.map((r, i) => ({ y: 0, vy: 0, wy: w * (i === 0 ? 1 - ASYM / 2 : 1 + ASYM / 2), x: 0, vx: 0, wx: w * (i === 0 ? 1 + ASYM : 1 - ASYM), max: r.max, out: i === 0 ? -1 : 1 }));
  }, [regions]);

  const run = () => {
    if (raf.current || !draw.current) return;
    let last = performance.now();
    let drawn = 0;
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      let moving = false;
      // the eyes: about 0.1 s to get there
      const [tx, ty] = eyeTarget.current;
      const k = 1 - Math.exp(-dt * 28);
      eye.current = [eye.current[0] + (tx - eye.current[0]) * k, eye.current[1] + (ty - eye.current[1]) * k];
      if (Math.abs(tx - eye.current[0]) > 0.004 || Math.abs(ty - eye.current[1]) > 0.004) moving = true;
      else eye.current = [tx, ty];
      for (const s of sides.current) {
        for (let left = dt; left > 0; left -= 1 / 120) {
          const h = Math.min(left, 1 / 120);
          s.vy += (-s.wy * s.wy * s.y - 2 * ZETA * s.wy * s.vy) * h;
          s.y += s.vy * h;
          s.vx += (-s.wx * s.wx * s.x - 2 * ZETA * s.wx * s.vx) * h;
          s.x += s.vx * h;
        }
        const len = Math.hypot(s.x, s.y);
        if (len > s.max) {
          s.x *= s.max / len;
          s.y *= s.max / len;
          s.vy *= -0.3;
          s.vx *= -0.3;
        }
        if (Math.abs(s.y) > 0.015 || Math.abs(s.vy) > 0.05 || Math.abs(s.x) > 0.015 || Math.abs(s.vx) > 0.05) moving = true;
        else s.x = s.y = s.vx = s.vy = 0;
      }
      const d = sides.current.map((s) => [s.x * s.out, s.y]);
      // squash and stretch around the focus: down (heavier) stretches, up squashes
      const sig = sides.current.map((s) => 1 / (1 + (SCALE_AMOUNT * s.y) / s.max) - 1);
      // breathing alone needs no 60 frames a second
      if (moving || t - drawn > 33) {
        draw.current?.(d, sig);
        drawn = t;
      }
      raf.current = moving || bodyRef.current ? requestAnimationFrame(frame) : 0;
    };
    raf.current = requestAnimationFrame(frame);
  };
  const startRef = useRef(run);
  startRef.current = run;
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      // cleared, so a remount (React mounts twice in development) starts the loop again
      raf.current = 0;
    },
    [],
  );

  // a new direction for the eyes: on to it
  useEffect(() => {
    if (!irises || !gazeBus || still.current) return;
    const fn = () => {
      eyeTarget.current = gazeBus.g;
      run();
    };
    gazeBus.fns.add(fn);
    fn();
    return () => {
      gazeBus.fns.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [irises, gazeBus]);

  /** push both springs; `lead` is the side that gets the harder push (-1 none) */
  const push = (v: number, lead = -1) => {
    if (!sides.current.length || !ready.current) return;
    sides.current.forEach((s, i) => {
      const bias = lead < 0 ? 1 : i === lead ? 1.3 : 0.7;
      const jitter = 0.8 + Math.random() * 0.4;
      const k = v * bias * jitter * (i === 0 ? 1 + ASYM / 2 : 1 - ASYM / 2);
      // a slightly later start for one side, so they never move as one
      const delay = i === 1 ? 20 + Math.random() * 50 : 0;
      const go = () => {
        s.vy += k;
        s.vx += k * HORIZONTAL * (0.6 + Math.random() * 0.8);
        run();
      };
      if (delay) window.setTimeout(go, delay);
      else go();
    });
  };
  useEffect(() => {
    if (kick) push(KICK_TOUCH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kick]);
  // talking: the body sways with the av-nod animation (1.3 s; turning at 30% and 70%), and at each turn
  // the chest gets a small push, harder on the side the body swings toward
  useEffect(() => {
    if (!talking || walking) return;
    const timers: number[] = [];
    const cycle = () => {
      timers.push(window.setTimeout(() => push(KICK_TALK, 0), 390));
      timers.push(window.setTimeout(() => push(KICK_TALK, 1), 910));
    };
    cycle();
    const t = window.setInterval(cycle, 1300);
    return () => {
      clearInterval(t);
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talking, walking]);
  // walking: the bob lands twice in each 0.46 s cycle (the av-walk animation), one foot then the other
  useEffect(() => {
    if (!walking) return;
    let foot = 0;
    const step = () => push(KICK_STEP, (foot++ % 2) as 0 | 1);
    step();
    const t = window.setInterval(step, 230);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walking]);

  if (!useGl) return <img className={className} src={src} alt="" draggable={false} onError={onError} />;
  return <canvas ref={canvas} className={className} width={cw} height={ch} aria-hidden />;
}
