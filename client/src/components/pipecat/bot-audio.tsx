"use client";

import { RTVIEvent } from "@pipecat-ai/client-js";
import {
  usePipecatClientMediaTrack,
  useRTVIClientEvent,
} from "@pipecat-ai/client-react";
import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";


function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function clampVolume(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

interface BotAudioState {
  /** Current bot audio output volume, 0.0 – 1.0. */
  volume: number;
  /** Set the bot audio output volume. Values are clamped to [0, 1]. */
  setVolume: (volume: number) => void;
}

/**
 * Module-level store for bot audio output volume. Drives the <audio>
 * element rendered by BotAudioOutput; read/written by the volume controls,
 * so any number of control instances stay in sync without prop drilling.
 */
export const useBotAudio = create<BotAudioState>()((set) => ({
  volume: 1,
  setVolume: (volume) => set({ volume: clampVolume(volume) }),
}));

// The mounted output element, so unlockBotAudio can reach it from a gesture
// handler without a ref or context.
let outputElement: HTMLAudioElement | null = null;

/**
 * Call synchronously inside the user's gesture (the Connect tap) so iOS
 * Safari treats later playback of the bot track as user-activated. Calls
 * play() on the mounted output element: with no source attached yet it makes
 * no sound, and once the bot track is attached a repeated play() is a no-op,
 * so overlapping calls are harmless. No-op when BotAudioOutput is not
 * mounted. The call may stay pending until a source is attached (Chromium)
 * or reject (no gesture); both are ignored.
 */
export function unlockBotAudio(): void {
  void outputElement?.play().catch(() => undefined);
}

/** Mount once inside PipecatClientProvider, in place of PipecatClientAudio, to use shared volume controls. */
export function BotAudioOutput() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const botAudioTrack = usePipecatClientMediaTrack("audio", "bot");
  const volume = useBotAudio((s) => s.volume);

  // Attach the bot's audio track, de-duping on track id so we don't tear
  // down an already-playing stream.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!botAudioTrack) {
      el.srcObject = null;
      return;
    }
    const existing = el.srcObject as MediaStream | null;
    if (existing) {
      const oldTrack = existing.getAudioTracks()[0];
      if (oldTrack && oldTrack.id === botAudioTrack.id) return;
    }
    el.srcObject = new MediaStream([botAudioTrack]);
    // autoPlay is enough once unlockBotAudio() ran inside the user's tap.
    // This play() is a diagnostic: without the unlock, iOS Safari refuses
    // autoPlay silently, and the logged rejection makes that visible.
    // AbortError means the track was swapped or removed while play() was
    // pending, not a real failure.
    void el.play().catch((err: unknown) => {
      if (isAbortError(err)) return;
      console.warn("BotAudioOutput: play() rejected", err);
    });
  }, [botAudioTrack]);

  useEffect(() => {
    const el = audioRef.current;
    outputElement = el;
    return () => {
      if (outputElement === el) outputElement = null;
      if (el) el.srcObject = null;
    };
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume;
  }, [volume]);

  // setSinkId can reject (unsupported deviceId, permission denied) —
  // swallow and log so speaker-routing failures stay non-fatal.
  useRTVIClientEvent(
    RTVIEvent.SpeakerUpdated,
    useCallback((speaker: MediaDeviceInfo) => {
      const el = audioRef.current;
      if (!el || typeof el.setSinkId !== "function") return;
      el.setSinkId(speaker.deviceId).catch((err: unknown) => {
        console.warn("BotAudioOutput: setSinkId failed", err);
      });
    }, []),
  );

  return <audio ref={audioRef} autoPlay />;
}
