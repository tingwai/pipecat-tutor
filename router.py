"""Mode router: CONVERSATION (Japanese practice) / HELP (English assistance).

Sits between STT and the user context aggregator. At each Japanese-stream end of
turn it pairs that transcript with the English shadow stream's, asks the Decisions
classifier (intent.py) for the mode, and forwards the transcript that matches the
mode to the LLM. On a mode change it sends settings frames: the LLM's
system_instruction and the TTS sentence-splitting language.
"""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Any

from loguru import logger

from pipecat.classifiers.base_classifier import BaseClassifier
from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    LLMMessagesAppendFrame,
    LLMUpdateSettingsFrame,
    MetricsFrame,
    ProposedUserStartedSpeakingFrame,
    TranscriptionFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor, FrameProcessorSetup
from pipecat.services.settings import LLMSettings, TTSSettings
from pipecat.transcriptions.language import Language

import prompts
from english_shadow import EnglishCollector
from translator import Translator, key
from intent import ModeJudge
from vocab import VocabJudge, Word, WordResult, local_hits


class Mode(StrEnum):
    CONVERSATION = "conversation"
    HELP = "help"


_JA = re.compile(r"[぀-ヿ㐀-鿿ｦ-ﾟ]")


def japanese_part(text: str) -> str:
    """Japanese portion of a mixed utterance (for partial answers)."""
    chunks = re.findall(r"[぀-ヿ㐀-鿿ｦ-ﾟ、。…ー〜！？\s]+", text)
    return "".join(chunks).strip(" 、。…")


Notify = Callable[[dict[str, Any]], Awaitable[None]]


class ModeRouter(FrameProcessor):
    def __init__(
        self,
        *,
        words: list[Word],
        notify: Notify,
        judge: VocabJudge,
        mode_judge: ModeJudge,
        classifier: BaseClassifier,
        english: EnglishCollector,
        translator: Translator,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._classifier = classifier  # shared by mode_judge and judge; router owns its lifecycle
        self._words = words
        self._notify = notify
        self._vocab_judge = judge
        self._mode_judge = mode_judge
        self._english = english
        self._translator = translator
        self._turn_start = time.time()

        self.mode = Mode.CONVERSATION
        self.last_tutor_line: str | None = None
        self.last_help_answer: str | None = None
        self.partial_answer: str = ""
        self.practiced: dict[str, str] = {}  # word_id -> "correct"
        self.attempts: dict[str, list[str]] = {}  # word_id -> wrong_form transcripts
        self._tentative_sent: set[str] = set()

    # ---- lifecycle ----

    async def setup(self, setup: FrameProcessorSetup):
        await super().setup(setup)
        await self._classifier.setup(self.task_manager)

        @self._classifier.event_handler("on_metrics")
        async def on_metrics(classifier, data):
            await self.push_frame(MetricsFrame(data=data))

    async def cleanup(self):
        await super().cleanup()
        await self._classifier.cleanup()

    # ---- public API (UI buttons, bot.py) ----

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "state",
            "mode": self.mode.value,
            "last_tutor_line": self.last_tutor_line,
            "partial_answer": self.partial_answer,
            "practiced": self.practiced,
        }

    async def manual(self, action: str):
        """Fallback buttons: 'help' | 'resume'."""
        if action == "help":
            await self._set_mode(Mode.HELP, reason="button")
        elif action == "resume" and self.mode != Mode.CONVERSATION:
            await self._set_mode(Mode.CONVERSATION, reason="button")
            await self.push_frame(
                LLMMessagesAppendFrame(
                    messages=[{"role": "developer", "content": self._resume_note()}], run_llm=True
                )
            )
            self.partial_answer = ""

    # ---- frame handling ----

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, ProposedUserStartedSpeakingFrame):
            # Small margin: the English stream may detect speech slightly earlier
            self._turn_start = time.time() - 0.5
            await self.push_frame(frame, direction)
        elif isinstance(frame, InterimTranscriptionFrame):
            await self._on_interim(frame)
            await self.push_frame(frame, direction)
        elif isinstance(frame, TranscriptionFrame):
            # Awaiting here is safe: the turn-stop frame is a ControlFrame queued behind this one
            if await self._route(frame):
                await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _on_interim(self, frame: InterimTranscriptionFrame):
        if self.mode != Mode.CONVERSATION:
            return
        for wid in local_hits(frame.text, self._words):
            if wid not in self.practiced and wid not in self._tentative_sent:
                self._tentative_sent.add(wid)
                await self._notify({"type": "vocab_tentative", "word_id": wid})

    async def _route(self, frame: TranscriptionFrame) -> bool:
        text = frame.text.strip()
        en_text = self._english.take_since(self._turn_start)
        self._tentative_sent.clear()
        if not text and not en_text:
            return False

        # Vocab check runs alongside the mode decision; only applied if the turn is practice
        pending = [w for w in self._words if w.id not in self.practiced]
        tutor_line = self.last_tutor_line
        vocab_task = (
            asyncio.create_task(self._vocab_judge.judge(text, tutor_line, pending))
            if pending and _JA.search(text)
            else None
        )

        t0 = time.time()
        prev = self.mode
        try:
            d = await self._mode_judge.decide(text, en_text, prev.value, tutor_line, self.last_help_answer)
            target = Mode(d.mode)
            error = None
        except Exception as e:
            logger.exception("Mode decision failed; keeping current mode")
            d, target, error = None, prev, str(e)
        latency_ms = int((time.time() - t0) * 1000)
        logger.info(
            f"Turn ja={text!r} en={en_text!r} -> spoke {d.language if d else '?'} "
            f"{d.language_probabilities if d else ''}, mode {d.mode if d else 'error'} "
            f"{d.probabilities if d else ''} ({latency_ms} ms)"
        )

        if target != prev:
            if target == Mode.HELP:
                self.partial_answer = japanese_part(text) or self.partial_answer
                await self._set_mode(Mode.HELP, reason="Decisions API")
            else:
                await self._set_mode(Mode.CONVERSATION, reason="Decisions API")
                # Resume note goes in before the learner's turn so the LLM picks up the old thread
                await self.push_frame(
                    LLMMessagesAppendFrame(
                        messages=[{"role": "developer", "content": self._resume_note()}], run_llm=False
                    )
                )
                self.partial_answer = ""

        # LLM gets the transcript step 1 judged intelligible
        llm_text = (d.transcript if d else text) or text or en_text
        frame.text = llm_text
        if d and d.language == "japanese" and llm_text:
            self.translate_async(llm_text)

        await self._notify(
            {
                "type": "route",
                "text": text,
                "en_text": en_text,
                "llm_text": llm_text,
                "language": frame.language.value if frame.language else None,
                "prev": prev.value,
                "mode": target.value,
                "choice": d.mode if d else None,
                "spoke": d.language if d else None,
                "language_probabilities": {k: round(v, 3) for k, v in d.language_probabilities.items()}
                if d
                else {},
                "confidence": round(d.confidence, 3) if d else None,
                "probabilities": {k: round(v, 3) for k, v in d.probabilities.items()} if d else {},
                "latency_ms": latency_ms,
                "error": error,
            }
        )

        if vocab_task:
            # Only Japanese practice turns count toward the word bank
            if target == Mode.CONVERSATION and d and d.language == "japanese":
                vocab_task.add_done_callback(lambda t: self._schedule_vocab_result(t, text))
            else:
                vocab_task.cancel()
        return True

    # ---- subtitles ----

    def translate_async(self, text: str):
        """English subtitle for a Japanese line, sent to the UI keyed by its text."""

        async def run():
            en = await self._translator.to_english(text)
            if en:
                await self._notify({"type": "translation", "key": key(text), "en": en})

        asyncio.create_task(run())

    # ---- transitions ----

    def _resume_note(self) -> str:
        return prompts.resume_note(self.last_tutor_line, self.partial_answer)

    async def _set_mode(self, mode: Mode, reason: str):
        if mode == self.mode:
            return
        prev, self.mode = self.mode, mode
        logger.info(f"Mode {prev} -> {mode} ({reason})")
        # Settings frames travel ahead of this turn's transcript, so the LLM run sees them
        if mode == Mode.HELP:
            instruction = prompts.help_prompt(self._words, self.last_tutor_line, self.partial_answer)
            language = Language.EN
        else:
            instruction = prompts.conversation_prompt(self._words)
            language = Language.JA
        await self.push_frame(LLMUpdateSettingsFrame(delta=LLMSettings(system_instruction=instruction)))
        await self.push_frame(TTSUpdateSettingsFrame(delta=TTSSettings(language=language)))
        if mode == Mode.HELP:
            # Latest note in history must match the mode; an earlier resume note says "Japanese only"
            await self.push_frame(
                LLMMessagesAppendFrame(messages=[{"role": "developer", "content": prompts.help_note()}], run_llm=False)
            )
        await self._notify({"type": "mode", "mode": mode.value, "prev": prev.value, "reason": reason})
        await self._notify(self.snapshot())

    # ---- vocab results ----

    def _schedule_vocab_result(self, task: asyncio.Task, text: str):
        if task.cancelled():
            return
        asyncio.create_task(self._apply_vocab(task, text))

    async def _apply_vocab(self, task: asyncio.Task, text: str):
        try:
            results: list[WordResult] = task.result()
        except Exception as e:
            logger.exception("Vocab decision failed")
            await self._notify({"type": "decision_error", "error": str(e)})
            return
        for r in results:
            if r.verdict == "correct":
                self.practiced[r.word_id] = r.verdict
            elif r.verdict == "wrong_form":
                self.attempts.setdefault(r.word_id, []).append(text)
        await self._notify(
            {
                "type": "vocab_decision",
                "text": text,
                "results": [
                    {
                        "word_id": r.word_id,
                        "verdict": r.verdict,
                        "confidence": round(r.confidence, 3),
                    }
                    for r in results
                ],
            }
        )
