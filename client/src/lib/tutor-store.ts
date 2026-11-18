import { create } from "zustand";

/** Server message payloads (see router.py / bot.py / tts_bilingual.py / translator.py). */
export interface Word {
  id: string;
  ja: string;
  reading: string;
  en: string;
  pos: string;
  stems: string[];
}

export type Mode = "conversation" | "help";
export type WordStatus = "idle" | "tentative" | "correct" | "wrong";

/** One learner turn as routed by the decision model. */
export interface Route {
  text: string; // Japanese STT
  en_text: string; // English STT
  llm_text: string; // transcript the tutor got
  spoke: "japanese" | "english" | null;
  prev: Mode;
  mode: Mode;
  choice: Mode | null;
  probabilities: Record<string, number>;
  language_probabilities: Record<string, number>;
  error: string | null;
}

export interface VocabResult {
  word_id: string;
  verdict: "correct" | "wrong_form" | "mentioned_only" | "absent";
  confidence: number;
}

/** One ja/en TTS chunk, bracketed by tts_run start/end markers. Times are performance.now(). */
export interface KaraokeRun {
  sentence: string;
  text: string;
  lang: "ja" | "en";
  start: number;
  dur: number;
  end?: number;
}

export interface Summary {
  practiced: Record<string, string>;
  attempts: Record<string, string[]>;
}

export const PATIENCE = [
  { name: "Snappy", eot_threshold: 0.7, eot_timeout_ms: 3000 },
  { name: "Relaxed", eot_threshold: 0.75, eot_timeout_ms: 4500 },
  { name: "Patient", eot_threshold: 0.8, eot_timeout_ms: 6000 },
  { name: "Very patient", eot_threshold: 0.85, eot_timeout_ms: 9000 },
  { name: "Take your time", eot_threshold: 0.9, eot_timeout_ms: 14000 },
] as const;

const CHARS_PER_SEC = { ja: 7, en: 14 } as const;
const MAX_TURNS = 20;

/** Whitespace-free key; matches translator.key() on the server. */
export const normalize = (s: string) => s.replace(/\s+/g, "").trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerMessage = { type: string } & Record<string, any>;

interface TutorState {
  words: Word[];
  wordState: Record<string, { status: WordStatus; note?: string }>;
  mode: Mode;
  turns: Route[]; // newest first
  routes: Record<string, Route>; // by normalized Japanese STT text, for matching messages
  vocabByText: Record<string, VocabResult[]>;
  translations: Record<string, string>;
  enLive: string;
  runs: KaraokeRun[];
  assistantModes: Record<string, Mode>; // assistant message createdAt -> mode
  lastError: string | null;
  summary: Summary | null;
  patience: number; // index into PATIENCE

  reset: () => void;
  handleServerMessage: (m: ServerMessage) => void;
  clearRuns: () => void;
  noteAssistantMessage: (createdAt: string) => void;
  setPatience: (i: number) => void;
  setSummary: (s: Summary | null) => void;
}

const initial = {
  words: [],
  wordState: {},
  mode: "conversation" as Mode,
  turns: [],
  routes: {},
  vocabByText: {},
  translations: {},
  enLive: "",
  runs: [],
  assistantModes: {},
  lastError: null,
  summary: null,
};

export const useTutor = create<TutorState>()((set, get) => {
  const setWord = (id: string, status: WordStatus, note?: string) =>
    set((s) => {
      if (s.wordState[id]?.status === "correct") return s;
      return { wordState: { ...s.wordState, [id]: { status, note } } };
    });

  return {
    ...initial,
    patience: 2,

    reset: () => set({ ...initial }),
    clearRuns: () => set({ runs: [] }),
    noteAssistantMessage: (createdAt) =>
      set((s) => ({ assistantModes: { ...s.assistantModes, [createdAt]: s.mode } })),
    setPatience: (patience) => set({ patience }),
    setSummary: (summary) => set({ summary }),

    handleServerMessage: (m) => {
      switch (m.type) {
        case "session":
          set({ words: m.words });
          break;
        case "state":
        case "mode":
          set({ mode: m.mode });
          break;
        case "route": {
          const r = m as unknown as Route;
          if (r.error) {
            set({ lastError: `Decision failed, stayed in ${r.mode}` });
            break;
          }
          set((s) => ({
            routes: { ...s.routes, [normalize(r.text)]: r },
            turns: [r, ...s.turns].slice(0, MAX_TURNS),
            enLive: "",
            lastError: null,
          }));
          break;
        }
        case "en_live":
          set({ enLive: m.text });
          break;
        case "translation":
          set((s) => ({ translations: { ...s.translations, [m.key]: m.en } }));
          break;
        case "vocab_tentative":
          setWord(m.word_id, "tentative");
          break;
        case "vocab_decision": {
          const results = m.results as VocabResult[];
          for (const r of results) {
            if (r.verdict === "correct") setWord(r.word_id, "correct");
            else if (r.verdict === "wrong_form") setWord(r.word_id, "wrong", "wrong form");
            else if (get().wordState[r.word_id]?.status === "tentative")
              setWord(
                r.word_id,
                r.verdict === "mentioned_only" ? "wrong" : "idle",
                r.verdict === "mentioned_only" ? "only mentioned" : undefined,
              );
          }
          set((s) => ({ vocabByText: { ...s.vocabByText, [normalize(m.text)]: results } }));
          break;
        }
        case "decision_error":
          set({ lastError: m.error });
          break;
        case "summary":
          set({ summary: { practiced: m.practiced, attempts: m.attempts } });
          break;
        case "tts_run": {
          const now = performance.now();
          if (m.state === "start") {
            const lang = m.lang as "ja" | "en";
            const dur = m.duration_ms ?? Math.round((1000 * [...m.text].length) / CHARS_PER_SEC[lang]);
            set((s) => ({ runs: [...s.runs, { sentence: m.sentence, text: m.text, lang, start: now, dur }] }));
          } else {
            set((s) => {
              const runs = [...s.runs];
              for (let i = runs.length - 1; i >= 0; i--) {
                if (!runs[i].end && runs[i].text === m.text) {
                  runs[i] = { ...runs[i], end: now };
                  break;
                }
              }
              return { runs };
            });
          }
          break;
        }
      }
    },
  };
});
