import { normalize, useTutor, type KaraokeRun } from "@/lib/tutor-store";

/**
 * Approximate karaoke for one bot sentence. Flux TTS gives no word timings, so the
 * server brackets each ja/en chunk with tts_run start/end markers sent in step with
 * the audio. The chunk being spoken fills in char by char over its duration; finished
 * chunks fade their highlight out. Negative animation delays keep the timing anchored
 * to the marker, so re-renders don't restart animations.
 *
 * Without markers (e.g. an old sentence), falls back to Pipecat's spoken/unspoken split.
 */
export function KaraokeText({ content, spoken }: { content: string; spoken: string }) {
  const key = normalize(content);
  const runs = useTutor((s) => s.runs).filter((r) => normalize(r.sentence) === key);

  if (runs.length === 0) {
    return (
      <span>
        {spoken}
        <span className="text-muted-foreground">{content.slice(spoken.length)}</span>
      </span>
    );
  }

  const now = performance.now();
  const sentenceDone = spoken.length >= content.length;
  const out: React.ReactNode[] = [];
  let cursor = 0;

  runs.forEach((run, ri) => {
    const i = content.indexOf(run.text, cursor);
    if (i < 0) return;
    // Gap text (punctuation/spaces between runs) counts as said once this run started
    if (i > cursor) out.push(<span key={`g${ri}`}>{content.slice(cursor, i)}</span>);
    out.push(<RunText key={`r${ri}`} run={run} now={now} />);
    cursor = i + run.text.length;
  });

  if (cursor < content.length) {
    const rest = content.slice(cursor);
    out.push(
      <span key="rest" className={sentenceDone ? undefined : "text-muted-foreground"}>
        {rest}
      </span>,
    );
  }
  return <span>{out}</span>;
}

function RunText({ run, now }: { run: KaraokeRun; now: number }) {
  if (run.end !== undefined) {
    return (
      <span className="karaoke-fade" style={{ animationDelay: `${Math.round(run.end - now)}ms` }}>
        {run.text}
      </span>
    );
  }
  const chars = [...run.text];
  const step = run.dur / Math.max(1, chars.length);
  return (
    <>
      {chars.map((c, i) => (
        <span
          key={i}
          className="karaoke-fill"
          style={{ animationDelay: `${Math.round(run.start + i * step - now)}ms` }}
        >
          {c}
        </span>
      ))}
    </>
  );
}
