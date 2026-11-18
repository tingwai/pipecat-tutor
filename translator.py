"""Japanese -> English subtitles so an English-speaking audience can follow along."""

import re

from loguru import logger
from openai import AsyncOpenAI

MODEL = "gpt-4.1-mini"


def key(text: str) -> str:
    """Whitespace-free key; the client matches messages with the same normalization."""
    return re.sub(r"\s+", "", text)


class Translator:
    def __init__(self, client: AsyncOpenAI | None = None):
        self._client = client or AsyncOpenAI()

    async def to_english(self, text: str) -> str | None:
        try:
            r = await self._client.chat.completions.create(
                model=MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Translate the Japanese into short, natural English. It is from a beginner "
                            "Japanese lesson and may contain speech-recognition errors; translate the "
                            "likely meaning. Output only the translation."
                        ),
                    },
                    {"role": "user", "content": text},
                ],
                max_tokens=120,
            )
            return (r.choices[0].message.content or "").strip()
        except Exception:
            logger.exception("Translation failed")
            return None
