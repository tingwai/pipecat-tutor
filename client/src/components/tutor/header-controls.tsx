import { RTVIEvent } from "@pipecat-ai/client-js";
import {
  usePipecatClientMicControl,
  usePipecatClientTransportState,
  useRTVIClientEvent,
} from "@pipecat-ai/client-react";
import { MicIcon, MicOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const useLive = () => {
  const t = usePipecatClientTransportState();
  return t === "ready" || t === "connected";
};

/** Who's talking, plus "still thinking" when the learner pauses mid-turn. */
export function StatusPill() {
  const transport = usePipecatClientTransportState();
  const live = useLive();
  const { isMicEnabled } = usePipecatClientMicControl();
  const [userInTurn, setUserInTurn] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [botThinking, setBotThinking] = useState(false);
  const lastInterim = useRef({ text: "", at: 0 });
  const [, tick] = useState(0);

  useRTVIClientEvent(
    RTVIEvent.UserStartedSpeaking,
    useCallback(() => {
      setUserInTurn(true);
      lastInterim.current = { text: "", at: Date.now() };
    }, []),
  );
  useRTVIClientEvent(RTVIEvent.UserStoppedSpeaking, useCallback(() => setUserInTurn(false), []));
  useRTVIClientEvent(
    RTVIEvent.UserTranscript,
    useCallback((d: { text: string; final: boolean }) => {
      if (!d.final && d.text !== lastInterim.current.text) lastInterim.current = { text: d.text, at: Date.now() };
    }, []),
  );
  useRTVIClientEvent(RTVIEvent.BotLlmStarted, useCallback(() => setBotThinking(true), []));
  useRTVIClientEvent(RTVIEvent.BotLlmStopped, useCallback(() => setBotThinking(false), []));
  useRTVIClientEvent(RTVIEvent.BotStartedSpeaking, useCallback(() => setBotSpeaking(true), []));
  useRTVIClientEvent(RTVIEvent.BotStoppedSpeaking, useCallback(() => setBotSpeaking(false), []));

  // Re-check "still thinking" (no new words for ~1s) while the learner holds the turn
  useEffect(() => {
    if (!userInTurn) return;
    const i = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(i);
  }, [userInTurn]);

  let text = "Offline";
  let color = "bg-secondary-background";
  let pulse = false;
  if (transport === "connecting" || transport === "authenticating") [text, pulse] = ["Connecting…", true];
  else if (live) {
    if (!isMicEnabled && !botSpeaking) [text, color] = ["Mic muted", "bg-destructive"];
    else if (botSpeaking) [text, color, pulse] = ["Tutor speaking", "bg-success", true];
    else if (botThinking) [text, color, pulse] = ["Tutor thinking…", "bg-success", true];
    else if (userInTurn && Date.now() - lastInterim.current.at > 900)
      [text, color, pulse] = ["Still thinking…", "bg-warning", true];
    else if (userInTurn) [text, color, pulse] = ["Hearing you", "bg-practice", true];
    else [text, color] = ["Your turn", "bg-secondary-background"];
  }

  return (
    <div className={cn("rounded-base border-border flex w-40 items-center gap-2 border-2 px-3 py-1.5 text-sm font-bold", color)}>
      <span className={cn("size-2.5 rounded-full border-2 border-border bg-foreground", pulse && "animate-pulse")} />
      {text}
    </div>
  );
}

/** Mic toggle; M toggles it too (outside text fields). */
export function MicButton() {
  const live = useLive();
  const { enableMic, isMicEnabled } = usePipecatClientMicControl();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      enableMic(!isMicEnabled);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableMic, isMicEnabled]);

  return (
    <Button
      variant="neutral"
      disabled={!live}
      onClick={() => enableMic(!isMicEnabled)}
      className={cn("w-32", live && !isMicEnabled && "bg-destructive")}
      title="Toggle mic (M)"
    >
      {/* Mic is off before connecting; only show the muted state during a session */}
      {!live || isMicEnabled ? <MicIcon /> : <MicOffIcon />}
      {!live || isMicEnabled ? "Mute" : "Unmute"}
      <kbd className="rounded-sm border-border border px-1 text-[10px]">M</kbd>
    </Button>
  );
}

export function SessionButton({ onStart, onEnd }: { onStart: () => void; onEnd: () => void }) {
  const transport = usePipecatClientTransportState();
  const live = useLive();
  const busy = transport === "connecting" || transport === "authenticating" || transport === "disconnecting";
  const toggle = live ? onEnd : onStart;

  // S starts/ends the session (outside text fields)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyS" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || busy) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, busy]);

  return (
    <Button
      onClick={toggle}
      disabled={busy}
      className={cn("w-32", live && "bg-secondary-background")}
      title="Start / end (S)"
    >
      {busy ? "…" : live ? "End" : "Start"}
      <kbd className="rounded-sm border-border border px-1 text-[10px]">S</kbd>
    </Button>
  );
}
