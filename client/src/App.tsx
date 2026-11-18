import { PipecatClient } from "@pipecat-ai/client-js";
import { PipecatClientProvider, usePipecatClient } from "@pipecat-ai/client-react";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { useCallback, useEffect, useRef, useState } from "react";

import { BotAudioOutput, unlockBotAudio } from "@/components/pipecat/bot-audio";
import { MicButton, ModeSwitch, SessionButton, StatusPill } from "@/components/tutor/header-controls";
import { DecisionPanel, PatiencePanel, WordBank } from "@/components/tutor/side-panels";
import { SummaryDialog } from "@/components/tutor/summary-dialog";
import { TutorConversation } from "@/components/tutor/tutor-conversation";
import { TutorEvents } from "@/components/tutor/tutor-events";
import { PATIENCE, useTutor } from "@/lib/tutor-store";

export default function App() {
  const [client] = useState(
    () => new PipecatClient({ transport: new SmallWebRTCTransport(), enableMic: true, enableCam: false }),
  );
  return (
    <PipecatClientProvider client={client}>
      <BotAudioOutput />
      <TutorEvents />
      <Tutor />
      <SummaryDialog />
    </PipecatClientProvider>
  );
}

function useSession() {
  const client = usePipecatClient();

  const start = useCallback(async () => {
    if (!client) return;
    unlockBotAudio();
    useTutor.getState().reset();
    const p = PATIENCE[useTutor.getState().patience];
    try {
      await client.connect({
        webrtcRequestParams: {
          endpoint: "/api/offer",
          requestData: { eot_threshold: p.eot_threshold, eot_timeout_ms: p.eot_timeout_ms },
        },
      });
    } catch (e) {
      console.error("connect failed", e);
    }
  }, [client]);

  const end = useCallback(async () => {
    if (!client) return;
    // Ask for the session summary before hanging up
    client.sendClientMessage("summary", {});
    await new Promise((r) => setTimeout(r, 400));
    await client.disconnect();
  }, [client]);

  return { start, end };
}

function Tutor() {
  const { start, end } = useSession();

  // Auto-start on load (guarded against StrictMode's double effect)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="bg-secondary-background border-border flex flex-wrap items-center gap-3 border-b-2 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-base border-border bg-main shadow-shadow ja grid size-10 place-items-center border-2 text-xl font-extrabold">
            会
          </div>
          <div className="leading-tight">
            <div className="text-lg font-extrabold">Kaiwa</div>
            <div className="text-muted-foreground text-xs">Japanese conversation tutor</div>
          </div>
        </div>
        <StatusPill />
        <div className="flex-1" />
        <ModeSwitch />
        <MicButton />
        <SessionButton onStart={start} onEnd={end} />
      </header>

      <main className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="rounded-base border-border bg-secondary-background shadow-shadow flex min-h-[420px] flex-col overflow-hidden border-2">
          <div className="min-h-0 flex-1">
            <TutorConversation />
          </div>
          <HowItWorks />
        </section>
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1 pb-1">
          <DecisionPanel />
          <WordBank />
          <PatiencePanel />
        </aside>
      </main>
    </div>
  );
}

/** One-line legend so a non-Japanese-speaking audience can follow along. */
function HowItWorks() {
  const steps = [
    ["Speak Japanese", "to practice"],
    ["Ask in English", "for help"],
    ["Say “I'm back”", "to return"],
    ["Use a target word", "to check it off"],
  ];
  return (
    <div className="border-border bg-background flex flex-wrap gap-x-5 gap-y-1 border-t-2 px-4 py-2.5 text-xs">
      {steps.map(([a, b]) => (
        <span key={a}>
          <b>{a}</b> {b}
        </span>
      ))}
    </div>
  );
}
