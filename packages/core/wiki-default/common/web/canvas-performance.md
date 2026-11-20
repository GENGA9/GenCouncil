---
title: 캔버스 성능: willReadFrequently·A/B 측정·GPU 임시 화폭·반투명 사전 합성
summary: 캔버스 게임 fps가 낮을 때 willReadFrequently를 어떻게 점검하고 해상도 A/B를 어떻게 공정하게 재며, 임시 화폭을 GPU로 바꾸거나 반투명 겹침을 사전 합성할 때 화면이 같게 하려면 무엇을 지키나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
`getContext('2d', { willReadFrequently: true })`는 캔버스를 소프트웨어 백엔드로 보낸다. 프레임마다 그리는 큰 캔버스나 GPU 화폭에 옮겨 그리는 임시 화폭에 붙어 있으면 복사·텍스처 업로드가 메인 스레드를 포화시킨다.
힌트를 빼거나 임시 화폭을 대상과 같은 종류로 맞추되, GPU로 바꾸면 축소·변형 그리기 결과가 미세하게 달라지는 경우를 지킨다(Chrome/Electron, Chromium 152에서 확인). 해상도·캐시 같은 최적화를 잴 때는 이 힌트를 다른 요인과 분리한다.

## 언제 쓰나
- 캔버스 게임에서 입자·이펙트를 줄여도 fps가 안 오를 때
- 내부 화폭 해상도를 낮추거나 반투명 겹침을 미리 합성해 성능을 올릴 때
- 화면이 픽셀 단위로 같아야 하는 상태에서 캔버스 백엔드를 바꿀 때

## 방법
### fps가 낮으면 willReadFrequently부터
- 예: 오프스크린 캔버스를 화면 캔버스로 drawImage 한 번 복사하는 데 프레임의 70%(18.8ms)가 들었다 → 큰 캔버스의 willReadFrequently를 빼자 복사 1.6ms, 평균 28→55fps.
- 프레임마다 그리는 큰 캔버스에는 쓰지 않는다. getImageData가 필요한 곳은 별도 작은 캔버스로.

### 해상도 A/B는 힌트를 분리해 잰다
- 함정: 내부 화폭을 저해상도 canvas로 바꾸며 willReadFrequently:true를 빠뜨리면 밀도와 backend 힌트가 함께 바뀌어, FPS 개선을 해상도 효과로 오해한다.
- 밀도만 바꾸는 안은 `getContext('2d',{willReadFrequently})`와 `imageSmoothingEnabled`를 기준과 같게 맞추고, 같은 밀도에서 힌트만 바꾸는 안을 따로 둔다.
- `getContextAttributes()`로 실제 설정을 기록한다. 힌트 false를 GPU 사용의 증명으로 보지 않는다.
- 속성은 첫 getContext 때 정해지므로 안마다 새 canvas를 만든다.
- 논리 크기와 backing 픽셀 크기를 구분해 기록한다. 샘플링 프로파일·스택 수집은 A/B 프레임 측정과 별도로 실행한다.

### 임시 화폭을 대상과 같은 종류로
- 프레임마다 그리는 작은 임시 화폭이 소프트웨어(`willReadFrequently: true`)면 GPU 화폭에 그릴 때마다 텍스처를 다시 올린다 → 대상의 `ctx.getContextAttributes().willReadFrequently`와 같게 만든다(예: 25ms→6ms).
- 차이 1 — 축소: smoothing으로 0.5배 이하 축소 시 Chrome은 소프트웨어 원본만 반(올림) 크기 겹선형 밉맵으로 그린다 → GPU에서는 `ceil(w/2)×ceil(h/2)`로 먼저 줄여 그리면 같아진다. 0.25배 이하는 소프트웨어를 유지한다.
- 차이 2 — 변형: 임시 화폭에 늘리거나 돌려 담으면 결과가 달라진다 → 소프트웨어 유지. 1:1 복사·정수 이동·채우기만 같다.

### 반투명 겹침(오라 링 등) 사전 합성: 맥동 알파 보존
- 함정 1: 반투명 겹침을 한 화폭에 합친 뒤 `globalAlpha=pulse`를 곱하면 각 겹에 pulse를 곱한 결과와 다르다(source-over 알파 누적은 비선형).
- 함정 2: mutable scratch canvas 객체만 캐시 키로 쓰면 이전 그림이 섞인다.
- 원본+칸+변형으로 식별하고, 호출자 알파×효과 알파×pulse를 각 겹에 적용해 합성한 뒤 출력은 `globalAlpha=1`로 그린다.
- 프레임별 공유 Map과 크기·밀도별 backing pool로 같은 순간·원본·알파 호출을 공유한다. 재배정 시 dirty 표시, 같은 프레임의 used 슬롯은 재사용 금지, backing 픽셀×4 상한을 넘으면 기존 경로로 fallback.
- 비정수 밀도·별도 composite/filter는 원래 경로를 유지한다.
- 검증: 고정 clock으로 기존/캐시 경로를 같은 배경에 그려 비교한다(8비트 반올림·스케일링으로 픽셀 완전 일치는 아닐 수 있다). 최종 draw와 중간 합성 호출은 분리 계측한다.

## 주의할 점
- 요인을 하나씩 끄는 A/B를 정순·역순으로 재고, 다른 작업과 동시에 재지 않는다(값이 크게 흔들린다).
- 픽셀 비교 실험은 매번 원본 화폭을 새로 만든다(디코드 캐시가 차이를 숨긴다). 같은 상태로 후·전·후 3번 그려 비교한다.
