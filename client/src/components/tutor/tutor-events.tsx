import { RTVIEvent } from "@pipecat-ai/client-js";
import { useConversationContext, usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import { useCallback, useRef } from "react";

import { useTutor, type ServerMessage } from "@/lib/tutor-store";

const SWITCH_LINE = {
  help: "Switched to English help",
  conversation: "Back to Japanese practice",
} as const;

/** Feeds RTVI events into the tutor store and requests subtitles. Renders nothing. */
export function TutorEvents() {
  const client = usePipecatClient();
  const handleServerMessage = useTutor((s) => s.handleServerMessage);
  const clearRuns = useTutor((s) => s.clearRuns);
  const { injectMessage } = useConversationContext();
  const reply = useRef({ text: "", mode: "conversation" });

  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (data: unknown) => {
        const m = data as ServerMessage;
        handleServerMessage(m);
        if (m.type === "mode") {
          injectMessage({
            role: "system",
            parts: [
              {
                text: SWITCH_LINE[m.mode as keyof typeof SWITCH_LINE],
                final: true,
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
      },
      [handleServerMessage, injectMessage],
    ),
  );

  // Collect each tutor reply; once complete, ask the server for an English subtitle
  useRTVIClientEvent(
    RTVIEvent.BotLlmStarted,
    useCallback(() => {
      clearRuns(); // new reply, fresh karaoke runs
      reply.current = { text: "", mode: useTutor.getState().mode };
    }, [clearRuns]),
  );
  useRTVIClientEvent(
    RTVIEvent.BotLlmText,
    useCallback((d: { text: string }) => {
      reply.current.text += d.text;
    }, []),
  );
  useRTVIClientEvent(
    RTVIEvent.BotLlmStopped,
    useCallback(() => {
      const { text, mode } = reply.current;
      // Help replies are already in English
      if (text.trim() && mode === "conversation") client?.sendClientMessage("translate", { text });
    }, [client]),
  );

  return null;
}
