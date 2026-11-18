"""Mode classifier, two steps with Pipecat's OpenAIDecisionsClassifier (gpt-6-luna):

1. Which recognizer's transcript is intelligible (what language the learner spoke)?
2. Given that transcript, conversation practice or English help?
"""

from dataclasses import dataclass, field

from pipecat.classifiers.base_classifier import BaseClassifier, ChoiceQuestion

LANGUAGE_QUESTION = ChoiceQuestion(
    instructions=(
        "The same utterance was transcribed by two speech recognizers. The Japanese recognizer turns "
        "English speech into garbled Japanese or katakana. The English recognizer turns Japanese speech "
        "into nonsense English words. Which transcript is more intelligible: a coherent sentence a "
        "person would actually say?"
    ),
    options={
        "japanese": (
            "The Japanese transcript is coherent Japanese (an English loanword inside a Japanese "
            "sentence is fine) and the English transcript is nonsense or fragments."
        ),
        "english": (
            "The English transcript is a coherent English sentence or question, and the Japanese "
            "transcript is garbled, katakana-ized English, or Japanese mixed with English words."
        ),
    },
)

MODE_QUESTION = ChoiceQuestion(
    instructions=(
        "A JLPT N5 learner talks to a voice tutor with two modes: Japanese conversation practice and "
        "English help. Which mode should handle what the learner said?"
    ),
    options={
        "conversation": (
            "The learner is doing Japanese conversation practice: answering or attempting to answer "
            "the tutor in Japanese (even with mistakes or fillers), or asking to go back to / resume / "
            "continue the Japanese conversation (e.g. 'I'm back', 'resume', 'let's continue')."
        ),
        "help": (
            "The learner wants English assistance: asks how to say something, what a word means, about "
            "grammar, whether their sentence is correct, says they don't understand, asks the tutor to "
            "explain or translate, or otherwise talks to the tutor in English. While already in help "
            "mode, follow-up questions and brief thanks/acknowledgements are help too."
        ),
    },
)


@dataclass
class ModeDecision:
    language: str  # "japanese" | "english"
    transcript: str  # the intelligible one
    mode: str
    confidence: float
    probabilities: dict[str, float] = field(default_factory=dict)
    language_probabilities: dict[str, float] = field(default_factory=dict)


class ModeJudge:
    def __init__(self, classifier: BaseClassifier):
        self._classifier = classifier

    async def decide(
        self,
        ja_text: str,
        en_text: str,
        current_mode: str,
        tutor_line: str | None,
        last_help_answer: str | None,
    ) -> ModeDecision:
        # Step 1: pick the intelligible transcript (skip the call when only one exists)
        if ja_text and en_text:
            lang = (
                await self._classifier.choice(
                    {"japanese_recognizer": ja_text, "english_recognizer": en_text},
                    {"language": LANGUAGE_QUESTION},
                )
            )["language"]
            language, language_probs = lang.choice, lang.probabilities
        else:
            language = "japanese" if ja_text else "english"
            language_probs = {language: 1.0}
        transcript = ja_text if language == "japanese" else en_text

        # Step 2: mode, judged on that transcript only
        state = {
            "current_mode": current_mode,
            "tutor_last_japanese_line": tutor_line or "(none)",
            "learner_spoke": language,
            "learner_said": transcript,
        }
        if current_mode == "help":
            state["tutor_last_english_help_answer"] = last_help_answer or "(none)"
        r = (await self._classifier.choice(state, {"mode": MODE_QUESTION}))["mode"]
        return ModeDecision(
            language=language,
            transcript=transcript,
            mode=r.choice,
            confidence=r.confidence,
            probabilities=r.probabilities,
            language_probabilities=language_probs,
        )
