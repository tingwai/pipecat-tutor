import { usePipecatClient } from "@pipecat-ai/client-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { PATIENCE, useTutor, type Route } from "@/lib/tutor-store";
import { cn } from "@/lib/utils";

const pct = (p?: number) => (p === undefined ? "" : `${Math.round(p * 100)}%`);

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card size="sm" className="bg-secondary-background">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

/* ---------------- decision model ---------------- */

/** A two-option decision: the chosen option is a filled block, the other is faded. */
function Choice({
  question,
  options,
  chosen,
  probs,
}: {
  question: string;
  options: { key: string; label: string; color: string }[];
  chosen: string | null;
  probs: Record<string, number | undefined>;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-bold">{question}</div>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => {
          const on = o.key === chosen;
          return (
            <div
              key={o.key}
              className={cn(
                "rounded-base border-border flex items-center justify-between border-2 px-2.5 py-1.5 text-sm font-bold",
                on ? cn(o.color, "shadow-shadow") : "text-muted-foreground border-dashed opacity-60",
              )}
            >
              <span>
                {on && "✓ "}
                {o.label}
              </span>
              <span className="text-xs tabular-nums">{pct(probs[o.key])}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const LANGUAGE_OPTIONS = [
  { key: "japanese", label: "Japanese", color: "bg-practice" },
  { key: "english", label: "English", color: "bg-help" },
];
const MODE_OPTIONS = [
  { key: "conversation", label: "Practice", color: "bg-practice" },
  { key: "help", label: "Help", color: "bg-help" },
];

export function DecisionPanel() {
  const turns = useTutor((s) => s.turns);
  const lastError = useTutor((s) => s.lastError);
  const latest = turns[0];

  return (
    <Panel title="Decision model" aside={<span className="text-muted-foreground text-xs">OpenAI Decisions API</span>}>
      {lastError && (
        <div className="rounded-base border-border bg-destructive border-2 px-2.5 py-1.5 text-xs font-bold">
          {lastError}
        </div>
      )}
      {!latest ? (
        <p className="text-muted-foreground text-sm">
          Every turn: which language did you speak, and is it practice or a request for help?
        </p>
      ) : (
        <LatestTurn route={latest} />
      )}
      {turns.length > 1 && (
        <div className="flex flex-col gap-1 border-t-2 border-dashed pt-2">
          <div className="text-muted-foreground text-[11px] font-bold uppercase">Earlier</div>
          {turns.slice(1, 5).map((r, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <MiniChip on={r.spoke === "english" ? "bg-help" : "bg-practice"}>
                {r.spoke === "english" ? "EN" : "JA"}
              </MiniChip>
              <span>→</span>
              <MiniChip on={r.mode === "help" ? "bg-help" : "bg-practice"}>{r.mode === "help" ? "Help" : "Practice"}</MiniChip>
              <span className={cn("text-muted-foreground truncate", r.spoke !== "english" && "ja")}>
                {r.llm_text || r.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MiniChip({ on, children }: { on: string; children: React.ReactNode }) {
  return <span className={cn("rounded-sm border-border shrink-0 border-2 px-1 text-[10px] font-bold", on)}>{children}</span>;
}

function LatestTurn({ route: r }: { route: Route }) {
  const switched = r.mode !== r.prev;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-base border-border bg-background border-2 px-3 py-2">
        <div className="text-muted-foreground text-[11px] font-bold uppercase">You said</div>
        <div className={cn("text-base font-semibold", r.spoke !== "english" && "ja")}>{r.llm_text || r.text}</div>
      </div>
      <Choice question="1 · Which language?" options={LANGUAGE_OPTIONS} chosen={r.spoke} probs={r.language_probabilities} />
      <Choice question="2 · Practice or help?" options={MODE_OPTIONS} chosen={r.choice} probs={r.probabilities} />
      {switched && (
        <div className="rounded-base border-border bg-warning border-2 px-2.5 py-1 text-xs font-bold">
          Switched to {r.mode === "help" ? "English help" : "Japanese practice"}
        </div>
      )}
    </div>
  );
}

/* ---------------- word bank ---------------- */

export function WordBank() {
  const words = useTutor((s) => s.words);
  const wordState = useTutor((s) => s.wordState);
  const flying = useTutor((s) => s.flying);
  const landed = useTutor((s) => s.landed);
  // A word in flight only counts once it lands
  const done = words.filter((w) => wordState[w.id]?.status === "correct" && !flying.includes(w.id)).length;

  return (
    <Panel
      title="Word bank"
      aside={
        <span className="text-sm font-extrabold tabular-nums">
          {done}/{words.length}
        </span>
      }
    >
      <Progress value={words.length ? (100 * done) / words.length : 0} />
      {words.length === 0 ? (
        <p className="text-muted-foreground text-sm">Target words appear when the session starts.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {words.map((w) => {
            const raw = wordState[w.id]?.status ?? "idle";
            const st = flying.includes(w.id) ? "tentative" : raw;
            return (
              <div
                key={w.id}
                data-word-tile={w.id}
                className={cn(
                  "rounded-base border-border relative border-2 px-2.5 py-1.5 transition-colors",
                  landed.includes(w.id) && "animate-[tile-land_0.6s_ease-out]",
                  st === "correct" && "bg-success shadow-shadow",
                  st === "tentative" && "bg-warning",
                  st === "wrong" && "border-destructive border-dashed",
                )}
              >
                {st === "correct" && <span className="absolute top-1 right-2 text-sm font-extrabold">✓</span>}
                <div className="ja text-lg leading-tight font-extrabold">{w.ja}</div>
                <div className="text-xs font-semibold">{w.en}</div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/* ---------------- turn-taking ---------------- */

export function PatiencePanel() {
  const client = usePipecatClient();
  const patience = useTutor((s) => s.patience);
  const setPatience = useTutor((s) => s.setPatience);
  const first = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0]);

  return (
    <Panel title="Wait time" aside={<span className="text-sm font-bold">{PATIENCE[patience].name}</span>}>
      <Slider
        min={0}
        max={PATIENCE.length - 1}
        step={1}
        value={patience}
        onValueChange={(v) => setPatience(first(v))}
        onValueCommitted={(v) => {
          const n = PATIENCE[first(v)];
          client?.sendClientMessage("patience", { eot_threshold: n.eot_threshold, eot_timeout_ms: n.eot_timeout_ms });
        }}
      />
      <p className="text-muted-foreground text-xs">How long the tutor waits before answering when you pause to think.</p>
    </Panel>
  );
}
