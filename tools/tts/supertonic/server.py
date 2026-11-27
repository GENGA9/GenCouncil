"""Thin OpenAI-compatible TTS adapter for Supertonic 3 (CPU, ONNX) -- from Agentg M1, now GenCouncil's.

Why an adapter: supertonic 1.3.1 ships `supertonic serve` with POST /v1/audio/speech, but it needs
the optional `supertonic[serve]` extra (fastapi + uvicorn), which is not installed in the existing
experiments venv, and that venv belongs to another work item. This file uses only the standard library
plus the already-installed `supertonic` / `numpy`, so the existing venv is reused read-only.

Contract (ARCHITECTURE.md section 3.3/3.4):
  GET  /health            -> 200 {"status":"ok","engine":"supertonic-3","voices":[...],"languages":[...]}
                             (the socket is bound only after the model is loaded)
  POST /v1/audio/speech   {"model","input","voice","response_format":"wav","speed"} -> audio/wav (PCM16 mono)
Language is not part of the request (OpenAI contract). It comes from the voice name:
  "ko_F1" / "ja_M1"  -> that language with preset F1 / M1
  "F1"               -> language detected from the letters (Hangul -> ko, Kana -> ja, else --default-lang)
Listens on 127.0.0.1 only (other hosts are refused).

Run (example):
  <venv>/Scripts/python.exe -I -X utf8 tools/tts-adapters/supertonic/server.py --port 18880 \
      --model-dir %LOCALAPPDATA%/Agentg/experiments/tts/supertonic/model
"""
import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LANGS = ("ko", "ja")
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')}.{int(time.time() * 1000) % 1000:03d} {msg}", flush=True)


def detect_lang(text, default):
    hangul = sum(1 for c in text if '가' <= c <= '힣' or 'ᄀ' <= c <= 'ᇿ' or '㄰' <= c <= '㆏')
    kana = sum(1 for c in text if '぀' <= c <= 'ヿ' or 'ㇰ' <= c <= 'ㇿ' or 'ｦ' <= c <= 'ﾟ')
    if hangul == 0 and kana == 0:
        return default
    return "ko" if hangul >= kana else "ja"


class Engine:
    def __init__(self, args):
        from supertonic import TTS  # imported here so --help works without the venv
        t0 = time.perf_counter()
        self.model = TTS(model_dir=Path(args.model_dir), auto_download=False,
                         intra_op_num_threads=args.threads, inter_op_num_threads=1)
        self.sample_rate = self.model.sample_rate
        self.steps = args.steps
        self.base_speed = args.base_speed
        self.default_lang = args.default_lang
        styles_dir = Path(args.model_dir) / "voice_styles"
        self.presets = sorted(p.stem for p in styles_dir.glob("*.json"))
        self.styles = {name: self.model.get_voice_style(name) for name in self.presets}
        self.voices = list(self.presets) + [f"{lang}_{p}" for lang in LANGS for p in self.presets]
        self.lock = threading.Lock()  # ONNX sessions are used by one request at a time
        log(f"model loaded in {time.perf_counter() - t0:.2f}s sample_rate={self.sample_rate} presets={self.presets}")

    def parse_voice(self, voice, text):
        if voice in self.styles:
            return detect_lang(text, self.default_lang), voice
        if "_" in voice:
            lang, preset = voice.split("_", 1)
            if lang in LANGS and preset in self.styles:
                return lang, preset
        return None, None

    def synthesize(self, text, lang, preset, speed):
        import numpy as np
        with self.lock:
            t0 = time.perf_counter()
            np.random.seed(20261124)
            wav, _ = self.model.synthesize(text, voice_style=self.styles[preset], lang=lang,
                                           total_steps=self.steps, speed=self.base_speed * speed)
            ms = (time.perf_counter() - t0) * 1000
        pcm = np.clip(np.asarray(wav, dtype=np.float32).squeeze(), -1.0, 1.0)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.sample_rate)
            w.writeframes((pcm * 32767).astype("<i2").tobytes())
        return buf.getvalue(), ms, len(pcm) / self.sample_rate


class Handler(BaseHTTPRequestHandler):
    engine = None
    server_version = "agentg-supertonic-adapter/0.1"

    def log_message(self, fmt, *args):  # quiet default access log; we log our own lines
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code, message, err_code):
        log(f"error {code} {err_code}: {message}")
        self._json(code, {"error": {"message": message, "type": "invalid_request_error", "code": err_code}})

    def do_GET(self):
        if self.path in ("/health", "/v1/models"):
            e = self.engine
            self._json(200, {"status": "ok", "engine": "supertonic-3", "voices": e.voices,
                             "languages": list(LANGS), "sample_rate": e.sample_rate,
                             "data": [{"id": "supertonic-3", "object": "model"}]})
        else:
            self._error(404, f"no route {self.path}", "not_found")

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            return self._error(404, f"no route {self.path}", "not_found")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                return self._error(400, "body missing or too large", "bad_body")
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as ex:
            return self._error(400, f"invalid json: {ex}", "bad_json")
        if not isinstance(req, dict):
            return self._error(400, "body must be an object", "bad_json")
        # Request log for M1 condition 6: the keys the watcher sent (lang must not be among them).
        log(f"request keys={sorted(req.keys())} voice={req.get('voice')!r} chars={len(str(req.get('input', '')))}")
        text = req.get("input")
        if not isinstance(text, str) or not text.strip():
            return self._error(400, "input must be a non-empty string", "bad_input")
        if req.get("model", "supertonic-3") not in ("supertonic-3", "tts-1"):
            return self._error(400, f"unknown model {req.get('model')!r}", "unknown_model")
        fmt = req.get("response_format", "wav")
        if fmt != "wav":
            return self._error(400, f"unsupported response_format {fmt!r} (only wav)", "bad_format")
        speed = req.get("speed", 1.0)
        if not isinstance(speed, (int, float)) or not 0.5 <= float(speed) <= 2.0:
            return self._error(400, "speed must be 0.5-2.0", "bad_speed")
        lang, preset = self.engine.parse_voice(str(req.get("voice", "")), text)
        if lang is None:
            return self._error(400, f"unknown voice {req.get('voice')!r}", "unknown_voice")
        try:
            data, ms, sec = self.engine.synthesize(text, lang, preset, float(speed))
        except Exception as ex:  # noqa: BLE001 - report any engine failure as HTTP 500
            return self._error(500, f"synthesis failed: {type(ex).__name__}: {ex}", "synthesis_failed")
        log(f"synth lang={lang} preset={preset} chars={len(text)} ms={ms:.0f} audio_s={sec:.2f} rtf={ms / 1000 / max(sec, 1e-6):.3f}")
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    default_model = Path.home() / ".gencouncil/tts/supertonic/model"
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18880)
    ap.add_argument("--model-dir", default=str(default_model))
    ap.add_argument("--threads", type=int, default=4, help="ONNX intra-op threads")
    ap.add_argument("--steps", type=int, default=8, help="Supertonic total_steps")
    ap.add_argument("--base-speed", type=float, default=1.05, help="Supertonic speed at request speed 1.0")
    ap.add_argument("--default-lang", default="ko", choices=LANGS)
    args = ap.parse_args()
    if args.host not in LOOPBACK:
        print(f"refusing to listen on {args.host}: loopback only (127.0.0.1)", file=sys.stderr)
        return 2
    if not (Path(args.model_dir) / "onnx").is_dir():
        print(f"model dir not found: {args.model_dir}", file=sys.stderr)
        return 3
    log(f"loading supertonic from {args.model_dir} (threads={args.threads} steps={args.steps})")
    Handler.engine = Engine(args)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    log(f"listening on http://{args.host}:{args.port} (pid {os.getpid()})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
