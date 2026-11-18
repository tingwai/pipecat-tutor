import type { BotOutputText, ConversationMessage } from "@pipecat-ai/client-react";
import { usePipecatConversation } from "@pipecat-ai/client-react";
import { useCallback, useMemo } from "react";

import { ConversationView } from "@/components/pipecat/conversation";
import { MessageContent, type BotOutputRenderer } from "@/components/pipecat/conversation-message";
import { KaraokeText } from "@/components/tutor/karaoke-text";
import { normalize, OPENING_LINE, useTutor, type Route, type Word } from "@/lib/tutor-store";
import { cn } from "@/lib/utils";

const botOutputRenderers: Record<string, BotOutputRenderer> = {
  sentence: (content, { spoken }) => <KaraokeText content={content} spoken={spoken} />,
};

function partText(text: unknown): string {
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && "spoken" in text) {
    const t = text as BotOutputText;
    return t.spoken + t.unspoken;
  }
  return "";
}

// createdAt must be a valid date: MessageContent formats it as a timestamp
const PREVIEW_AT = new Date(0).toISOString();
const OPENING_PREVIEW: ConversationMessage = {
  role: "assistant",
  final: true,
  createdAt: PREVIEW_AT,
  parts: [
    {
      text: { spoken: OPENING_LINE, unspoken: "" },
      final: true,
      createdAt: PREVIEW_AT,
      outputType: "sentence",
    },
  ],
};

const messageText = (m: ConversationMessage) => m.parts.map((p) => partText(p.text)).join("");

/** Pipecat UI conversation list (ConversationView + usePipecatConversation) with tutor rows. */
export function TutorConversation() {
  const noteAssistantMessage = useTutor((s) => s.noteAssistantMessage);

  const onMessageCreated = useCallback(
    (m: ConversationMessage) => {
      if (m.role === "assistant") noteAssistantMessage(m.createdAt);
    },
    [noteAssistantMessage],
  );
  const { messages } = usePipecatConversation({ onMessageCreated });

  const renderMessage = useCallback((m: ConversationMessage) => {
    if (m.role === "user") return <UserRow message={m} />;
    if (m.role === "assistant") return <TutorRow message={m} />;
    if (m.role === "system") return <SystemRow message={m} />;
    return undefined;
  }, []);

  // Before the session's first message, show the opening line; the live (spoken) one replaces it in place
  return (
    <ConversationView
      messages={messages.length ? messages : [OPENING_PREVIEW]}
      renderMessage={renderMessage}
      className="min-h-0"
    />
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 flex items-center gap-2 text-[11px] font-bold tracking-wide uppercase">{children}</div>;
}

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("rounded-base border-2 border-border px-1.5 py-px text-[10px] font-bold normal-case", className)}>
      {children}
    </span>
  );
}

function Subtitle({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div className="mt-2 border-t-2 border-dashed border-border/40 pt-2 text-sm leading-snug">
      <span className="mr-1.5 text-[10px] font-extrabold">EN</span>
      <span className="text-foreground/75">{text}</span>
    </div>
  );
}

function TutorRow({ message }: { message: ConversationMessage }) {
  const help = useTutor((s) => s.assistantModes[message.createdAt]) === "help";
  const translation = useTutor((s) => s.translations[normalize(messageText(message))]);
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "rounded-base border-border shadow-shadow max-w-[80%] border-2 px-4 py-3",
          help ? "bg-help/30" : "bg-secondary-background",
        )}
      >
        <Label>
          Tutor {help && <Chip className="bg-help">English help</Chip>}
        </Label>
        <MessageContent
          message={message}
          botOutputRenderers={botOutputRenderers}
          className="ja gap-0 text-lg leading-relaxed [&>div:last-child]:hidden"
        />
        {!help && <Subtitle text={translation} />}
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: ConversationMessage }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-base border-border bg-warning shadow-shadow border-2 px-3 py-1 text-xs font-bold">
        {messageText(message)}
      </span>
    </div>
  );
}

function UserRow({ message }: { message: ConversationMessage }) {
  const text = messageText(message);
  // Pipecat may merge back-to-back turns into one message; fall back to the last part
  const lastText = partText(message.parts.at(-1)?.text);
  const route = useTutor((s) => s.routes[normalize(text)] ?? s.routes[normalize(lastText)]) as Route | undefined;
  const enLive = useTutor((s) => s.enLive);
  const words = useTutor((s) => s.words);
  const wordState = useTutor((s) => s.wordState);
  const used = route ? route.llm_text || route.text : text;
  const translation = useTutor((s) => s.translations[normalize(used)]);
  // Pipecat marks user messages final ~3s after speech stops; the route arrives at end of turn
  const live = !route && !message.final;
  const english = route?.spoke === "english";
  const help = route?.mode === "help";

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "rounded-base border-border max-w-[80%] border-2 px-4 py-3",
          live ? "bg-secondary-background border-dashed" : "shadow-shadow",
          !live && (help ? "bg-help" : "bg-practice"),
        )}
      >
        <Label>
          You
          {route && <Chip className="bg-secondary-background">heard as {english ? "English" : "Japanese"}</Chip>}
          {live && <span className="text-muted-foreground normal-case">listening…</span>}
        </Label>
        <div className={cn("text-lg leading-relaxed", !english && "ja", live && "text-muted-foreground")}>
          <Highlighted text={used} words={words} wordState={wordState} />
        </div>
        {live && enLive && <div className="text-muted-foreground mt-1 text-xs">English guess: {enLive}</div>}
        {route && !english && <Subtitle text={translation} />}
      </div>
    </div>
  );
}

/** Marks stems of practiced words inside the learner's text. */
function Highlighted({
  text,
  words,
  wordState,
}: {
  text: string;
  words: Word[];
  wordState: Record<string, { status: string }>;
}) {
  // stem -> word id, so each highlight can be the launch point of its word's flight
  const stemToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of words) if (wordState[w.id]?.status === "correct") for (const s of w.stems) m.set(s, w.id);
    return m;
  }, [words, wordState]);
  const stems = [...stemToId.keys()];
  if (!stems.length) return <>{text}</>;
  const re = new RegExp(`(${stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return (
    <>
      {text.split(re).map((part, i) =>
        stemToId.has(part) ? (
          <mark
            key={i}
            data-word-mark={stemToId.get(part)}
            className="bg-success border-border rounded-sm border px-0.5 font-bold text-black"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
