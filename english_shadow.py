"""English shadow STT: a second Flux stream (flux-general-en) on the same mic audio.

Runs in a ParallelPipeline branch next to the Japanese stream. It never drives turns;
EnglishCollector keeps its transcripts, swallows its output frames, and sends live text
to the UI as `en_live` messages. The router reads "what an English-only recognizer heard"
at the Japanese end of turn.
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    ServiceMetadataFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# Frames the English STT emits; letting them through would double transcripts and turns
_SWALLOW = (
    TranscriptionFrame,
    InterimTranscriptionFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    ServiceMetadataFrame,
)


class EnglishCollector(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._finals: list[tuple[float, str]] = []  # (time, text) of English EndOfTurn transcripts
        self._partial = ""  # current English turn so far
        self._open = False  # English stream is mid-utterance
        # Set when the router took the text of an utterance the English stream hasn't finished;
        # its late updates/final belong to the consumed turn and are dropped
        self._stale = False
        # Set by bot.py: sends live English text to the UI
        self.on_text: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, ProposedUserStartedSpeakingFrame):
            # New English utterance: anything from now on is fresh
            self._open, self._stale, self._partial = True, False, ""
        elif isinstance(frame, TranscriptionFrame):
            self._open = False
            if self._stale:
                self._stale = False
            elif frame.text.strip():
                self._finals.append((time.time(), frame.text.strip()))
            self._partial = ""
        elif isinstance(frame, InterimTranscriptionFrame) and not self._stale:
            self._partial = frame.text.strip()
            await self._emit()
        if isinstance(frame, _SWALLOW):
            return
        await self.push_frame(frame, direction)

    async def _emit(self):
        if self.on_text:
            text = " ".join([t for _, t in self._finals] + ([self._partial] if self._partial else []))
            await self.on_text({"type": "en_live", "text": text})

    def take_since(self, start: float) -> str:
        """English text heard since `start` (finals + in-progress partial); consumes it."""
        texts = [t for ts, t in self._finals if ts >= start]
        self._finals = []
        if self._partial:
            texts.append(self._partial)
            self._partial = ""
        self._stale = self._open
        return " ".join(texts)
