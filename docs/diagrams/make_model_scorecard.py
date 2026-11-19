"""AI 모델 한눈에 보기: 점수 순위 막대그래프 + 한 줄 성격 PNG 생성기.

실행: py docs/diagrams/make_model_scorecard.py
출력: docs/diagrams/model_scorecard.png
점수는 실제 작업 관찰(Gen Wiki models/ 11쪽 기준)을 바탕으로 한 주관 평가다.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

W = 2300
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "model_scorecard.png")

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
COL = {"claude": (240, 138, 60), "gemini": (84, 148, 245), "gpt": (72, 190, 110)}
# 항목: (이름, 설명, 색)
ITEMS = [
    ("속도", "빨리 끝내는가", (255, 205, 70)),
    ("신뢰도", "시킨 대로 정확히 하는가", (50, 200, 190)),
    ("지능", "어렵고 복잡한 일을 해내는가", (175, 125, 245)),
    ("가성비", "비용 대비 쓸모", (245, 110, 150)),
]

# (provider, 모델명, 속도, 신뢰도, 지능, 가성비, 한 줄 성격)
M = [
    ("claude", "claude-haiku", 10, 8, 4, 10, "정해진 일을 빠르고 싸게 처리. 파일 정리·단순 수정에 좋고 복잡한 판단은 약함"),
    ("claude", "claude-sonnet", 5, 8, 7, 7, "무난한 만능 일꾼. 자료 정리·기능 추가·문서 작성에 좋고 꼼꼼한 점검은 아쉬움"),
    ("claude", "claude-opus", 2, 9, 10, 3, "어려운 문제를 끝까지 풀어내는 해결사. 복잡한 오류 찾기에 좋지만 느리고 비쌈"),
    ("claude", "claude-fable", 3, 7, 9, 3, "복잡한 구조를 따져 보는 분석가. 설계 검토에 좋고 단순한 일엔 과함"),
    ("gemini", "gemini-3.8-flash", 3, 6, 4, 5, "작은 수정은 정확하지만 느린 편. 간단한 화면·값 고치기에 적당"),
    ("gemini", "gemini-4-hydrogen", 2, 7, 5, 5, "범위가 분명한 문서·자료 고치기에 믿음직하지만 속도는 느린 편"),
    ("gemini", "gemini-4-argon", 5, 6, 7, 5, "창작에 강함. 그림·아이디어 만들기와 결과물 검토에 좋고 설명이 장황함"),
    ("gpt", "gpt-6-luna", 9, 7, 4, 9, "가볍고 빠른 조수. 합치기·형식 맞추기·점검에 좋고 판단은 맡기지 말 것"),
    ("gpt", "gpt-6.1-terra", 8, 8, 6, 8, "글쓰기·문장 다듬기가 강점이고 깔끔하고 가성비 좋음. 큰 설계엔 아쉬움"),
    ("gpt", "gpt-6.1-sol", 6, 7, 7, 6, "그림 만들기와 조사·정리에 강함. 모호한 부탁은 단순하게 풀고 설명이 긺"),
    ("gpt", "gpt-6-astra", 4, 6, 7, 4, "손이 많이 가는 대량 제작·긴 점검에 좋음. 가볍게 쓰기엔 부담"),
]


def wrap(draw, text, fnt, maxw):
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=fnt) > maxw and cur:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def main():
    rows = sorted(M, key=lambda m: -sum(m[2:6]))
    PAD = 60
    ROW = 84
    top = 290
    H = top + len(rows) * ROW + 130
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((PAD, 36), "AI 모델 한눈에 보기", font=font(58, True), fill=TEXT)
    d.text((PAD, 112), "점수 순위와 한 줄 성격  ·  총점 = 네 항목의 합(40점 만점), 높은 순  ·  작성일 2026-11-18", font=font(28), fill=DIM)
    d.line((PAD, 164, W - PAD, 164), fill=LINE, width=2)

    # 범례
    lx = PAD
    for name, desc, c in ITEMS:
        d.rounded_rectangle((lx, 188, lx + 28, 216), radius=6, fill=c)
        d.text((lx + 40, 184), name, font=font(28, True), fill=TEXT)
        nw = d.textlength(name, font=font(28, True))
        d.text((lx + 40 + nw + 10, 190), f"{desc} (10점)", font=font(22), fill=DIM)
        lx += 40 + nw + 10 + d.textlength(f"{desc} (10점)", font=font(22)) + 50

    NAME_X = PAD + 70
    BAR_X = 470
    UNIT = 20  # 1점 = 20px, 40점 = 800px
    SUM_X = BAR_X + 40 * UNIT + 100
    # 축 눈금
    for v in (0, 10, 20, 30, 40):
        x = BAR_X + v * UNIT
        d.line((x, top - 6, x, top + len(rows) * ROW - 8), fill=LINE, width=1)
        d.text((x, top - 34), str(v), font=font(18), fill=DIM, anchor="mt")
    d.text((SUM_X, top - 34), "한 줄 성격", font=font(20, True), fill=DIM)

    for i, (prov, name, *sc, summ) in enumerate(rows):
        y = top + i * ROW
        if i % 2 == 0:
            d.rectangle((PAD - 20, y - 4, W - PAD + 20, y + ROW - 8), fill=PANEL)
        cy = y + (ROW - 12) // 2
        d.text((PAD, cy), str(i + 1), font=font(32, True), fill=DIM, anchor="lm")
        c = COL[prov]
        d.ellipse((NAME_X, cy - 9, NAME_X + 18, cy + 9), fill=c)
        d.text((NAME_X + 30, cy), name, font=font(26, True), fill=TEXT, anchor="lm")
        x = BAR_X
        for v, (_, _, ic) in zip(sc, ITEMS):
            w = v * UNIT
            d.rectangle((x, cy - 17, x + w - 2, cy + 17), fill=ic)
            d.text((x + w / 2 - 1, cy), str(v), font=font(20, True), fill=BG, anchor="mm")
            x += w
        d.text((x + 14, cy), str(sum(sc)), font=font(32, True), fill=c, anchor="lm")
        ls = wrap(d, summ, font(24), W - PAD - SUM_X)
        assert len(ls) <= 2, (name, ls)
        ty = cy - 14 * len(ls)
        for j, l in enumerate(ls):
            d.text((SUM_X, ty + j * 30), l, font=font(24), fill=TEXT)

    yb = top + len(rows) * ROW + 10
    d.line((PAD, yb, W - PAD, yb), fill=LINE, width=2)
    d.text((PAD, yb + 24), "점수는 실제 작업 관찰을 바탕으로 한 주관 평가", font=font(26), fill=TEXT)
    px = W - PAD
    for prov, label in reversed([("claude", "Claude"), ("gemini", "Gemini"), ("gpt", "GPT")]):
        tw = d.textlength(label, font=font(22))
        d.text((px, yb + 30), label, font=font(22), fill=DIM, anchor="ra")
        d.ellipse((px - tw - 28, yb + 33, px - tw - 10, yb + 51), fill=COL[prov])
        px -= tw + 60

    img.save(OUT, optimize=True)
    print(f"saved {OUT} {img.size} {os.path.getsize(OUT) / 1024:.0f}KB")


if __name__ == "__main__":
    main()
