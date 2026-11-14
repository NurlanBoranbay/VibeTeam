"""Bank-call script for asking a card issuer for a lower APR.

The AI only rewords. Every figure in the script comes from the plan, and the output is
checked: if the model's text contains a number that is not in the facts, or is not in the
expected shape, the fixed template is used instead. The calculator never depends on AI.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

import anthropic

MODEL = "claude-opus-5-5"
STEPS = [
    ("open", "Open"),
    ("ask", "The ask"),
    ("case", "Your case"),
    ("pushback", "If they hesitate"),
    ("close", "Before you hang up"),
]
QUESTIONS = [
    "What is the new APR, exactly?",
    "When does it start, and how long does it last?",
    "Is there a fee, or any change to my credit limit?",
    "Does it apply to my existing balance or only to new purchases?",
    "Will accepting it close the card or change other terms?",
]
DISCLAIMER = "The bank decides. A lower rate and any saving are not guaranteed."

SYSTEM = """You write short phone scripts for a person calling their credit card issuer to ask for a lower interest rate.

The person reads your lines aloud, so write the way a calm, polite adult speaks on the phone: plain words, one or two sentences per line, first person.

You are given the facts of their plan as JSON. Use only the figures in that JSON. Do not add, estimate or round any other number, date, rate or amount, and do not promise or predict what the bank will do. Do not mention credit scores.

Reply with exactly five lines and nothing else, each starting with its key and a colon, in this order:
open: a greeting that says what the call is about
ask: the request for a lower rate, stating the current APR
case: why the bank should agree, using the planned payment, the minimum and the balance
pushback: what to say if the agent hesitates or says no
close: asking to confirm the new rate, its start and length, and a reference number"""


@dataclass
class CallFacts:
    card_name: str
    balance: float
    apr: float
    minimum: float
    planned_payment: float

    def money(self, v: float) -> str:
        return f"${v:,.0f}" if float(v).is_integer() else f"${v:,.2f}"

    def rate(self) -> str:
        return f"{self.apr:g}%"


def template_script(f: CallFacts) -> list[dict]:
    say = {
        "open": "Hi, I am calling about the interest rate on my credit card. Could you help me with that, or transfer me to someone who can?",
        "ask": f"My purchase APR is {f.rate()}. I am paying this card down on a plan, and I would like to ask for a lower rate.",
        # "above the minimum" is only said when it is true
        "case": (
            f"I am paying {f.money(f.planned_payment)} a month on this card, above the {f.money(f.minimum)} minimum, and I intend to clear the full balance of about {f.money(f.balance)}."
            if f.planned_payment > f.minimum + 0.005
            else f"I am paying the {f.money(f.minimum)} minimum on this card every month, on time, and I intend to clear the full balance of about {f.money(f.balance)}."
        ),
        "pushback": "Is there any reduction you can offer, even for a limited time? What would I need to qualify?",
        "close": "Can you confirm the new rate, when it starts and how long it lasts? Could I have a reference number for this call?",
    }
    return [{"step": k, "label": label, "say": say[k]} for k, label in STEPS]


def _norm(num: str) -> str:
    return str(float(num.replace(",", ""))).rstrip("0").rstrip(".")


def allowed_numbers(f: CallFacts) -> set[str]:
    return {_norm(f"{v}") for v in (f.balance, f.apr, f.minimum, f.planned_payment)}


def is_grounded(lines: list[dict], f: CallFacts) -> bool:
    """True when every number in the script is one of the plan's own figures."""
    ok = allowed_numbers(f)
    for line in lines:
        for num in re.findall(r"\d[\d,]*(?:\.\d+)?", line["say"]):
            if _norm(num) not in ok:
                return False
    return True


def parse(text: str) -> list[dict] | None:
    """Turn 'key: sentence' lines into script steps. None unless all five are present, in order."""
    found = {}
    for raw in text.strip().splitlines():
        key, sep, rest = raw.partition(":")
        if sep and key.strip().lower() in dict(STEPS) and rest.strip():
            found[key.strip().lower()] = rest.strip()
    if list(found) != [k for k, _ in STEPS]:
        return None
    return [{"step": k, "label": label, "say": found[k]} for k, label in STEPS]


def ai_script(f: CallFacts, tone: str = "polite and direct", client: anthropic.Anthropic | None = None) -> list[dict] | None:
    """Ask Claude to reword the script. Returns None on any failure so the caller can fall back."""
    client = client or anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            # Server-side refusal fallback. Passed via extra_body so it also works on SDK
            # releases whose signature does not have `fallbacks` yet.
            extra_body={"fallbacks": "default"},
            output_config={"effort": "low"},
            system=SYSTEM,
            messages=[{"role": "user", "content": f"Tone: {tone}\nFacts:\n{json.dumps(asdict(f))}"}],
        )
    except anthropic.RateLimitError:
        return None
    except anthropic.APIStatusError:
        return None
    except anthropic.APIConnectionError:
        return None
    except anthropic.AnthropicError:
        return None
    except TypeError:  # the SDK raises this when no API key or auth token is configured
        return None
    if response.stop_reason in ("refusal", "max_tokens"):
        return None
    text = "".join(block.text for block in response.content if block.type == "text")
    lines = parse(text)
    if lines is None or not is_grounded(lines, f):
        return None
    return lines


def call_script(f: CallFacts, tone: str = "polite and direct", use_ai: bool = True, client: anthropic.Anthropic | None = None) -> dict:
    lines = ai_script(f, tone, client) if use_ai else None
    return {
        "source": "ai" if lines else "template",
        "model": MODEL if lines else None,
        "lines": lines or template_script(f),
        "questions": QUESTIONS,
        "disclaimer": DISCLAIMER,
    }
