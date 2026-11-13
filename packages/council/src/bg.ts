/**
 * Long jobs a member starts (renders, training, bulk conversion) outlive the member's turn. They go
 * through bin/bg.mjs: a console window the user can see, output shown live and appended to a log
 * file, and the window kept open with the exit code when the job ends.
 */
import { fileURLToPath } from "node:url";

/** absolute path of the background job runner (forward slashes) */
export const BG_RUNNER = fileURLToPath(new URL("../bin/bg.mjs", import.meta.url)).replace(/\\/g, "/");

/** member/chair rule for long background jobs */
export function bgRule(): string {
  return (
    `오래 걸리는 작업(렌더, 학습, 대량 변환 등 내 실행이 끝난 뒤에도 계속돼야 하는 것)은 반드시 ` +
    `\`node "${BG_RUNNER}" --title "<안건·작업 이름>" --log <로그 파일> [--cwd <폴더>] -- <실행 파일 전체 경로> <인자...>\` 로 띄운다. ` +
    `사용자가 보는 콘솔 창에 출력이 그대로 찍히고 같은 내용이 로그 파일에 쌓이며, 끝나면 창 제목에 결과(끝남/실패 exit)가 남고 창은 닫히지 않는다. ` +
    `WMI·Start-Process·start·pythonw·nohup으로 직접 띄우거나 스크립트 안에서 출력을 파일로만 돌리지 않는다(사용자에게 빈 창만 보인다). ` +
    `스크립트는 진행 상황을 표준 출력에 찍는다. python은 \`python\` 대신 실행 파일 전체 경로를 쓴다(\`python\`은 Microsoft Store 바로가기로 잡힐 수 있다). ` +
    `띄운 뒤 출력되는 pid와 로그 경로를 RESULT.md에 적고, 확인할 때는 로그 파일을 읽는다(끝나면 맨 끝에 "=== … 끝남/실패: exit N" 줄이 있다).`
  );
}
