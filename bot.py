"""Japanese voice tutor pipeline.

mic -> [Flux STT ja | Flux STT en -> EnglishCollector] -> ModeRouter -> user ctx -> LLM -> TTS -> speaker -> assistant ctx

The Japanese stream drives turns; the English stream only supplies an alternate transcript.
"""

import os
from typing import Any

from loguru import logger

from pipecat.classifiers.openai.decisions.classifier import OpenAIDecisionsClassifier
from pipecat.frames.frames import STTUpdateSettingsFrame, TTSSpeakFrame
from pipecat.pipeline.parallel_pipeline import ParallelPipeline
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIObserverParams, RTVIProcessor
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

import aiohttp

import prompts
from english_shadow import EnglishCollector
from intent import ModeJudge
from translator import Translator
from router import Mode, ModeRouter
from tts_bilingual import BilingualFluxTTSService
from vocab import VocabJudge, pick_words

JA_VOICE = os.getenv("JA_VOICE", "flux-ayumi-ja")
HELP_VOICE = os.getenv("HELP_VOICE", "flux-hannah-en")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-6.2-sol")

# Also shown (with its English) before Start in client/src/lib/tutor-store.ts; keep in sync
OPENING_LINE = "こんにちは！ 今日、何を食べましたか？"

# Patience presets: Flux end-of-turn confidence + max silence before forcing turn end
DEFAULT_EOT_THRESHOLD = 0.8
DEFAULT_EOT_TIMEOUT_MS = 6000


async def run_bot(connection: SmallWebRTCConnection, body: dict[str, Any] | None):
    body = body or {}
    words = pick_words()
    eot_threshold = float(body.get("eot_threshold", DEFAULT_EOT_THRESHOLD))
    eot_timeout_ms = int(body.get("eot_timeout_ms", DEFAULT_EOT_TIMEOUT_MS))

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    stt = DeepgramFluxSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        settings=DeepgramFluxSTTService.Settings(
            model="flux-general-multi",
            language_hints=[Language.JA],  # accented Japanese stays Japanese; English comes from stt_en
            eot_threshold=eot_threshold,
            eot_timeout_ms=eot_timeout_ms,
        ),
    )
    stt_en = DeepgramFluxSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        should_interrupt=False,
        settings=DeepgramFluxSTTService.Settings(
            model="flux-general-en",
            eot_threshold=eot_threshold,
            eot_timeout_ms=eot_timeout_ms,
        ),
    )
    english = EnglishCollector()
    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        # Mode prompt lives in system_instruction; the router swaps it via LLMUpdateSettingsFrame
        settings=OpenAILLMService.Settings(
            model=LLM_MODEL, system_instruction=prompts.conversation_prompt(words)
        ),
    )
    session = aiohttp.ClientSession()
    tts = BilingualFluxTTSService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        ja_voice=JA_VOICE,
        en_voice=HELP_VOICE,
        aiohttp_session=session,
    )

    context = LLMContext()
    aggregators = LLMContextAggregatorPair(
        context,
        # No "please repeat" recovery for turns with no transcript
        user_params=LLMUserAggregatorParams(empty_user_turn=None),
    )

    rtvi = RTVIProcessor()

    async def notify(data: dict[str, Any]):
        await rtvi.send_server_message(data)

    english.on_text = notify

    # One Decisions client for both per-turn questions; short timeout since it gates every turn
    classifier = OpenAIDecisionsClassifier(api_key=os.environ["OPENAI_API_KEY"], timeout=3.0)
    router = ModeRouter(
        words=words,
        notify=notify,
        judge=VocabJudge(classifier),
        mode_judge=ModeJudge(classifier),
        classifier=classifier,
        english=english,
        translator=Translator(),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            ParallelPipeline([stt], [stt_en, english]),
            router,
            aggregators.user(),
            llm,
            tts,
            transport.output(),
            aggregators.assistant(),
        ]
    )
    task = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        rtvi_processor=rtvi,
        # English stream is internal: keep its transcripts out of the UI
        rtvi_observer_params=RTVIObserverParams(ignored_sources=[stt_en, english]),
    )

    @aggregators.assistant().event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(aggregator, message):
        if not message.content:
            return
        # Only Japanese tutor lines count as "the question to resume"
        if router.mode == Mode.CONVERSATION:
            router.last_tutor_line = message.content
            await notify(router.snapshot())
        else:
            router.last_help_answer = message.content

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        await notify(
            {
                "type": "session",
                "words": [
                    {"id": w.id, "ja": w.ja, "reading": w.reading, "en": w.en, "pos": w.pos, "stems": w.stems}
                    for w in words
                ],
                "eot_threshold": eot_threshold,
                "eot_timeout_ms": eot_timeout_ms,
                "voices": {"ja": JA_VOICE, "help": HELP_VOICE},
                "llm": LLM_MODEL,
            }
        )
        await notify(router.snapshot())
        # Fixed opening line for demos; spoken directly and added to context as the tutor's turn
        router.last_tutor_line = OPENING_LINE
        await task.queue_frame(TTSSpeakFrame(OPENING_LINE))

    @rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, msg):
        data = msg.data or {}
        if msg.type == "mode":
            await router.manual(data.get("action", ""))
        elif msg.type == "patience":
            delta = DeepgramFluxSTTService.Settings(
                eot_threshold=float(data["eot_threshold"]),
                eot_timeout_ms=int(data["eot_timeout_ms"]),
            )
            await task.queue_frame(STTUpdateSettingsFrame(delta=delta))
            await notify({"type": "patience", **data})
        elif msg.type == "translate" and data.get("text"):
            # Client asks for subtitles of tutor lines once the reply text is complete
            router.translate_async(data["text"])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.cancel()

    try:
        await WorkerRunner(handle_sigint=False).run(task)
    finally:
        await session.close()
