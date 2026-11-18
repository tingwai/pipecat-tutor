# Kaiwa

A bilingual Japanese conversation tutor. Voice demo built with [Pipecat](https://github.com/pipecat-ai/pipecat) and Deepgram Flux (STT + TTS).

Practice Japanese out loud, switch to English whenever you need help, and watch target words check off as you use them.

## What it shows

- **Flux STT turn detection** with adjustable patience (`eot_threshold` / `eot_timeout_ms`, updated mid-stream)
- **Two Flux STT streams in parallel**: Japanese and English, so mixed-language speech is always transcribed by the right model
- **Flux TTS with per-language voices** in a single reply (Japanese voice for Japanese, English voice for English)
- **Karaoke-style highlighting** from TTS chunk markers synced to the audio
- **Decision routing** with Pipecat's `OpenAIDecisionsClassifier`: which language was spoken, practice vs. help, and whether a target word was really used

## Demo flow

1. Press **Start** (`S`). The tutor asks: こんにちは！ 今日、何を食べましたか？
2. Answer in Japanese. Used words fly into the word bank and turn green.
3. Ask something in English ("How do you say rice?"). The tutor switches to English help.
4. Say "I'm back" or answer in Japanese to continue the conversation.

English subtitles appear under every Japanese line. `M` mutes the mic.

## Architecture

```
mic ─► ParallelPipeline ┬─ Flux STT (flux-general-multi, ja hint) ── owns turns
                        └─ Flux STT (flux-general-en) ─► EnglishCollector
    ─► ModeRouter (Decisions API: language → mode; word checks)
    ─► LLM ─► BilingualFluxTTS (ja/en runs) ─► speaker
```

| Piece | File |
|---|---|
| Pipeline, transport, RTVI events | `bot.py` |
| Mode routing, prompt/TTS settings frames | `router.py`, `intent.py` |
| English shadow stream | `english_shadow.py` |
| Per-language Flux TTS + karaoke markers | `tts_bilingual.py` |
| Word bank + usage judge | `vocab.py` |
| Subtitles | `translator.py` |
| React client (Pipecat client SDK + Pipecat UI conversation, neobrutalism.dev components) | `client/` |

## Deepgram notes

- **STT:** a `ja` hint keeps accented Japanese in Japanese but garbles English, and `ja`+`en` does the reverse. Running a second `flux-general-en` stream and letting the classifier pick the intelligible transcript avoids the trade-off.
- **TTS:** Flux TTS can't change voice on an open WebSocket, so replies are split into ja/en runs and sent to REST `/v2/speak`, fetched concurrently and played in order. Flux TTS has no word timings; karaoke is estimated per chunk.

## Run it

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
cp .env.example .env          # add DEEPGRAM_API_KEY and OPENAI_API_KEY
uv sync
(cd client && npm install && npm run build)
uv run python server.py       # http://localhost:7860
```

For UI development, keep `server.py` running and use `cd client && npm run dev` (Vite proxies `/api`).

Optional env: `JA_VOICE` (default `flux-ayumi-ja`), `HELP_VOICE` (`flux-hannah-en`), `LLM_MODEL` (`gpt-6.2-sol`).

## Notes

- Headphones recommended, so the tutor's voice doesn't reach the mic.
- Local only (SmallWebRTC, no auth); not set up for deployment.
