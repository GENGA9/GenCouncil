"""모델 성향 한 장 요약 스코어카드 PNG 생성기.

실행: python docs/diagrams/make_model_scorecard.py
출력: docs/diagrams/model_scorecard.png (2400px 폭, 정적 PNG 1장)

내용 출처: Gen Wiki models/ 11쪽(작성 시점 2026-11-18). 종합평점은 관찰
(완주율·평균 tool call·약점 기록·관찰 건수)을 근거로 한 의장용 주관 평점이다.
관찰이 적은 모델은 "관찰 적음"으로 표시한다. 폰트·기법은 make_council_gif.py를 따른다.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

W = 2400
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
GOOD = (110, 214, 140)
BAD = (240, 120, 120)
USE = (130, 190, 250)
GRAY_STAR = (62, 67, 82)
COL = {"claude": (240, 138, 60), "gemini": (84, 148, 245), "gpt": (72, 190, 110)}
PNAME = {"claude": "Claude (Anthropic)", "gemini": "Gemini (Google · Antigravity)", "gpt": "GPT (OpenAI · Codex)"}

# (provider, 모델명, 등급, 평점, 관찰 표기, 장점[], 단점[], 용도[], 근거)
M = [
    ("claude", "claude-haiku", "하위", 4.0, "관찰 153건",
     ["단계·금지가 명시된 좁은 기계 작업을 4~12 tool call에 정확히",
      "배포·삭제·git config·파일 교체·push"],
     ["진단·원인 분석·품질 평가는 안 함", "줄 끝(CRLF/LF) 변경이 섞임"],
     ["파일·행·내용을 지정한 기계적 수정, 배포, 시스템 점검"],
     "관찰 153건 · 완주 97% · 평균 13 call · 가장 싸고 확실 (일 범위가 좁아 4.0)"),
    ("claude", "claude-sonnet", "주력", 4.0, "관찰 1029건",
     ["측정·설치·선례 확장·일괄 생성·다이어그램 GIF을 안정적으로",
      "숫자 근거를 대고, 지어내지 않고 멈춤"],
     ["자기 검증 부족, 캡처를 대체물로 갈음", "지시 적힌 파일만 다루고 줄 끝을 통째로 바꿈"],
     ["범위·절차가 분명한 기능 확장·측정·문서·일괄 생성 (의심 결과는 opus 검증)"],
     "관찰 1029건 · 평균 59 call · 검증 약점은 감점"),
    ("claude", "claude-opus", "최상위", 4.5, "관찰 229건",
     ["원인 모를 버그·큰 merge·긴 파이프라인을 한 번에 완주", "다른 위원이 실패한 작업 재진단"],
     ["작업이 길다(평균 126 call, 1~1.5h+)", "지시를 글자 그대로 지켜 목적을 놓치거나 범위를 넓힘"],
     ["어려운 디버깅·통합·구조 리팩터·밸런스·재진단"],
     "관찰 229건 · 평균 126 call로 가장 김 · 길고 비쌈은 감점"),
    ("claude", "claude-fable", "최상위", 3.5, "관찰 적음",
     ["얽힌 설계에서 되는지·왜 안 되는지 숫자로 증명", "처음부터 짜는 코드 설계(three.js 프리비즈)"],
     ["목표 미달 '불가능 증명+선택지'로 끝날 수 있음", "동작 지시를 크게 해석"],
     ["구조적으로 가능한지 먼저 알아야 하는 설계·분석"],
     "관찰 적음 · 확정 평점 아님, 잠정"),
    ("gemini", "gemini-3.8-flash", "하위", 2.5, "건수 미상",
     ["한 파일 리팩터·좁은 CSS·값 수정 정확", "개발일지 집계·캐릭터 시트가 빠름"],
     ["작은 일에도 call이 많아 느림(medium 121, high 450)", "회귀·줄 끝 섞임, 컷 판정은 거의 다 찬성"],
     ["작은 코드·UI 소품, argon 한도 소진 때 대체"],
     "medium 평균 121 call · high 450 call · 회귀 사례"),
    ("gemini", "gemini-4-hydrogen", "주력", 3.0, "관찰 22건",
     ["범위 정해진 문서·데이터 수정, 대사 구절 측정을 완성",
      "정정 우선순위·재생성 순서를 지시대로 수행"],
     ["JSON 한 항목 추가에 전체 재직렬화로 diff 커짐", "high 평균 167 call로 느림"],
     ["범위·보존 대상이 명확한 문서·데이터 수정, 좁은 측정"],
     "관찰 22건 · high 평균 167 call · 성향 아직 단정 안 함"),
    ("gemini", "gemini-4-argon", "최상위", 3.5, "6/21건 실패",
     ["창작 데이터·그림(사용자가 GPT보다 선호)에 강함", "키프레임 독립 검수, BGM 큐 설계·VO 배치"],
     ["큰 그림 3~4번에 한도 소진(리셋 약 60~68h)", "유명 IP 이름 섞임, 보고가 장황"],
     ["창작 데이터·그림, 타 모델 키프레임 검수, 리서치·표"],
     "21건 중 6건 실패(대부분 한도) · 리셋 60~68h · 한도 소진 감점"),
    ("gpt", "gpt-6-luna", "하위", 3.5, "관찰 10건",
     ["문서 병합·충돌 해결, 재인코딩, tsc·테스트 통합 검증", "평균 14 call로 GPT 중 가장 쌈"],
     ["판단·원인 분석·설계는 맡기지 않음", "10건 모두 좁은 일 → 일반화 어려움"],
     ["지정 줄 수정, 병합, 통합 검증, 한도 거의 찼을 때 마지막 단계"],
     "관찰 10건 · 모두 좁은 일 · 평균 14 call"),
    ("gpt", "gpt-6.1-terra", "주력", 4.0, "관찰 30건",
     ["범위 정해진 UI·자막 스타일 수정을 안정적으로", "교차 코드 리뷰에서 경계 버그를 실제로 찾음"],
     ["RESULT.md 누락, 새 파일에 BOM·CRLF", "새 발화 경계를 글자 수 비례로 추정"],
     ["범위 정해진 UI 수정, 자막 스타일, 교차 코드 리뷰"],
     "관찰 30건 · 완주 90% · 평균 24 call · 싸고 깔끔"),
    ("gpt", "gpt-6.1-sol", "주력", 4.0, "관찰 248건",
     ["그림 생성·연결, 재현 기반 조사, 끊긴 작업 인수", "대량 파일 이동·원본 보존 증명·수치 QC"],
     ["모호하면 가장 단순하게 해석, 그림이 GPT스럽다는 거절", "RESULT.md가 길고 방어적"],
     ["이미지 생성·연결, 계약 기반 병렬 연결, Claude 한도 찰 때 대체"],
     "관찰 248건 · 평균 45 call · 해석·보고 약점은 감점"),
    ("gpt", "gpt-6-astra", "최상위", 3.5, "6/17건 인계·실패",
     ["픽셀아트 800프레임 대량 생산, 390행 진단표", "긴 게임 QA·에뮬레이터 검증"],
     ["한도 소진으로 17건 중 6건 인계·실패", "주간 사용량 50%+ 필요"],
     ["긴 생산·측정·QA (중간 커밋·STATE.md 필수)"],
     "17건 중 6건 인계·실패(주로 한도)"),
]


PAD = 60
GAP = 24
COLS = 4
CW = (W - 2 * PAD - (COLS - 1) * GAP) // COLS
IN = 22  # 카드 안쪽 여백
FS = 20  # 본문 글자 크기
LH = 28
LINES = {"good": 4, "bad": 4, "use": 3, "basis": 2}  # 칸별 고정 줄 수


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


def bullets(draw, items, fnt, maxw, bullet="• "):
    out = []
    bw = draw.textlength(bullet, font=fnt)
    for it in items:
        ls = wrap(draw, it, fnt, maxw - bw)
        for i, l in enumerate(ls):
            out.append((bullet if i == 0 else "", l))
    return out


def star_poly(cx, cy, r):
    import math
    pts = []
    for k in range(10):
        a = -math.pi / 2 + k * math.pi / 5
        rr = r if k % 2 == 0 else r * 0.42
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def draw_stars(img, x, y, score, color, r=17, step=40):
    d = ImageDraw.Draw(img)
    for i in range(5):
        cx, cy = x + r + i * step, y + r
        d.polygon(star_poly(cx, cy, r), fill=GRAY_STAR)
        fill = max(0.0, min(1.0, score - i))
        if fill > 0:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ImageDraw.Draw(layer).polygon(star_poly(cx, cy, r), fill=color + (255,))
            mask = Image.new("L", img.size, 0)
            ImageDraw.Draw(mask).rectangle((cx - r - 1, cy - r - 1, cx - r + 2 * r * fill, cy + r + 1), fill=255)
            img.paste(layer, (0, 0), Image.composite(layer.split()[3], Image.new("L", img.size, 0), mask))


def section_h():
    return {k: v * LH for k, v in LINES.items()}


def card_height():
    sh = section_h()
    # 헤더 + 라벨(4) + 본문 + 간격
    return 120 + (34 + sh["good"] + 10) + (34 + sh["bad"] + 10) + (34 + sh["use"] + 10) + (sh["basis"] + 16 + 6)


def main():
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    fb = font(FS)
    inner = CW - 2 * IN
    CH = card_height()

    top = 190
    row_head = 56
    rows = ["claude", "gemini", "gpt"]
    H = top + len(rows) * (row_head + CH + 30) + 150
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 제목
    d.text((PAD, 40), "GenCouncil 위원 모델 성향 스코어카드", font=font(54, True), fill=TEXT)
    d.text((PAD, 112), "작성일 2026-11-18  ·  출처: Gen Wiki models/ (11개 모델)  ·  의장이 위원을 고를 때 한눈에 보는 요약",
           font=font(26), fill=DIM)
    d.line((PAD, 164, W - PAD, 164), fill=LINE, width=2)

    y = top
    for prov in rows:
        c = COL[prov]
        d.rectangle((PAD, y + 6, PAD + 12, y + row_head - 6), fill=c)
        d.text((PAD + 28, y + 2), PNAME[prov], font=font(34, True), fill=c)
        y += row_head
        models = [m for m in M if m[0] == prov]
        for i, (_, name, tier, score, obs, good, bad, use, basis) in enumerate(models):
            x = PAD + i * (CW + GAP)
            d.rounded_rectangle((x, y, x + CW, y + CH), radius=16, fill=PANEL, outline=c, width=2)
            d.rounded_rectangle((x, y, x + CW, y + 8), radius=4, fill=c)
            # 헤더
            d.text((x + IN, y + 20), name, font=font(30, True), fill=TEXT)
            tw = d.textlength(tier, font=font(20, True))
            d.rounded_rectangle((x + CW - IN - tw - 22, y + 24, x + CW - IN, y + 56), radius=14, fill=c)
            d.text((x + CW - IN - tw - 11, y + 27), tier, font=font(20, True), fill=BG)
            draw_stars(img, x + IN, y + 70, score, c)
            d.text((x + IN + 5 * 40 + 6, y + 66), f"{score:.1f}", font=font(30, True), fill=c)
            d.text((x + IN + 5 * 40 + 70, y + 76), obs, font=font(18), fill=DIM)
            cy = y + 120
            sh = section_h()
            for label, lc, items, key in (("장점", GOOD, good, "good"), ("단점·주의", BAD, bad, "bad"),
                                          ("추천 용도", USE, use, "use")):
                d.text((x + IN, cy), label, font=font(20, True), fill=lc)
                d.line((x + IN + 90, cy + 15, x + CW - IN, cy + 15), fill=LINE, width=1)
                cy += 34
                bl = bullets(probe, items, fb, inner)
                assert len(bl) <= LINES[key], f"{name} {label} {len(bl)}줄 > {LINES[key]}: {items}"
                for j, (b, l) in enumerate(bl):
                    d.text((x + IN, cy + j * LH), b + l if b else "   " + l, font=fb, fill=TEXT)
                cy += sh[key] + 10
            d.line((x + IN, cy, x + CW - IN, cy), fill=LINE, width=1)
            cy += 6
            bs = wrap(probe, basis, font(17), inner)
            assert len(bs) <= LINES["basis"], f"{name} 근거 {len(bs)}줄: {basis}"
            for j, l in enumerate(bs):
                d.text((x + IN, cy + j * LH), l, font=font(17), fill=DIM)
        if prov == "gemini":  # 빈 4번째 칸: 범례
            x = PAD + 3 * (CW + GAP)
            d.rounded_rectangle((x, y, x + CW, y + CH), radius=16, outline=LINE, width=2)
            d.text((x + IN, y + 22), "읽는 법", font=font(28, True), fill=TEXT)
            notes = ["★ 5점 만점 (0.5 단위). 숫자 옆은 관찰 건수(의장 집계)",
                     "등급 칩: 하위 / 주력 / 최상위 (모델 사다리)",
                     "\"관찰 적음\"은 건수 미상·소수 → 확정 성향 아님, 잠정 평점",
                     "Gemini는 한도가 따로(argon 소진 시 flash로 이어감)"]
            yy = y + 74
            for n in notes:
                ls = wrap(probe, n, fb, inner - 20)
                for k, l in enumerate(ls):
                    d.text((x + IN, yy), ("• " if k == 0 else "   ") + l, font=fb, fill=DIM)
                    yy += LH
                yy += 8
        y += CH + 30

    d.line((PAD, y + 10, W - PAD, y + 10), fill=LINE, width=2)
    d.text((PAD, y + 28),
           "종합평점 기준: 관찰의 완주율·평균 tool call(비용 대비 효율)·약점 기록·신뢰도를 종합한 의장용 주관 평점 (5점 만점). 관찰이 적으면 잠정.",
           font=font(24), fill=TEXT)
    d.text((PAD, y + 68), "성향은 Gen Wiki, 관찰 수치는 의장 집계다. 작업 종류에 따라 순위는 달라질 수 있다.",
           font=font(22), fill=DIM)

    img = img.crop((0, 0, W, y + 120))
    img.save(OUT, optimize=True)
    print(f"saved {OUT} {img.size} {os.path.getsize(OUT) / 1024:.0f}KB")


if __name__ == "__main__":
    main()
