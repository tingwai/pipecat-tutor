# N5 Voice Tutor

Japanese conversation tutor with live word-bank checking and English help.

## Run

```bash
uv sync
uv run python server.py   # http://localhost:7860
```

Needs `DEEPGRAM_API_KEY` and `OPENAI_API_KEY` in `.env`. Use headphones or browser echo cancellation.

## Stack

| Piece | Choice |
|---|---|
| Transport | Pipecat SmallWebRTC |
| STT + turn detection | Two Deepgram Flux streams on the same mic: `flux-general-multi` (hint `ja`) owns turns; `flux-general-en` runs alongside for English |
| LLM | OpenAI `gpt-4.1` (`LLM_MODEL`) |
| TTS | Deepgram Flux TTS REST, per-language runs: `flux-sayaka-ja` (`JA_VOICE`) for Japanese, `flux-hannah-en` (`HELP_VOICE`) for English |
| Word judge | OpenAI Decisions API, `gpt-6-luna` |

## Pipeline

```
mic -> [Flux ja | Flux en -> EnglishCollector] -> ModeRouter -> user ctx -> LLM -> Flux TTS -> speaker -> assistant ctx
```

- `router.py` + `intent.py`: two modes, `CONVERSATION` and `HELP`
  - At each Japanese end of turn, both transcripts go to the Decisions API (`gpt-6-luna`, ~150-300 ms) before the LLM. It returns `conversation` or `help` with probabilities, which show in the debug panel.
  - The LLM gets the transcript that matches the mode: Japanese for conversation, English for help.
  - Help: English questions, "what does X mean", "is this correct", or speaking English to the tutor.
  - Conversation: Japanese answers, or "I'm back" / "resume" / "let's continue". A Japanese answer during help also resumes.
  - On a mode change: swap the system prompt, and add a resume note with the last tutor question and partial answer.
- `english_shadow.py`: `EnglishCollector` keeps the English stream's text and swallows its frames, so it never drives turns. Its transcripts stay out of the UI via `RTVIObserverParams(ignored_sources=...)`.
- `vocab.py`: N5 word pool, stem matcher (live tentative highlight), Decisions judge
  - Only learner turns in `CONVERSATION` are judged; tutor speech is never transcribed.
  - Per word: `correct` (affirmative, any politeness), `wrong_form` (negated or wrong meaning), `mentioned_only` (asked about or quoted), `absent`
- Patience slider sends `STTUpdateSettingsFrame`, which updates Flux `eot_threshold` / `eot_timeout_ms` mid-stream.

## Demo script

1. Answer the tutor in Japanese and watch the word chips light up.
2. Ask "How do you say restaurant in Japanese?" to get English help.
3. Say "Okay, I'm back", or answer in Japanese. The conversation resumes.
4. Click Stop to see the summary.
