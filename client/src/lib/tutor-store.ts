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

export const PATIENCE = [
  { name: "Snappy", eot_threshold: 0.7, eot_timeout_ms: 3000 },
  { name: "Relaxed", eot_threshold: 0.75, eot_timeout_ms: 4500 },
  { name: "Patient", eot_threshold: 0.8, eot_timeout_ms: 6000 },
  { name: "Very patient", eot_threshold: 0.85, eot_timeout_ms: 9000 },
  { name: "Take your time", eot_threshold: 0.9, eot_timeout_ms: 14000 },
] as const;

/** Tutor's fixed first line (bot.py OPENING_LINE), shown before Start and spoken on Start. */
export const OPENING_LINE = "こんにちは！ 今日、何を食べましたか？";
export const OPENING_EN = "Hello! What did you eat today?";

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
  flying: string[]; // word ids animating from the learner's bubble to the word bank
  landed: string[]; // word ids that just landed (tile pop)
  patience: number; // index into PATIENCE

  reset: () => void;
  handleServerMessage: (m: ServerMessage) => void;
  clearRuns: () => void;
  land: (wordId: string) => void;
  noteAssistantMessage: (createdAt: string) => void;
  setPatience: (i: number) => void;
}

const initial = {
  words: [],
  wordState: {},
  mode: "conversation" as Mode,
  turns: [],
  routes: {},
  vocabByText: {},
  translations: { [OPENING_LINE.replace(/\s+/g, "")]: OPENING_EN } as Record<string, string>,
  enLive: "",
  runs: [],
  assistantModes: {},
  lastError: null,
  flying: [],
  landed: [],
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
    land: (id) => {
      set((s) => ({ flying: s.flying.filter((x) => x !== id), landed: [...s.landed, id] }));
      setTimeout(() => set((s) => ({ landed: s.landed.filter((x) => x !== id) })), 700);
    },
    noteAssistantMessage: (createdAt) =>
      set((s) => ({ assistantModes: { ...s.assistantModes, [createdAt]: s.mode } })),
    setPatience: (patience) => set({ patience }),

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
            if (r.verdict === "correct") {
              // Newly used words fly from the bubble into the word bank (see word-flight.tsx)
              if (get().wordState[r.word_id]?.status !== "correct")
                set((s) => ({ flying: [...s.flying, r.word_id] }));
              setWord(r.word_id, "correct");
            }
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
