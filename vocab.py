"""N5 word bank, local inflection matcher, and Decisions-classifier usage judge."""

from dataclasses import dataclass, field

from pipecat.classifiers.base_classifier import BaseClassifier, ChoiceQuestion


@dataclass
class Word:
    id: str
    ja: str  # dictionary form
    reading: str
    en: str
    pos: str  # verb | adj | noun
    stems: list[str]  # substrings that signal a likely use (kanji + kana forms)


# Stems cover common conjugations (polite, past, te-form) without a morphological analyzer
N5_POOL: list[Word] = [
    Word("taberu", "食べる", "たべる", "to eat", "verb", ["食べ", "たべ"]),
    Word("nomu", "飲む", "のむ", "to drink", "verb", ["飲", "のみ", "のま", "のん", "のむ", "のめ"]),
    Word("iku", "行く", "いく", "to go", "verb", ["行", "いき", "いか", "いっ", "いく", "いけ"]),
    Word("miru", "見る", "みる", "to see / watch", "verb", ["見", "みま", "みた", "みて", "みる", "みな"]),
    Word("kau", "買う", "かう", "to buy", "verb", ["買", "かい", "かっ", "かう", "かわ"]),
    Word("yomu", "読む", "よむ", "to read", "verb", ["読", "よみ", "よん", "よむ", "よま"]),
    Word("kiku", "聞く", "きく", "to listen / ask", "verb", ["聞", "きき", "きい", "きく", "きか"]),
    Word("suki", "好き", "すき", "liked / favorite", "adj", ["好き", "すき", "大好", "だいすき"]),
    Word("oishii", "おいしい", "おいしい", "delicious", "adj", ["おいし", "美味し"]),
    Word("tanoshii", "楽しい", "たのしい", "fun", "adj", ["楽し", "たのし"]),
    Word("kyou", "今日", "きょう", "today", "noun", ["今日", "きょう"]),
    Word("ashita", "明日", "あした", "tomorrow", "noun", ["明日", "あした", "あす"]),
    Word("kinou", "昨日", "きのう", "yesterday", "noun", ["昨日", "きのう"]),
    Word("tomodachi", "友達", "ともだち", "friend", "noun", ["友達", "ともだち", "友だち"]),
    Word("gakkou", "学校", "がっこう", "school", "noun", ["学校", "がっこう"]),
    Word("eiga", "映画", "えいが", "movie", "noun", ["映画", "えいが"]),
    Word("mizu", "水", "みず", "water", "noun", ["水", "みず"]),
    Word("hon", "本", "ほん", "book", "noun", ["本", "ほん"]),
    Word("asagohan", "朝ご飯", "あさごはん", "breakfast", "noun", ["朝ご飯", "朝ごはん", "あさごはん", "朝飯"]),
    Word("shuumatsu", "週末", "しゅうまつ", "weekend", "noun", ["週末", "しゅうまつ"]),
]


# Fixed demo set, in display order
DEMO_WORDS = ["taberu", "nomu", "miru", "oishii", "kyou", "tomodachi", "eiga", "mizu"]


def pick_words() -> list[Word]:
    """The session's target words (fixed so demos are repeatable)."""
    by_id = {w.id: w for w in N5_POOL}
    return [by_id[i] for i in DEMO_WORDS]


def local_hits(text: str, words: list[Word]) -> list[str]:
    """Word ids whose stems appear in text; tentative only (no meaning/negation check)."""
    return [w.id for w in words if any(s in text for s in w.stems)]


# Verdict options for each word
VERDICTS = {
    "correct": (
        "The learner used the word themselves in their own Japanese sentence, with its "
        "intended meaning, in an affirmative form. Plain, polite (ます/です), past, te-form, "
        "and other affirmative conjugations all count. Minor grammar slips elsewhere are fine."
    ),
    "wrong_form": (
        "The learner used the word in a Japanese sentence but in a negated form "
        "(e.g. 食べません/食べない for 'to eat'), with the wrong meaning, or so garbled it "
        "does not express the word's meaning."
    ),
    "mentioned_only": (
        "The word appears but the learner did not use it to say something: asking what it "
        "means, asking how to say it, quoting it, repeating the tutor, or discussing it in English."
    ),
    "absent": "The word (in any form) does not appear in the learner's turn.",
}


@dataclass
class WordResult:
    word_id: str
    verdict: str
    confidence: float
    probabilities: dict[str, float] = field(default_factory=dict)


class VocabJudge:
    """Asks the classifier, per word, whether the learner's turn really used it."""

    def __init__(self, classifier: BaseClassifier):
        self._classifier = classifier

    async def judge(
        self, learner_text: str, tutor_prompt: str | None, words: list[Word]
    ) -> list[WordResult]:
        if not words:
            return []
        state = {
            "about": (
                "A JLPT N5 Japanese learner in spoken conversation practice. The learner's turn is a "
                "speech transcript and may contain recognition errors; judge intent."
            ),
            "tutor_last_line": tutor_prompt or "(none)",
            "learner_turn": learner_text,
        }
        questions = {
            w.id: ChoiceQuestion(
                instructions=(
                    f"Target vocabulary word: {w.ja} ({w.reading}) meaning '{w.en}'. "
                    "Judge only the learner's turn, never the tutor's line. "
                    "How did the learner use this word?"
                ),
                options=VERDICTS,
            )
            for w in words
        }
        results = await self._classifier.choice(state, questions)
        return [
            WordResult(word_id=wid, verdict=r.choice, confidence=r.confidence, probabilities=r.probabilities)
            for wid, r in results.items()
        ]
