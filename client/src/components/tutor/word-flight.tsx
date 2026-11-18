import { useEffect, useRef } from "react";

import { useTutor } from "@/lib/tutor-store";

const DURATION_MS = 1100;
const ARC_HEIGHT = 140; // px above the higher of the two points
const STEPS = 24;

/**
 * When a word is newly used, a chip pops out of the learner's sentence and flies
 * along an arc into its word-bank tile, which turns green on landing.
 *
 * Source: the latest [data-word-mark=id] highlight in a user bubble.
 * Target: the [data-word-tile=id] tile. Missing either (or reduced motion) → land at once.
 */
export function WordFlight() {
  const flying = useTutor((s) => s.flying);
  const land = useTutor((s) => s.land);
  const layer = useRef<HTMLDivElement>(null);
  const launched = useRef(new Set<string>());

  useEffect(() => {
    for (const id of flying) {
      if (launched.current.has(id)) continue;
      launched.current.add(id);
      // Next frame: the bubble's highlight for this word has rendered by then
      requestAnimationFrame(() => launch(id, layer.current, () => land(id)));
    }
    for (const id of [...launched.current]) if (!flying.includes(id)) launched.current.delete(id);
  }, [flying, land]);

  return <div ref={layer} className="pointer-events-none fixed inset-0 z-50" />;
}

function launch(id: string, layer: HTMLDivElement | null, done: () => void) {
  const marks = document.querySelectorAll<HTMLElement>(`[data-word-mark="${id}"]`);
  const src = marks[marks.length - 1];
  const tile = document.querySelector<HTMLElement>(`[data-word-tile="${id}"]`);
  const word = useTutor.getState().words.find((w) => w.id === id);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!layer || !src || !tile || !word || reduced) return done();

  const chip = document.createElement("div");
  chip.className =
    "ja fixed top-0 left-0 rounded-base border-2 border-border bg-success px-2.5 py-1 text-lg font-extrabold shadow-shadow whitespace-nowrap";
  chip.textContent = word.ja;
  layer.appendChild(chip);

  const a = src.getBoundingClientRect();
  const b = tile.getBoundingClientRect();
  const { width: cw, height: ch } = chip.getBoundingClientRect();
  const s = { x: a.left + a.width / 2 - cw / 2, y: a.top + a.height / 2 - ch / 2 };
  const e = { x: b.left + b.width / 2 - cw / 2, y: b.top + b.height / 2 - ch / 2 };
  const c = { x: (s.x + e.x) / 2, y: Math.min(s.y, e.y) - ARC_HEIGHT }; // bezier control point

  // Pop out of the sentence (0 → 0.2), then a quadratic-bezier arc into the tile
  const at = (x: number, y: number, scale: number, rot = 0) =>
    `translate(${x}px, ${y}px) scale(${scale}) rotate(${rot}deg)`;
  const frames: Keyframe[] = [
    { offset: 0, transform: at(s.x, s.y, 0.4), opacity: 0 },
    { offset: 0.12, transform: at(s.x, s.y - 18, 1.25, -6), opacity: 1 },
    { offset: 0.2, transform: at(s.x, s.y - 10, 1.1, -4), opacity: 1 },
  ];
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    const x = u * u * s.x + 2 * u * t * c.x + t * t * e.x;
    const y = u * u * (s.y - 10) + 2 * u * t * c.y + t * t * e.y;
    frames.push({
      offset: 0.2 + 0.8 * t,
      transform: at(x, y, 1.1 - 0.25 * t, -4 + 8 * t),
      opacity: 1,
      easing: "linear",
    });
  }

  const anim = chip.animate(frames, { duration: DURATION_MS, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" });
  anim.onfinish = () => {
    chip.remove();
    done();
  };
}
