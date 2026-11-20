---
title: Windows 한글 경로 함정: subst로 ASCII 드라이브 매핑(mediapipe 등)·OpenCV cv2.imwrite가 조용히 실패·cv2.imread가 None(imencode·imdecode로 우회)
summary: 경로에 한글이 있어 mediapipe 같은 C++ 라이브러리가 파일을 못 열거나 리다이렉트 출력이 안 생기거나, cv2.imwrite가 예외 없이 False만 반환하고 파일을 안 만들거나 cv2.imread가 None을 돌려줄 때 어떻게 우회하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
경로에 한글이 있으면 C++ 쪽이 파일을 못 여는 라이브러리가 있다. 예: mediapipe 0.10.14 `FaceMesh()`가 `The path does not exist: ...face_landmark_front_cpu.binarypb`로 죽는다(파일은 있다). 한글 경로에서는 cmd 리다이렉트 출력 파일이 안 생기기도 하고, OpenCV `cv2.imwrite`는 예외 없이 False만 반환하며 `cv2.imread`는 None을 돌려준다.
네이티브 라이브러리는 `subst`로 한글 폴더를 ASCII 드라이브 문자에 매핑해 그 경로로 실행하고, OpenCV 읽기·쓰기는 파이썬 파일 입출력 + 메모리 인코딩으로 바꾸거나 ASCII 경로로 복사해서 다룬다.

## 언제 쓰나
- worktree·프로젝트 경로에 한글이 있어 네이티브 라이브러리가 경로 오류를 낼 때
- `cv2.imwrite`가 False를 돌려주고 파일이 안 생길 때(예: `.worktrees/새-안건-2-5/...`)
- `cv2.imread`가 한글 경로 그림에서 None을 돌려줄 때(이미지 편집·정렬 스크립트)

## 방법
### subst로 ASCII 드라이브 매핑
- PowerShell에서 `subst W: '<한글 경로>'`(Git Bash/cmd는 한글 인자가 깨진다) → `W:\.venv\Scripts\python.exe W:\…`로 실행 → 끝나면 PowerShell에서 `subst W: /d`(Git Bash에선 `/d`가 경로로 바뀐다).
- PowerShell에서도 `Invalid parameter - W:`로 실패하면(ANSI 코드페이지로 깨짐) 8.3 짧은 경로로 매핑한다:
  `$short=(New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath; subst W: $short`
  `subst` 목록 표시가 깨져 보여도 매핑은 정상이다.
- 파이썬 자동화: `subprocess.run(['subst','Z:',ROOT])`로 매핑하고 경로 접두를 치환, finally에서 해제.
- 리다이렉트도 매핑 경로로: `> W:\...\x.out 2>&1`(Git Bash에선 `/w/...`).
- venv·pip는 한글 경로에서도 된다(worktree 안, gitignore): `py -3.10 -m venv .venv` → `pip install mediapipe==0.10.14 "numpy<2" opencv-python-headless scipy soundfile`.

### OpenCV imwrite·imread: 메모리 인코딩으로
- 쓰기: `open(path, 'wb').write(cv2.imencode('.png', img)[1].tobytes())`
- 읽기: `cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)` (`cv2.imread`가 한글 경로에서 None을 주는 것도 확인됨)
- 더 간단히: 편집할 그림을 `.council/w/` 같은 ASCII 경로로 복사한 뒤 읽고 쓴다.
- `cv2.VideoCapture`로 mp4를 읽는 것은 됐다.
- 영상 쓰기는 ffmpeg에 rawvideo로 파이프하면 경로 문제가 없다: `-f rawvideo -pix_fmt bgr24 -s WxH -r 24 -i -`.
- cv2가 있는 python: ComfyUI 포터블의 `python_embeded/python.exe`, 또는 cv2를 설치한 프로젝트 venv의 python.exe. 시스템 `python`은 WindowsApps 스텁.
- 한글을 print하는 스크립트는 `PYTHONIOENCODING=utf-8`(cp949 UnicodeEncodeError 방지, [Windows Python 한글](common/windows/windows-python-korean-encoding)).

## 주의할 점
- imwrite의 반환값, imread 결과가 None인지 확인하지 않으면 실패를 모른다. 쓴 뒤 파일 존재를 확인한다.
- 쓰고 있는 드라이브 문자나 다른 위원이 쓰는 문자는 지우지 않는다.
- mediapipe 입 벌림 측정 예: 랜드마크 13·14 간격 ÷ 10·152 간격, 입 시작은 직전 정지 프레임(NaN 포함) ≥3 조건.
- 웹 Gemini 첨부용 한글 경로 그림은 %TEMP% 아래 ASCII 폴더에 복사한다.
