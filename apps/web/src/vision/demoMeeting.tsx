import { useCallback, useRef, useState } from "react";
import { t } from "../i18n";
import { d } from "./demoText";
import { MeetingView } from "../components/MeetingView";
import type { Look, Mode } from "../components/ModeSwitch";
import type { Meeting, MeetingSettings, MeetingTurn, ModelsInfo, UsageSnapshot } from "../types";

const DEMO_MODELS: ModelsInfo = {
  providers: [
    { id: "claude", models: [{ id: "haiku", label: "Haiku", note: "" }, { id: "sonnet", label: "Sonnet", note: "" }, { id: "opus", label: "Opus", note: "" }], effort: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt", models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", note: "" }, { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", note: "" }], effort: true, efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gemini", models: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "" }, { id: "gemini-4-neon", label: "Gemini 4 Neon", note: "" }], effort: true, efforts: ["low", "medium", "high"] },
  ],
  sites: [],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaults: {} as ModelsInfo["defaults"],
};

/** the meeting room on the demo page (?meeting): a made-up meeting played out on timers */
const SCRIPT: Array<Omit<MeetingTurn, "at">> = [
  { who: "gpt", name: "지피티", model: "gpt-6.2-sol", phase: "opinion", round: 1, text: d("결론부터 말씀드리면 금요일 배포는 피하는 것이 맞습니다. 장애가 나면 주말 내내 대응할 사람이 없습니다. 목요일 오전 배포와 금요일 동결을 제안합니다.") },
  { who: "gemini", name: "제미나이", model: "gemini-4-neon", phase: "opinion", round: 1, text: d("와 지피 선배 단호하다! 근데 저는 반대예요~ 배포를 겁내면 오히려 배포가 커져서 더 위험해져요. 작게 자주 내보내고 자동 롤백만 확실하면 금요일도 괜찮다고 봐요!") },
  { who: "claude", name: "클로드", model: "sonnet", phase: "opinion", round: 1, text: d("저는 두 분 사이 어딘가예요. 배포는 작게 자주 하되, 금요일 오후만큼은 쉬어 가면 어떨까요? 사람이 지치지 않는 것도 안전의 일부라고 생각해요.") },
  { who: "gpt", name: "지피티", model: "gpt-6.2-sol", phase: "debate", round: 1, text: d("제미나이 의견의 전제는 자동 롤백입니다. 현재 롤백 자동화는 결제 경로에만 있습니다. 전 구간에 갖춰질 때까지는 금요일 동결이 안전합니다.") },
  { who: "gemini", name: "제미나이", model: "gemini-4-neon", phase: "debate", round: 1, text: d("인정! 그럼 롤백 자동화 범위를 넓히는 걸 이번 달 목표로 하고, 그전까지만 금요일 동결 어때요 선배?") },
  {
    who: "chair",
    name: "클로드",
    model: "sonnet",
    phase: "summary",
    round: 1,
    text: d("[합의한 점]\n작은 배포를 자주 하는 방향 자체에는 두 분 모두 찬성했어요.\n롤백 자동화가 안전의 전제라는 점도 같은 생각이에요.\n[의견이 갈린 점]\n자동화가 갖춰지기 전 금요일 배포를 허용할지에서 갈렸어요.\n[결론과 다음 할 일]\n롤백 자동화가 전 구간에 갖춰질 때까지 금요일은 배포 동결로 해요.\n이번 달 안에 롤백 자동화 범위를 넓히는 일을 안건으로 올릴게요."),
  },
];

export function DemoMeeting({ look, usage, onMode, note }: { look: Look; usage: UsageSnapshot; onMode: (m: Mode) => void; note: (m: string) => void }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [settings, setSettings] = useState<MeetingSettings>({ chair: "claude", members: ["claude", "gpt", "gemini", "grok"] });
  const timers = useRef<number[]>([]);
  const start = useCallback(async (topic: string) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const m: Meeting = {
      id: `demo-${Date.now()}`,
      topic,
      chair: { seat: "claude", name: "클로드", provider: "claude", model: "sonnet" },
      seats: [
        { seat: "claude", name: "클로드", available: true, desk: true },
        { seat: "gpt", name: "지피티", available: true },
        { seat: "gemini", name: "제미나이", available: true },
        { seat: "grok", name: "그록", available: false, reason: "연결 안 됨" },
      ],
      turns: [],
      phase: "opinion",
      speaking: "gpt",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    setMeeting(m);
    const step = Number(new URLSearchParams(location.search).get("step") ?? 3.2) * 1000;
    SCRIPT.forEach((t, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setMeeting((cur) => {
            if (!cur || cur.id !== m.id || cur.status !== "running") return cur;
            const turns = [...cur.turns, { ...t, at: new Date().toISOString() }];
            const next = SCRIPT[i + 1];
            return { ...cur, turns, phase: next ? next.phase : "done", speaking: next?.who, status: next ? "running" : "done", ...(next ? {} : { endedAt: new Date().toISOString() }) };
          });
        }, step * (i + 1)),
      );
    });
  }, []);
  const stop = useCallback(async (id: string) => {
    timers.current.forEach(clearTimeout);
    setMeeting((cur) => (cur && cur.id === id ? { ...cur, status: "stopped", phase: "done", speaking: undefined } : cur));
  }, []);
  // the meetings held on this page, for the past list
  const held = useRef<Meeting[]>([]);
  if (meeting && !held.current.some((m) => m.id === meeting.id)) held.current = [meeting, ...held.current];
  held.current = held.current.map((m) => (meeting && m.id === meeting.id ? meeting : m));
  return (
    <MeetingView
      look={look}
      meeting={meeting}
      settings={settings}
      onSettings={async (p) => setSettings((c) => ({ ...c, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? undefined])) }) as MeetingSettings)}
      loadModels={async () => DEMO_MODELS}
      past={{
        list: async () => held.current.map((m) => ({ id: m.id, topic: m.topic, startedAt: m.startedAt, status: m.status, chair: m.chair.name, turns: m.turns.length })),
        open: async (id) => held.current.find((m) => m.id === id)!,
        remove: async (id) => {
          held.current = held.current.filter((m) => m.id !== id);
          setMeeting((cur) => (cur && cur.id === id ? null : cur));
        },
      }}
      usage={usage}
      onStart={start}
      onStop={stop}
      onMode={onMode}
      onWorkshop={() => note(t("작업실로 이동 (데모)"))}
      notify={note}
    />
  );
}
