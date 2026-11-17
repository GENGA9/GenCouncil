"""위원회 구조 애니메이션 GIF 생성기 (한 화면 고정 트리 + 의사결정 흐름 루프).

실행: py docs/diagrams/make_council_gif.py
출력: docs/diagrams/council-structure.gif (1200x800, 9초 루프)

전체 구조(의장 → 배정 → provider 4갈래 → 위원 카드 → 결과 분기 → 머지)는
처음부터 끝까지 한 화면에 흐린 색으로 고정돼 있고, 그 위로 빛나는 점(펄스)이
위에서 아래로 여러 갈래에서 시차를 두고 동시에 흘러내린다. 지나간 선·박스는
잠깐 밝아졌다가 서서히 원래 밝기로 돌아온다. 모든 시간 함수가 주기 T의
나머지(mod T)로 정의돼 있어서 마지막 프레임 다음이 첫 프레임과 정확히 이어진다.

내용 출처(코드가 원본):
  packages/council/src/models.ts   모델 사다리(LADDERS), 기본 한도(DEFAULT_LIMITS)
  packages/council/src/council.ts  memberHelpers(어드바이저/탐색기), --advisor/--agents,
                                   자동 핸드오버·자동 검증(Gemini Flash), merge
  packages/council/src/explorers.ts  claude 탐색기 = haiku 서브에이전트
"""
from __future__ import annotations

import math
import os
import sys
from functools import lru_cache

from PIL import Image, ImageChops, ImageDraw, ImageFont

W, H = 1200, 800
FRAME_MS = 60  # 16.7fps (GIF은 1/100초 단위라 60ms가 정확히 표현된다)
T = 9.0  # 루프 길이(초)
N = int(round(T * 1000 / FRAME_MS))  # 150프레임
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "council-structure.gif")
SHOTS = os.environ.get("COUNCIL_SHOTS_DIR")  # 지정하면 루프 중 4시점을 flow1~4.png로 저장

FONT = "C:/Windows/Fonts/malgun.ttf"
FONT_B = "C:/Windows/Fonts/malgunbd.ttf"
for _f in (FONT, FONT_B):
    if not os.path.exists(_f):
        sys.exit(f"font not found: {_f}")


@lru_cache(maxsize=None)
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_B if bold else FONT, size)


BG = (18, 20, 26)
PANEL = (30, 33, 42)
LINE = (62, 67, 82)
TEXT = (232, 234, 240)
DIM = (165, 170, 186)
COL = {
    "claude": (240, 138, 60),
    "gemini": (84, 148, 245),
    "gpt": (72, 190, 110),
    "relay": (160, 166, 180),
}
CHAIR = (190, 120, 235)
MERGE_C = (240, 200, 70)
RED = (238, 72, 96)
OK_C = (200, 206, 220)
ADV_C = (200, 150, 245)  # 어드바이저
EXP_C = (110, 200, 220)  # 탐색기

NCOLORS = 200  # GIF 팔레트 색 수 (255는 투명 인덱스로 예약)
TAU_NODE = 0.6  # 박스 잔광이 줄어드는 시간 상수(초)
TAU_TRAIL = 0.8  # 선 잔광
SPEED = 560.0  # 펄스 속도(px/s)


def mix(c, a):
    """배경과 섞어 a(0~1)만큼 보이게 한다."""
    return tuple(int(BG[i] + (c[i] - BG[i]) * a) for i in range(3))


def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


# ---------------------------------------------------------------- 구조(정적)
CW, GAP, CX0 = 278, 12, 26


def colx(i):
    return CX0 + i * (CW + GAP)


def cxm(i):
    return colx(i) + CW // 2


PROV = ["claude", "gemini", "gpt", "relay"]
COL_Y0, COL_Y1 = 228, 382
CARD_Y0, CARD_Y1 = 408, 552
RES_Y0, RES_Y1 = 578, 648
BUS_TOP, BUS_BOT = 204, 676
CHAIR_R = (430, 54, 770, 112)
ASSIGN_R = (330, 138, 870, 184)
MERGE_R = (330, 700, 870, 776)

LADDERS = {  # 하위 → 상위 (읽는 순서 = 왼→오, 위→아래)
    "claude": ["haiku", "sonnet", "opus", "fable"],
    "gemini": ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-argon"],
    "gpt": ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"],
    "relay": ["웹 제미나이 · 1명", "AI Studio · 1명", "ChatGPT 웹 · 0명"],
}
LIMIT_TXT = {"claude": "동시 3명", "gemini": "동시 2명", "gpt": "동시 2명", "relay": "웹 AI 한도"}
CAPS = {
    "claude": ("fable: 주간 잔량 30%↑일 때만", "최대 추론 high"),
    "gemini": ("Flash 코드 작업(커밋)은 자동 검증", "최대 추론 high"),
    "gpt": ("astra: 한도 상향 필요 (기본 sol까지)", "최대 추론 high"),
    "relay": ("ChatGPT 웹은 0명 (사용 안 함)", "사람이 패킷을 전달"),
}


class Node:
    """박스 하나. texts: (x, y, 문자열, 크기, 굵게, 색, 앵커)."""

    def __init__(self, nid, rect, color, texts=(), r=10, width=2, fill=PANEL):
        self.id, self.rect, self.color = nid, rect, color
        self.texts, self.r, self.width, self.fill = list(texts), r, width, fill
        for tx in self.texts:
            self._check(tx)

    def _check(self, tx):
        x, y, s, size, bold, _, anc = tx
        wid = ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(s, font=font(size, bold))
        x0, y0, x1, y1 = self.rect
        pad = 6
        if anc[0] == "l":
            lo, hi = x, x + wid
        elif anc[0] == "r":
            lo, hi = x - wid, x
        else:
            lo, hi = x - wid / 2, x + wid / 2
        if lo < x0 + pad or hi > x1 - pad:
            raise ValueError(f"[{self.id}] text overflows box ({lo:.0f}..{hi:.0f} vs {x0}..{x1}): {s}")


NODES: list[Node] = []
NID: dict[str, Node] = {}


def add(node: Node):
    NODES.append(node)
    NID[node.id] = node
    return node


def build_structure():
    x0, y0, x1, y1 = CHAIR_R
    add(Node("chair", CHAIR_R, CHAIR, [
        (600, y0 + 7, "의장 (Chair · Opus)", 19, True, CHAIR, "ma"),
        (600, y0 + 34, "위원마다 독립 git worktree · 브랜치(member/…)", 12, False, DIM, "ma"),
    ], width=3))
    x0, y0, x1, y1 = ASSIGN_R
    add(Node("assign", ASSIGN_R, CHAIR, [
        (600, (y0 + y1) // 2, "council_assign: provider · model · effort · advisor 선택", 15, True, TEXT, "mm"),
    ]))

    for i, k in enumerate(PROV):
        x = colx(i)
        c = COL[k]
        cap1, cap2 = CAPS[k]
        add(Node(f"col{i}", (x, COL_Y0, x + CW, COL_Y1), c, [
            (x + 14, COL_Y0 + 6, k, 19, True, c, "la"),
            (x + CW - 14, COL_Y0 + 10, LIMIT_TXT[k], 14, True, TEXT, "ra"),
            (cxm(i), COL_Y0 + 112, cap1, 12, False, DIM, "ma"),
            (cxm(i), COL_Y0 + 131, cap2, 12, False, DIM, "ma"),
        ], width=2))
        cwid = (CW - 28 - 12) // 2
        for j, m in enumerate(LADDERS[k]):
            cx0 = x + 14 + (j % 2) * (cwid + 12)
            cy0 = COL_Y0 + 40 + (j // 2) * 34
            add(Node(f"chip{i}_{j}", (cx0, cy0, cx0 + cwid, cy0 + 28), c, [
                ((2 * cx0 + cwid) // 2, cy0 + 14, m, 12, False, TEXT, "mm"),
            ], r=7, fill=BG))

        # 위원 카드
        if k != "relay":
            adv = "어드바이저 · --advisor 플래그" if k == "claude" else "어드바이저 · consult 도구"
            exp = "탐색기 · haiku 서브에이전트" if k == "claude" else "탐색기 · explore 도구"
            add(Node(f"card{i}", (x, CARD_Y0, x + CW, CARD_Y1), c, [
                (x + 14, CARD_Y0 + 6, "위원 = 독립 worktree 하나", 14, True, c, "la"),
            ], width=2))
            rows = [("w", "워커 · 배정된 모델이 작업·커밋", c, 30), ("a", adv, ADV_C, 66), ("e", exp, EXP_C, 102)]
            for key, label, rc, off in rows:
                add(Node(f"{key}{i}", (x + 22, CARD_Y0 + off, x + CW - 22, CARD_Y0 + off + 28), rc, [
                    (x + 32, CARD_Y0 + off + 14, label, 13, key == "w", TEXT, "lm"),
                ], r=7, fill=BG))
        else:
            add(Node(f"card{i}", (x, CARD_Y0, x + CW, CARD_Y1), c, [
                (x + 14, CARD_Y0 + 6, "위원 = 사람이 중계", 14, True, c, "la"),
            ], width=2))
            add(Node("r1", (x + 22, CARD_Y0 + 30, x + CW - 22, CARD_Y0 + 78), c, [
                (x + 32, CARD_Y0 + 42, "사람이 패킷 복사", 13, True, TEXT, "lm"),
                (x + 32, CARD_Y0 + 64, "→ 웹 제미나이 · AI Studio에 전달", 12, False, DIM, "lm"),
            ], r=7, fill=BG))
            add(Node("r2", (x + 22, CARD_Y0 + 90, x + CW - 22, CARD_Y0 + 138), c, [
                (x + 32, CARD_Y0 + 102, "답 붙여넣기", 13, True, TEXT, "lm"),
                (x + 32, CARD_Y0 + 124, "웹 AI의 답을 결과로 받는다", 12, False, DIM, "lm"),
            ], r=7, fill=BG))

    # 결과 분기
    res = [
        ("res0", OK_C, "정상 완료", ["위원이 작업·커밋을 끝냄", "→ 의장 diff 검토로"]),
        ("res1", COL["claude"], "Claude 검증 위원", ["Gemini Flash 커밋 시 자동 부착", "같은 worktree·브랜치에서 확인"]),
        ("res2", RED, "핸드오버", ["한도/로그인 오류 → 작업 중단", "같은 worktree에서 다음 위원이 이어감"]),
    ]
    for i, (nid, c, title, subs) in enumerate(res):
        x = colx(i)
        add(Node(nid, (x, RES_Y0, x + CW, RES_Y1), c, [
            (cxm(i), RES_Y0 + 7, title, 16, True, c, "ma"),
            (cxm(i), RES_Y0 + 31, subs[0], 12, False, DIM, "ma"),
            (cxm(i), RES_Y0 + 49, subs[1], 12, False, DIM, "ma"),
        ]))

    x0, y0, x1, y1 = MERGE_R
    add(Node("merge", MERGE_R, MERGE_C, [
        (600, y0 + 10, "의장 diff 검토 → council_merge", 18, True, MERGE_C, "ma"),
        (600, y0 + 42, "통합 브랜치 agenda/… 에 위원 결과를 합친다", 13, False, TEXT, "ma"),
    ], width=3))


def build_edges():
    """흐린 색으로 항상 보이는 연결선: [(점들), 끝에 화살촉 여부]."""
    E = []
    E.append(([(600, CHAIR_R[3]), (600, ASSIGN_R[1])], True))
    E.append(([(600, ASSIGN_R[3]), (600, BUS_TOP)], False))
    E.append(([(cxm(0), BUS_TOP), (cxm(3), BUS_TOP)], False))
    for i in range(4):
        E.append(([(cxm(i), BUS_TOP), (cxm(i), COL_Y0)], True))
        E.append(([(cxm(i), COL_Y1), (cxm(i), CARD_Y0)], True))
    for i in range(3):
        E.append(([(cxm(i), CARD_Y1), (cxm(i), RES_Y0)], True))
        E.append(([(cxm(i), RES_Y1), (cxm(i), BUS_BOT)], False))
    E.append(([(cxm(3), CARD_Y1), (cxm(3), BUS_BOT)], False))  # relay는 곧장 머지로
    E.append(([(cxm(0), BUS_BOT), (cxm(3), BUS_BOT)], False))
    E.append(([(600, BUS_BOT), (600, MERGE_R[1])], True))
    # 카드 안 척추(워커 ↔ 어드바이저/탐색기, 사람 복사 ↔ 붙여넣기)
    for i in range(3):
        sx = colx(i) + 10
        wy, ay, ey = CARD_Y0 + 44, CARD_Y0 + 80, CARD_Y0 + 116
        E.append(([(colx(i) + 22, wy), (sx, wy), (sx, ey), (colx(i) + 22, ey)], False))
        E.append(([(sx, ay), (colx(i) + 22, ay)], False))
    sx = colx(3) + 10
    E.append(([(colx(3) + 22, CARD_Y0 + 54), (sx, CARD_Y0 + 54), (sx, CARD_Y0 + 114), (colx(3) + 22, CARD_Y0 + 114)], False))
    return E


# ---------------------------------------------------------------- 흐름(갈래)
def plen(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def go(pts, dur=None, color=None, ev=()):
    return {"k": "go", "pts": pts, "dur": dur if dur is not None else plen(pts) / SPEED, "color": color, "ev": list(ev)}


def wait(dur, ev=(), color=None):
    return {"k": "wait", "dur": dur, "color": color, "ev": list(ev)}


def wy(i):
    return CARD_Y0 + 44


def spine(i):
    return colx(i) + 10


def common_head(i, chip):
    """의장 → 배정 → 분기 → provider 열(i) → 선택한 모델 칩 → 카드의 워커."""
    cx = cxm(i)
    return [
        go([(600, CHAIR_R[3] - 20), (600, ASSIGN_R[1])], 0.25, ev=[(0, "chair", 0.25)]),
        go([(600, ASSIGN_R[1]), (600, ASSIGN_R[3])], 0.3, ev=[(0, "assign", 0.3)]),
        go([(600, ASSIGN_R[3]), (600, BUS_TOP), (cx, BUS_TOP), (cx, COL_Y0)]),
        go([(cx, COL_Y0), (cx, COL_Y1)], 0.55, ev=[(0, f"col{i}", 0.5), (0.45, f"chip{i}", 0.9)]),
        go([(cx, COL_Y1), (cx, CARD_Y0), (cx, wy(i))], ev=[(0.45, f"card{i}", 0.6)]),
    ]


def branch_a():  # claude sonnet → 어드바이저 상담 → 정상 완료 → 머지
    i, cx, s = 0, cxm(0), spine(0)
    ay, ey = CARD_Y0 + 80, CARD_Y0 + 116
    steps = common_head(i, 1)
    steps[3]["ev"][1] = (0.45, "chip0_1", 0.9)
    steps += [
        wait(0.3, ev=[(0, "w0", 0.5)]),
        go([(cx, wy(i)), (s, wy(i)), (s, ay), (cx, ay)], ev=[(0.95, "a0", 0.5)]),
        wait(0.3),
        go([(cx, ay), (s, ay), (s, wy(i)), (cx, wy(i))], ev=[(0.95, "w0", 0.4)]),
        wait(0.1),
        go([(cx, wy(i)), (cx, CARD_Y1), (cx, RES_Y0)], ev=[(1.0, "res0", 0.5)]),
        go([(cx, RES_Y0), (cx, RES_Y1), (cx, BUS_BOT), (600, BUS_BOT), (600, MERGE_R[1])], ev=[(1.0, "merge", 0.7)]),
        wait(0.5),
    ]
    return {"name": "a", "color": COL["claude"], "start": 0.0, "steps": steps,
            "label": "claude · sonnet → 어드바이저 상담 → 정상 완료"}


def branch_b():  # gemini flash → 탐색기 → 커밋 → 검증 위원 → 머지
    i, cx, s = 1, cxm(1), spine(1)
    ey = CARD_Y0 + 116
    steps = common_head(i, 0)
    steps[3]["ev"][1] = (0.45, "chip1_0", 0.9)
    ORG = COL["claude"]
    steps += [
        wait(0.3, ev=[(0, "w1", 0.5)]),
        go([(cx, wy(i)), (s, wy(i)), (s, ey), (cx, ey)], ev=[(0.95, "e1", 0.5)]),
        wait(0.3),
        go([(cx, ey), (s, ey), (s, wy(i)), (cx, wy(i))], ev=[(0.95, "w1", 0.5)]),
        wait(0.15),
        go([(cx, wy(i)), (cx, CARD_Y1), (cx, RES_Y0)], ev=[(1.0, "res1", 0.8, ORG)]),
        wait(0.4, color=ORG),
        go([(cx, RES_Y0), (cx, RES_Y1), (cx, BUS_BOT), (600, BUS_BOT), (600, MERGE_R[1])], color=ORG, ev=[(1.0, "merge", 0.7)]),
        wait(0.5, color=ORG),
    ]
    return {"name": "b", "color": COL["gemini"], "start": 2.0, "steps": steps,
            "label": "gemini · flash → 탐색기 → 커밋 → 검증 위원"}


def branch_c():  # gpt sol → 한도 오류 → 핸드오버 → 완료 → 머지
    i, cx = 2, cxm(2)
    steps = common_head(i, 2)
    steps[3]["ev"][1] = (0.45, "chip2_2", 0.9)
    mid = (RES_Y0 + RES_Y1) // 2
    G = COL["gpt"]
    steps += [
        wait(0.3, ev=[(0, "w2", 0.5)]),
        go([(cx, wy(i)), (cx, CARD_Y1), (cx, mid)], color=RED, ev=[(0, "w2", 0.45, RED), (1.0, "res2", 0.8)]),
        wait(0.4, color=RED),
        go([(cx, mid), (cx, CARD_Y1), (cx, wy(i))], color=G, ev=[(1.0, "w2", 0.6)]),
        wait(0.2),
        go([(cx, wy(i)), (cx, CARD_Y1), (cx, RES_Y1), (cx, BUS_BOT), (600, BUS_BOT), (600, MERGE_R[1])], color=G,
           ev=[(0.3, "res2", 0.4, G), (1.0, "merge", 0.7)]),
        wait(0.5),
    ]
    return {"name": "c", "color": G, "start": 4.0, "steps": steps,
            "label": "gpt · sol → 한도 오류 → 핸드오버 → 완료"}


def branch_d():  # relay → 사람 복사 → 붙여넣기 → 머지
    i, cx, s = 3, cxm(3), spine(3)
    r1, r2 = CARD_Y0 + 54, CARD_Y0 + 114
    steps = common_head(i, 0)
    steps[3]["ev"][1] = (0.45, "chip3_0", 0.9)
    steps[4] = go([(cx, COL_Y1), (cx, CARD_Y0), (cx, r1)], ev=[(0.45, "card3", 0.6), (1.0, "r1", 0.7)])
    steps += [
        wait(0.45),
        go([(cx, r1), (s, r1), (s, r2), (cx, r2)], ev=[(0.95, "r2", 0.7)]),
        wait(0.45),
        go([(cx, r2), (cx, CARD_Y1), (cx, BUS_BOT), (600, BUS_BOT), (600, MERGE_R[1])], ev=[(1.0, "merge", 0.7)]),
        wait(0.5),
    ]
    return {"name": "d", "color": COL["relay"], "start": 6.0, "steps": steps,
            "label": "relay → 사람 복사 → 답 붙여넣기 → 머지"}


# 갈래별 시간표를 미리 계산: 구간별 시작 오프셋, 선 조각의 통과 시각, 박스 이벤트
class Flow:
    def __init__(self, spec):
        self.name, self.color, self.start, self.label = spec["name"], spec["color"], spec["start"], spec["label"]
        self.steps = spec["steps"]
        off = 0.0
        self.pieces = []  # (x0, y0, x1, y1, 통과 시각(절대), 색)
        for st in self.steps:
            st["off"] = off
            st["color"] = st["color"] or self.color
            if st["k"] == "go":
                pts, dur = st["pts"], st["dur"]
                tot = plen(pts)
                acc = 0.0
                for a, b in zip(pts, pts[1:]):
                    seg = math.dist(a, b)
                    if seg == 0:
                        continue
                    n = max(1, int(seg // 6))
                    for q in range(n):
                        f0, f1 = q / n, (q + 1) / n
                        p0 = (a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0)
                        p1 = (a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1)
                        mid = (acc + seg * (f0 + f1) / 2) / tot
                        self.pieces.append((p0, p1, self.start + off + dur * mid, st["color"]))
                    acc += seg
            off += st["dur"]
        self.L = off
        if self.L > T - 0.3:
            raise ValueError(f"branch {self.name} too long: {self.L:.2f}s")

    def events(self):
        for st in self.steps:
            for e in st["ev"]:
                frac, nid, dwell = e[0], e[1], e[2]
                col = e[3] if len(e) > 3 else None
                yield nid, self.start + st["off"] + frac * st["dur"], dwell, col

    def head(self, t):
        u = (t - self.start) % T
        if u > self.L:
            return None
        for st in self.steps:
            if u <= st["off"] + st["dur"] or st is self.steps[-1]:
                f = (u - st["off"]) / st["dur"] if st["dur"] else 1.0
                f = max(0.0, min(1.0, f))
                if st["k"] == "wait":
                    # 직전 go의 끝점에서 대기
                    idx = self.steps.index(st)
                    p = None
                    for prev in reversed(self.steps[:idx]):
                        if prev["k"] == "go":
                            p = prev["pts"][-1]
                            break
                    pos = p
                else:
                    pts = st["pts"]
                    tot = plen(pts)
                    d = tot * f
                    pos = pts[-1]
                    for a, b in zip(pts, pts[1:]):
                        seg = math.dist(a, b)
                        if d <= seg and seg > 0:
                            pos = (a[0] + (b[0] - a[0]) * d / seg, a[1] + (b[1] - a[1]) * d / seg)
                            break
                        d -= seg
                fade = min(1.0, u / 0.15, (self.L - u) / 0.3)
                return pos, st["color"], max(0.0, fade)
        return None


FLOWS: list[Flow] = []
EVENTS: dict[str, list[tuple[float, float, tuple | None]]] = {}


def build_flows():
    for spec in (branch_a(), branch_b(), branch_c(), branch_d()):
        FLOWS.append(Flow(spec))
    for fl in FLOWS:
        for nid, te, dwell, col in fl.events():
            if nid.startswith("chip") and nid.count("_") == 0:
                raise ValueError(nid)
            EVENTS.setdefault(nid, []).append((te, dwell, col))
    for nid in EVENTS:
        if nid not in NID:
            raise KeyError(nid)


def node_state(nid, t):
    best, bc = 0.0, None
    for te, dwell, col in EVENTS.get(nid, ()):
        age = (t - te) % T
        b = ease(age / 0.12) if age < dwell else math.exp(-(age - dwell) / TAU_NODE)
        if b > best:
            best, bc = b, col
    return best, bc


# ---------------------------------------------------------------- 렌더
def arrow_head(d, x, y):
    d.polygon([(x - 6, y - 9), (x + 6, y - 9), (x, y)], fill=mix(LINE, 1.0))


def render(t):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)

    # 1) 박스 (흐린 색, 항상 보임)
    for n in NODES:
        d.rounded_rectangle(n.rect, n.r, fill=n.fill, outline=mix(n.color, 0.5), width=n.width)
    # 2) 정적 연결선
    for pts, ah in EDGES:
        d.line(pts, fill=LINE, width=2, joint="curve")
        if ah:
            arrow_head(d, *pts[-1])

    # 3) 잔광: 선 조각 (밝기 오름차순으로 그려 강한 것이 위로)
    ops = []
    for fl in FLOWS:
        for p0, p1, tau, col in fl.pieces:
            age = (t - tau) % T
            b = math.exp(-age / TAU_TRAIL)
            if b > 0.05:
                ops.append((b, p0, p1, col))
    ops.sort(key=lambda o: o[0])
    for b, p0, p1, col in ops:
        od.line((p0, p1), fill=col + (int(255 * 0.2 * b),), width=11)
    for b, p0, p1, col in ops:
        od.line((p0, p1), fill=col + (int(255 * (0.3 + 0.7 * b)),), width=4)

    # 4) 박스 잔광
    for n in NODES:
        b, col = node_state(n.id, t)
        if b < 0.04:
            continue
        c = col or n.color
        x0, y0, x1, y1 = n.rect
        od.rounded_rectangle(n.rect, n.r, fill=c + (int(255 * 0.17 * b),))
        od.rounded_rectangle((x0 - 3, y0 - 3, x1 + 3, y1 + 3), n.r + 3, outline=c + (int(255 * 0.45 * b),), width=3)
        od.rounded_rectangle(n.rect, n.r, outline=c + (int(255 * b),), width=n.width + 1)

    # 5) 펄스 머리
    for fl in FLOWS:
        h = fl.head(t)
        if not h:
            continue
        (x, y), col, f = h
        core = tuple(int(col[i] + (255 - col[i]) * 0.65) for i in range(3))
        od.ellipse((x - 15, y - 15, x + 15, y + 15), fill=col + (int(255 * 0.22 * f),))
        od.ellipse((x - 9, y - 9, x + 9, y + 9), fill=col + (int(255 * 0.45 * f),))
        od.ellipse((x - 5, y - 5, x + 5, y + 5), fill=core + (int(255 * f),))

    im = Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")
    d = ImageDraw.Draw(im)

    # 6) 글자 (맨 위)
    for n in NODES:
        b, col = node_state(n.id, t)
        for x, y, s, size, bold, c, anc in n.texts:
            a = 0.8 + 0.2 * b
            cc = tuple(int(BG[i] + (c[i] - BG[i]) * a) for i in range(3))
            d.text((x, y), s, font=font(size, bold), fill=cc, anchor=anc)

    # 머리말 + 범례
    d.text((26, 10), "GenCouncil 위원회 구조", font=font(21, True), fill=TEXT)
    d.text((26, 44), "", font=font(12), fill=DIM)
    d.text((280, 14), "의사결정이 위에서 아래로 여러 갈래로 흐른다", font=font(14), fill=DIM)
    d.line((26, 42, W - 26, 42), fill=LINE, width=1)
    d.text((800, 14), "지금 흐르는 갈래", font=font(13, True), fill=DIM)
    d.text((26, 56), "모델 사다리: 하위 → 주력 → 상위", font=font(13, True), fill=TEXT)
    d.text((26, 77), "(기계적 일 → 일반 코딩 → 어려운 설계·디버깅)", font=font(12), fill=DIM)
    d.text((26, 95), "칩 순서: 왼→오, 위→아래 (뒤로 갈수록 강함)", font=font(12), fill=DIM)
    for k, fl in enumerate(FLOWS):
        u = (t - fl.start) % T
        on = 1.0 if u <= fl.L else math.exp(-(u - fl.L) / 0.4)
        on = max(0.4, on)
        y = 58 + k * 19
        d.ellipse((802, y + 3, 812, y + 13), fill=mix(fl.color, on))
        d.text((820, y), fl.label, font=font(13, on > 0.9), fill=mix(TEXT if on > 0.9 else DIM, max(0.55, on)))
    return im


def check_legend_fit():
    dd = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for fl in FLOWS:
        w = dd.textlength(fl.label, font=font(13, True))
        if 820 + w > W - 24:
            raise ValueError(f"legend too wide: {fl.label}")
    if dd.textlength("의사결정이 위에서 아래로 여러 갈래로 흐른다", font=font(14)) + 280 > 790:
        raise ValueError("title note too wide")


EDGES = []


def main():
    build_structure()
    EDGES.extend(build_edges())
    build_flows()
    check_legend_fit()
    for fl in FLOWS:
        print(f"branch {fl.name}: start {fl.start:.1f}s length {fl.L:.2f}s")
    ims = [render(i * T / N) for i in range(N)]
    # 공통 팔레트 하나로 양자화 → 크기 절감, 프레임 간 차분 압축 유리
    sample_idx = list(range(0, N, 5))
    sample = Image.new("RGB", (W, H * len(sample_idx)))
    for k, idx in enumerate(sample_idx):
        sample.paste(ims[idx], (0, H * k))
    pal = sample.quantize(colors=NCOLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in ims]
    # 직전 프레임과 같은 픽셀은 투명 인덱스(255)로 바꿔 LZW가 긴 반복으로 압축하게 한다 (disposal=1 → 이전 화면 유지)
    TR = 255
    out = [q[0]]
    def idx_img(im):  # 팔레트 인덱스를 그대로 담은 L 이미지
        return Image.frombytes("L", im.size, im.tobytes())

    prev_l = idx_img(q[0])
    for fr in q[1:]:
        cur_l = idx_img(fr)
        eq = ImageChops.difference(cur_l, prev_l).point(lambda v: 255 if v == 0 else 0)
        m = fr.copy()
        m.paste(TR, mask=eq)
        out.append(m)
        prev_l = cur_l
    out[0].save(OUT, save_all=True, append_images=out[1:], duration=FRAME_MS, loop=0, optimize=False,
                disposal=1, transparency=TR)
    size = os.path.getsize(OUT)
    print(f"{OUT}: {len(q)} frames, {len(q) * FRAME_MS / 1000:.1f}s, {1000 / FRAME_MS:.1f}fps, {size / 1024:.0f} KB")
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        g = Image.open(OUT)
        for n_, sec in enumerate((1.5, 3.3, 5.1, 7.0), 1):
            g.seek(int(sec * 1000 / FRAME_MS))
            g.convert("RGB").save(os.path.join(SHOTS, f"flow{n_}.png"))
            print("shot", n_, f"{sec}s")


if __name__ == "__main__":
    main()
