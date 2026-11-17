"""위원회 구조 애니메이션 GIF 생성기.

실행: py docs/diagrams/make_council_gif.py
출력: docs/diagrams/council-structure.gif (1000x600, 루프)

내용 출처(코드가 원본):
  packages/council/src/models.ts   모델 사다리(LADDERS), 기본 한도(DEFAULT_LIMITS)
  packages/council/src/council.ts  memberHelpers(어드바이저/탐색기), --advisor/--agents,
                                   자동 핸드오버·자동 검증(Gemini Flash), merge
  packages/council/src/explorers.ts  claude 탐색기 = haiku 서브에이전트
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1000, 600
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "council-structure.gif")
SHOTS = os.environ.get("COUNCIL_SHOTS_DIR")  # 지정하면 장면 대표 프레임을 png로 저장

FONT = "C:/Windows/Fonts/malgun.ttf"
FONT_B = "C:/Windows/Fonts/malgunbd.ttf"
for f in (FONT, FONT_B):
    if not os.path.exists(f):
        sys.exit(f"font not found: {f}")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_B if bold else FONT, size)


BG = (18, 20, 26)
PANEL = (30, 33, 42)
LINE = (62, 67, 82)
TEXT = (232, 234, 240)
DIM = (150, 155, 170)
COL = {
    "claude": (240, 138, 60),
    "gemini": (84, 148, 245),
    "gpt": (72, 190, 110),
    "relay": (140, 144, 156),
}
CHAIR = (190, 120, 235)
MERGE = (240, 200, 70)
RED = (230, 90, 90)


def mix(c, a):
    """배경과 섞어 a(0~1)만큼 보이게 한다 (페이드)."""
    return tuple(int(BG[i] + (c[i] - BG[i]) * a) for i in range(3))


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def ease(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


class Canvas:
    def __init__(self):
        self.im = Image.new("RGB", (W, H), BG)
        self.d = ImageDraw.Draw(self.im)

    def text(self, xy, s, size=16, color=TEXT, bold=False, a=1.0, anchor="la", maxw=None):
        f = font(size, bold)
        if maxw is not None and self.d.textlength(s, font=f) > maxw:
            raise ValueError(f"text too wide ({self.d.textlength(s, font=f):.0f}>{maxw}): {s}")
        self.d.text(xy, s, font=f, fill=mix(color, a), anchor=anchor)

    def box(self, x0, y0, x1, y1, color, a=1.0, fill=PANEL, width=2, r=10):
        self.d.rounded_rectangle((x0, y0, x1, y1), r, fill=mix(fill, a), outline=mix(color, a), width=width)

    def arrow(self, p0, p1, color, prog=1.0, width=4, a=1.0):
        x0, y0 = p0
        x1, y1 = p1
        px, py = x0 + (x1 - x0) * prog, y0 + (y1 - y0) * prog
        c = mix(color, a)
        self.d.line((x0, y0, px, py), fill=c, width=width)
        if prog >= 0.98:
            import math

            ang = math.atan2(y1 - y0, x1 - x0)
            for s in (-0.45, 0.45):
                self.d.line((x1, y1, x1 - 14 * math.cos(ang + s), y1 - 14 * math.sin(ang + s)), fill=c, width=width)


STEPS = ["① 의장", "② 종류별 한도·모델 단계", "③ 위원 = 워커+어드바이저+탐색기", "④ 검증·핸드오버", "⑤ 머지"]


def header(c: Canvas, scene: int):
    c.text((24, 14), "GenCouncil 위원회 구조", 22, TEXT, True)
    x = 330
    for i, s in enumerate(STEPS):
        on = i + 1 == scene
        f = font(13, on)
        w = int(c.d.textlength(s, font=f))
        if x + w > W - 10:
            break
        c.text((x, 20), s, 13, TEXT if on else DIM, on)
        x += w + 18
    c.d.line((24, 52, W - 24, 52), fill=LINE, width=1)


def chair_box(c: Canvas, x, y, w=300, h=86, a=1.0, sub=True):
    c.box(x, y, x + w, y + h, CHAIR, a, width=3)
    c.text((x + w // 2, y + 14), "의장 (Chair · Opus)", 20, CHAIR, True, a, "ma")
    if sub:
        c.text((x + w // 2, y + 46), "council_assign: provider · model", 14, TEXT, False, a, "ma", w - 12)
        c.text((x + w // 2, y + 64), "effort · advisor 를 골라 위원 배정", 14, TEXT, False, a, "ma", w - 12)


# ---------------- 장면 ----------------
LADDERS = {
    "claude": ["haiku", "sonnet", "opus", "fable"],
    "gemini": ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-argon"],
    "gpt": ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"],
}
LIMIT_TXT = {"claude": "동시 3명", "gemini": "동시 2명", "gpt": "동시 2명"}
TIER_TXT = ["하위: 기계적 일", "주력: 일반 코딩", "상위: 어려운 설계·디버깅"]


def scene1(t):  # 의장 등장
    c = Canvas()
    header(c, 1)
    p = ease(t)
    y = int(150 + (1 - p) * 40)
    chair_box(c, 350, y, 300, 86, p)
    c.text((500, 280), "위원마다 독립 git worktree · 브랜치(member/…)", 17, TEXT, False, ease((t - 0.35) / 0.4), "ma")
    c.text((500, 312), "끝나면 의장이 diff를 검토하고 council_merge로 통합 브랜치(agenda/…)에 합친다", 15, DIM, False, ease((t - 0.55) / 0.4), "ma")
    for i, (k, lab) in enumerate([("claude", "claude"), ("gemini", "gemini"), ("gpt", "gpt"), ("relay", "relay")]):
        a = ease((t - 0.5 - i * 0.1) / 0.3)
        x = 160 + i * 190
        c.box(x, 400, x + 160, 450, COL[k], a)
        c.text((x + 80, 413), lab, 20, COL[k], True, a, "ma")
    c.text((500, 480), "위원 종류 4가지", 15, DIM, False, ease((t - 0.8) / 0.2), "ma")
    return c.im


def column(c, k, x, a, rungs_shown, label):
    y0 = 70
    cw = 222
    c.box(x, y0, x + cw, 515, COL[k], a)
    c.text((x + cw // 2, y0 + 10), label, 22, COL[k], True, a, "ma")
    return cw


def scene2(t):  # provider 4열 + 한도 + 사다리
    c = Canvas()
    header(c, 2)
    cols = ["claude", "gemini", "gpt", "relay"]
    for i, k in enumerate(cols):
        a = ease((t - i * 0.18) / 0.2)
        x = 24 + i * 243
        cw = column(c, k, x, a, 0, k)
        if k != "relay":
            c.text((x + cw // 2, 104), LIMIT_TXT[k], 17, TEXT, True, a, "ma")
            c.text((x + cw // 2, 128), "최대 추론 high", 13, DIM, False, a, "ma")
            lad = LADDERS[k][::-1]  # 위에서 아래로: 상위 → 하위
            n = len(lad)
            for j, m in enumerate(lad):
                ra = ease((t - 0.45 - i * 0.12 - j * 0.07) / 0.15)
                yy = 160 + j * 62
                c.box(x + 14, yy, x + cw - 14, yy + 48, COL[k], ra, width=2, r=8)
                c.text((x + cw // 2, yy + 13), m, 16, TEXT, True, ra, "ma", cw - 34)
            # 단계 화살표
            ua = ease((t - 0.8) / 0.2)
            c.text((x + cw // 2, 160 + n * 62 + 4), "▲ 위로 갈수록 강함", 13, DIM, False, ua, "ma")
            if k == "claude":
                c.text((x + cw // 2, 160 + n * 62 + 28), "fable: 주간 잔량 30%↑일 때만", 12, DIM, False, ua, "ma", cw - 16)
            if k == "gpt":
                c.text((x + cw // 2, 160 + n * 62 + 28), "astra: 한도 기본 sol까지", 12, DIM, False, ua, "ma", cw - 16)
        else:
            c.text((x + cw // 2, 106), "사람이 패킷 전달", 15, TEXT, True, a, "ma")
            c.text((x + cw // 2, 128), "웹 AI 한도", 13, DIM, False, a, "ma")
            for j, (nm, lim) in enumerate([("웹 제미나이", "1명"), ("AI Studio", "1명"), ("ChatGPT 웹", "0명 (사용 안 함)")]):
                ra = ease((t - 0.5 - j * 0.12) / 0.2)
                yy = 160 + j * 62
                c.box(x + 14, yy, x + cw - 14, yy + 48, COL[k], ra, r=8)
                c.text((x + cw // 2, yy + 5), nm, 15, TEXT, True, ra, "ma")
                c.text((x + cw // 2, yy + 26), lim, 13, DIM, False, ra, "ma", cw - 34)
    # 단계 설명
    ba = ease((t - 0.85) / 0.15)
    c.text((500, 535), "단계:  하위 = 기계적 일  ·  주력 = 일반 코딩  ·  상위 = 어려운 설계·디버깅", 16, TEXT, True, ba, "ma", 960)
    return c.im


def scene2_legend(im, t):
    return im


def member_card(c, x, y, w, h, k, a, mode):
    """위원 카드: 워커 + 어드바이저 + 탐색기. mode: claude | other"""
    c.box(x, y, x + w, y + h, COL[k], a, width=3)
    c.text((x + 16, y + 8), "위원 = 독립 worktree 하나", 17, COL[k], True, a)
    return


def scene3(t):  # 배정 + 위원 카드
    c = Canvas()
    header(c, 3)
    chair_box(c, 24, 90, 220, 130, 1.0, sub=False)
    c.text((134, 148), "council_assign", 14, TEXT, False, 1, "ma")
    c.text((134, 170), "claude · sonnet", 13, DIM, False, 1, "ma")
    c.text((134, 190), "high · advisor opus", 13, DIM, False, 1, "ma")
    # 화살표
    c.arrow((250, 155), (330, 155), CHAIR, ease(t / 0.2))
    ca = ease((t - 0.2) / 0.2)
    x0, y0, cw, ch = 340, 70, 636, 500
    c.box(x0, y0, x0 + cw, y0 + ch, COL["claude"], ca, width=3)
    c.text((x0 + 16, y0 + 8), "위원 claude-1  (worktree · 브랜치 독립)", 18, COL["claude"], True, ca)

    def part(i, title, sub, colr, tt):
        a = ease((tt - 0.35 - i * 0.15) / 0.15)
        yy = y0 + 46 + i * 66
        c.box(x0 + 16, yy, x0 + cw - 16, yy + 58, colr, a, r=8)
        c.text((x0 + 30, yy + 7), title, 17, colr, True, a)
        c.text((x0 + 30, yy + 32), sub, 14, TEXT, False, a, "la", cw - 70)

    part(0, "워커 (메인 모델)", "의장이 고른 모델이 실제 작업·커밋을 한다", COL["claude"], t)
    part(1, "어드바이저 (같거나 높은 모델, 읽기 전용 상담)", "계획 확정 전 · 같은 오류 2회째 · 완료 선언 전에만 상담", (200, 150, 245), t)
    part(2, "탐색기 (읽기 전용)", "저장소 검색·grep·문서 조회를 대신해 워커 컨텍스트 절약", (110, 200, 220), t)

    # provider별 차이 표
    ta = ease((t - 0.8) / 0.2)
    ty = y0 + 46 + 3 * 66 + 6
    c.d.line((x0 + 16, ty, x0 + cw - 16, ty), fill=mix(LINE, ta), width=1)
    c.text((x0 + 30, ty + 8), "붙는 방식은 종류별로 다르다", 15, TEXT, True, ta)
    rows = [
        ("claude", "어드바이저: --advisor 플래그", "탐색기: haiku 서브에이전트 (--agents)"),
        ("gpt", "어드바이저: consult 도구", "탐색기: explore 도구 (읽기 전용 호출)"),
        ("gemini", "어드바이저: consult 도구", "탐색기: explore 도구 (읽기 전용 호출)"),
    ]
    for i, (k, a1, a2) in enumerate(rows):
        yy = ty + 38 + i * 30
        c.text((x0 + 30, yy), k, 15, COL[k], True, ta)
        c.text((x0 + 110, yy), a1, 14, TEXT, False, ta, "la", 230)
        c.text((x0 + 350, yy), a2, 14, TEXT, False, ta, "la", 270)
    c.text((x0 + 30, ty + 38 + 3 * 30 + 4), "claude Fable 메인은 --advisor 불가 → consult 도구를 대신 받는다", 13, DIM, False, ta, "la", cw - 50)
    # 왼쪽 아래 설명
    c.text((24, 250), "의장이 배정 때 정하는 것", 15, TEXT, True, ta)
    for i, s in enumerate(["provider (claude/gemini/gpt/relay)", "model (종류별 사다리에서)", "effort (한도: 최대 high)", "advisor (같거나 높은 모델)"]):
        c.text((24, 278 + i * 24), "· " + s, 13, DIM, False, ta, "la", 300)
    return c.im


def scene4(t):  # 검증 + 핸드오버
    c = Canvas()
    header(c, 4)
    # 위쪽: 검증
    c.text((24, 70), "검증 (verify)", 20, COL["gemini"], True)
    a = ease(t / 0.2)
    c.box(40, 110, 270, 190, COL["gemini"], a)
    c.text((155, 120), "gemini 위원", 18, COL["gemini"], True, a, "ma")
    c.text((155, 148), "Flash가 코드 작업 완료", 14, TEXT, False, a, "ma", 210)
    c.text((155, 166), "(커밋 있음)", 13, DIM, False, a, "ma")
    c.arrow((275, 150), (400, 150), MERGE, ease((t - 0.2) / 0.2))
    c.text((338, 120), "자동 부착", 14, MERGE, True, ease((t - 0.25) / 0.2), "ma")
    b = ease((t - 0.4) / 0.2)
    c.box(410, 110, 700, 190, COL["claude"], b)
    c.text((555, 120), "claude 검증 위원", 18, COL["claude"], True, b, "ma")
    c.text((555, 148), "같은 worktree·브랜치에서 결과 확인", 14, TEXT, False, b, "ma", 270)
    c.text((555, 166), "기본 sonnet · high (한도 안에서)", 13, DIM, False, b, "ma", 270)
    c.text((730, 140), "Gemini Flash 코드 작업은", 14, DIM, False, b, "la", 250)
    c.text((730, 160), "자동으로 검증한다", 14, DIM, False, b, "la", 250)

    # 아래쪽: 핸드오버
    c.d.line((24, 250, W - 24, 250), fill=LINE, width=1)
    c.text((24, 262), "핸드오버 (handover)", 20, COL["claude"], True)
    h = ease((t - 0.5) / 0.15)
    c.box(40, 310, 270, 400, COL["claude"], h)
    c.text((155, 320), "claude-1 (계정 A)", 18, COL["claude"], True, h, "ma")
    wob = ease((t - 0.62) / 0.1)
    c.text((155, 352), "한도 / 로그인 오류", 15, RED, True, wob, "ma")
    c.text((155, 374), "작업 중단", 13, DIM, False, wob, "ma")
    c.arrow((275, 355), (400, 355), MERGE, ease((t - 0.7) / 0.2))
    c.text((338, 325), "자동 인계", 14, MERGE, True, ease((t - 0.72) / 0.2), "ma")
    g = ease((t - 0.8) / 0.2)
    c.box(410, 310, 700, 400, COL["claude"], g)
    c.text((555, 320), "다음 위원 (다른 계정 B)", 18, COL["claude"], True, g, "ma")
    c.text((555, 350), "같은 worktree에서 이어서 작업", 14, TEXT, False, g, "ma", 270)
    c.text((555, 372), "필요하면 모델·종류도 조정", 13, DIM, False, g, "ma", 270)
    c.text((730, 340), "인계 횟수에는 상한이 있다", 14, DIM, False, g, "la", 250)
    c.text((24, 440), "※ 두 흐름 모두 의장이 council_verify / council_handover 로 수동 실행도 가능", 13, DIM, False, ease((t - 0.85) / 0.15))
    return c.im


def scene5(t):  # 머지
    c = Canvas()
    header(c, 5)
    # 위원 3개
    members = [("claude-1", "claude"), ("gemini-1", "gemini"), ("gpt-1", "gpt")]
    for i, (nm, k) in enumerate(members):
        a = ease((t - i * 0.08) / 0.15)
        y = 90 + i * 110
        c.box(40, y, 270, y + 80, COL[k], a)
        c.text((155, y + 10), f"위원 {nm}", 17, COL[k], True, a, "ma")
        c.text((155, y + 40), f"member/…/{nm}", 13, DIM, False, a, "ma", 200)
    # 의장 검토
    ra = ease((t - 0.3) / 0.2)
    c.box(400, 170, 600, 270, CHAIR, ra, width=3)
    c.text((500, 180), "의장 검토", 19, CHAIR, True, ra, "ma")
    c.text((500, 214), "diff 확인", 14, TEXT, False, ra, "ma")
    c.text((500, 236), "council_merge", 14, TEXT, False, ra, "ma")
    for i, (_, k) in enumerate(members):
        y = 130 + i * 110
        c.arrow((275, y), (395, 220), COL[k], ease((t - 0.25 - i * 0.07) / 0.25), 3)
    # 통합 브랜치
    ma = ease((t - 0.65) / 0.2)
    c.arrow((605, 220), (730, 220), MERGE, ease((t - 0.55) / 0.2), 5)
    c.box(740, 170, 960, 270, MERGE, ma, width=3)
    c.text((850, 182), "통합 브랜치", 19, MERGE, True, ma, "ma")
    c.text((850, 216), "agenda/…", 15, TEXT, False, ma, "ma")
    c.text((850, 238), "위원 결과가 합쳐진다", 13, DIM, False, ma, "ma", 200)
    c.text((500, 400), "의장 지시 → 위원 병렬 작업 → 검토 → 통합", 22, TEXT, True, ease((t - 0.8) / 0.2), "ma")
    return c.im


# ---------------- 프레임 구성 ----------------
FRAME_MS = 100  # 애니메이션 구간 프레임 간격


def build():
    frames: list[tuple[Image.Image, int]] = []
    marks: dict[int, int] = {}  # scene -> 대표 프레임 index

    def run(fn, scene, secs, hold_ms, rep=0.95):
        n = int(secs * 1000 / FRAME_MS)
        anim = max(1, n - hold_ms // FRAME_MS * 0)  # 전 구간 애니메이션 후 마지막 프레임을 hold로 연장
        for i in range(n):
            t = (i + 1) / n
            frames.append((fn(t), FRAME_MS))
        last_im, _ = frames[-1]
        frames[-1] = (last_im, FRAME_MS + hold_ms)
        marks[scene] = len(frames) - 1

    # 애니메이션은 앞 70% 구간에서 끝나고 나머지는 정지한 모습이 되도록 t를 압축
    def squeeze(fn, k=0.7):
        return lambda t: fn(min(1.0, t / k))

    run(squeeze(scene1), 1, 1.6, 400)       # 2.0s
    run(squeeze(scene2), 2, 2.4, 800)       # 3.2s
    run(squeeze(scene3), 3, 2.6, 800)       # 3.4s
    run(squeeze(scene4), 4, 1.8, 600)       # 2.4s
    run(squeeze(scene5), 5, 1.2, 2000)      # 3.2s (마지막 2초 정지)
    return frames, marks


def main():
    frames, marks = build()
    ims = [f for f, _ in frames]
    durs = [d for _, d in frames]
    # 공통 팔레트 하나로 양자화 → 크기 절감
    pal_src = Image.new("RGB", (W, H * 1))
    sample = Image.new("RGB", (W, H * min(len(ims), 30)))
    for i, im in enumerate(ims[:: max(1, len(ims) // 30)][:30]):
        sample.paste(im, (0, H * i))
    pal = sample.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in ims]
    q[0].save(OUT, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)
    print(f"{OUT}: {len(q)} frames, {sum(durs)/1000:.1f}s, {os.path.getsize(OUT)/1024:.0f} KB")
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        for s, idx in marks.items():
            ims[idx].save(os.path.join(SHOTS, f"scene{s}.png"))
            print("shot", s, idx)


if __name__ == "__main__":
    main()
