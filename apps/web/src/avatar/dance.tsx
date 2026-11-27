// A dance: a video of the character (cut out of its own background by SAM3, see
// scripts/avatar-study/pack-dance.py) with the colour on the left and the mask on the right in one
// H.264 file of an ordinary size (an iPhone would not play the old one, twice as tall as wide),
// since Safari plays no transparent WebM. WebGL puts the halves back together every frame, over the
// study, so she dances in the office.
import { useEffect, useRef } from "react";
import { t } from "../i18n";

export interface Dance {
  id: string;
  label: string;
  src: string;
  /** one half's size, where her feet are in it and her height (head to feet) in the first frame */
  w: number;
  h: number;
  feet: [number, number];
  height: number;
}

const VERT = `attribute vec2 a; varying vec2 v; void main(){ v = a; gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); gl_Position.y = -gl_Position.y; }`;
const FRAG = `precision mediump float;
varying vec2 v;
uniform sampler2D tex;
void main(){
  vec3 c = texture2D(tex, vec2(v.x * 0.5, v.y)).rgb;
  float a = texture2D(tex, vec2(0.5 + v.x * 0.5, v.y)).g;
  // the mask went through limited-range video: stretch it back and snap the near-empty to empty
  a = clamp((a - 0.03) / 0.94, 0.0, 1.0);
  gl_FragColor = vec4(c * a, a);
}`;

/** a video element for a dance; made in the click itself, so the browser lets it play with sound later */
export function danceVideo(d: Dance, sound: boolean): HTMLVideoElement {
  const v = document.createElement("video");
  v.src = d.src;
  v.preload = "auto";
  v.playsInline = true;
  v.muted = !sound;
  v.crossOrigin = "anonymous";
  // play and stop at once while the click is still the user's: Safari then allows the real play later
  v.play()
    .then(() => {
      // the dance may have started meanwhile (she was already out front): then it keeps playing
      if (v.dataset.dancing) return;
      v.pause();
      v.currentTime = 0;
    })
    .catch(() => undefined);
  return v;
}

/** the dance drawn over the study; `onEnd` when the video is over (or cannot play) */
/** why a dance could not play, said in her words with the code for us */
function why(video: HTMLVideoElement, e?: unknown): string {
  if (video.error) return `${t("영상 오류 {code}", { code: video.error.code })}${video.error.message ? ` · ${video.error.message.slice(0, 60)}` : ""}`;
  if (e instanceof Error || (e && typeof e === "object" && "name" in e)) return t("재생 거부 · {name}", { name: (e as Error).name });
  return t("재생 실패");
}

export function DanceArt({ dance, video, className, style, onEnd }: { dance: Dance; video: HTMLVideoElement; className?: string; style?: React.CSSProperties; onEnd: (failed?: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;

  useEffect(() => {
    const c = canvas.current;
    const gl = c?.getContext("webgl", { premultipliedAlpha: true, alpha: true });
    if (!c || !gl) {
      ended.current(t("WebGL 없음"));
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
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let alive = true;
    let handle = 0;
    const draw = () => {
      if (!alive) return;
      if (video.readyState >= 2) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        gl.viewport(0, 0, c.width, c.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // a new picture for each video frame where the browser can say so, else every screen frame
      const rv = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (rv.requestVideoFrameCallback && !video.paused) handle = rv.requestVideoFrameCallback(draw);
      else handle = requestAnimationFrame(draw);
    };
    const finish = () => ended.current();
    const fail = (e?: unknown) => ended.current(why(video, e));
    video.addEventListener("ended", finish);
    const onError = () => fail();
    video.addEventListener("error", onError);
    video.dataset.dancing = "1";
    video.currentTime = 0;
    video.play().then(draw, () => {
      // no sound allowed after all: dance without it
      video.muted = true;
      video.play().then(draw, fail);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(handle);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", onError);
      video.pause();
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
    };
  }, [video]);

  return <canvas ref={canvas} className={className} style={style} width={dance.w} height={dance.h} aria-hidden />;
}
