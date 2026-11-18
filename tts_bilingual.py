"""Flux TTS that voices Japanese runs with a Japanese voice and English runs with an English voice.

Uses Flux's REST endpoint (POST /v2/speak) per run, so switching voice needs no reconnect.
Runs are fetched concurrently and played back in order.

Flux TTS returns no word timings, so each run is bracketed with `tts_run` start/end
messages for approximate karaoke in the UI. They are OutputTransportMessageFrames (not
system frames), so the output transport sends them in order with the audio, i.e. roughly
when that run starts and stops playing.
"""

import asyncio
import re
from collections.abc import AsyncGenerator

import aiohttp
from loguru import logger

from pipecat.frames.frames import ErrorFrame, Frame, OutputTransportMessageFrame
from pipecat.processors.frameworks.rtvi.models import ServerMessage
from pipecat.services.deepgram.tts import DeepgramHttpTTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.tracing.service_decorators import traced_tts

# Japanese script + Japanese punctuation/long vowel mark
_JA_CHARS = r"぀-ヿ㐀-鿿ｦ-ﾟ　-〿！-／：-？"
_RUNS = re.compile(rf"[{_JA_CHARS}]+|[^{_JA_CHARS}]+")
_HAS_JA = re.compile(r"[぀-ヿ㐀-鿿ｦ-ﾟ]")
_HAS_WORD = re.compile(r"[A-Za-z0-9]")


def split_runs(text: str) -> list[tuple[str, str]]:
    """Split into [(lang, text)] runs; punctuation-only runs merge into the previous run."""
    runs: list[tuple[str, str]] = []
    for m in _RUNS.finditer(text):
        chunk = m.group(0)
        if _HAS_JA.search(chunk):
            lang = "ja"
        elif _HAS_WORD.search(chunk):
            lang = "en"
        else:
            # Quotes, spaces, punctuation: glue to previous run (or drop if leading)
            if runs:
                runs[-1] = (runs[-1][0], runs[-1][1] + chunk)
            continue
        if runs and runs[-1][0] == lang:
            runs[-1] = (lang, runs[-1][1] + chunk)
        else:
            runs.append((lang, chunk))
    # Strip dangling quotes so TTS doesn't read them oddly
    out = []
    for lang, t in runs:
        t = t.strip(" \"'“”「」").lstrip(".,;:!?、。 ")
        if t:
            out.append((lang, t))
    return out


class BilingualFluxTTSService(DeepgramHttpTTSService):
    def __init__(self, *, api_key: str, ja_voice: str, en_voice: str, aiohttp_session: aiohttp.ClientSession, **kwargs):
        super().__init__(
            api_key=api_key,
            aiohttp_session=aiohttp_session,
            # language drives sentence splitting only (not sent to Deepgram); router flips it per mode
            settings=DeepgramHttpTTSService.Settings(voice=ja_voice, language=Language.JA),
            **kwargs,
        )
        self._ja_voice = ja_voice
        self._en_voice = en_voice

    async def _fetch(self, lang: str, chunk: str, queue: asyncio.Queue, sizes: list[int], i: int):
        """Stream one run's audio into queue; None marks the end. Tracks bytes in sizes[i]."""
        headers = {"Authorization": f"Token {self._api_key}", "Content-Type": "application/json"}
        params = {
            "model": self._ja_voice if lang == "ja" else self._en_voice,
            "encoding": self._encoding,
            "sample_rate": self.sample_rate,
            "container": "none",
        }
        try:
            async with self._session.post(
                f"{self._base_url}/v2/speak", headers=headers, json={"text": chunk}, params=params
            ) as response:
                if response.status != 200:
                    raise Exception(f"HTTP {response.status}: {await response.text()}")
                async for data in response.content.iter_chunked(self.chunk_size):
                    sizes[i] += len(data)
                    await queue.put(data)
        except Exception as e:
            await queue.put(e)
        finally:
            await queue.put(None)

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        runs = split_runs(text)
        if not runs:
            return
        if len(runs) > 1:
            logger.debug(f"{self}: bilingual runs {runs}")
        await self.start_ttfb_metrics()
        await self.start_tts_usage_metrics(text)
        # Fetch all runs concurrently, play back in order: no gap at language switches
        queues = [asyncio.Queue() for _ in runs]
        sizes = [0] * len(runs)
        tasks = [
            asyncio.create_task(self._fetch(l, c, q, sizes, i))
            for i, ((l, c), q) in enumerate(zip(runs, queues))
        ]
        try:
            for i, q in enumerate(queues):
                lang, chunk = runs[i]
                # Exact duration if this run already finished downloading; else the UI estimates
                duration_ms = int(sizes[i] / (2 * self.sample_rate) * 1000) if tasks[i].done() else None
                yield self._run_marker("start", text, lang, chunk, duration_ms)

                async def chunks(q=q):
                    while (item := await q.get()) is not None:
                        if isinstance(item, Exception):
                            raise item
                        yield item

                async for frame in self._stream_audio_frames_from_iterator(chunks(), context_id=context_id):
                    await self.stop_ttfb_metrics()
                    yield frame
                yield self._run_marker("end", text, lang, chunk, None)
        except Exception as e:
            yield ErrorFrame(f"Error getting audio: {e}")
        finally:
            for t in tasks:
                t.cancel()

    def _run_marker(
        self, state: str, sentence: str, lang: str, text: str, duration_ms: int | None
    ) -> Frame:
        # `sentence` is run_tts's input, matching the UI's BotOutput sentence part
        data = {
            "type": "tts_run",
            "state": state,
            "sentence": sentence,
            "lang": lang,
            "text": text,
            "duration_ms": duration_ms,
        }
        return OutputTransportMessageFrame(message=ServerMessage(data=data).model_dump(exclude_none=True))
