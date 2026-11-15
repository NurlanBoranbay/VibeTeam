"""Chat models behind one call.

Every model is reached over the OpenAI-compatible chat API: the local ones (vLLM serving Qwen and
Gemma on the GPU server) for everyday work, and DeepSeek only for the "hard" tier, because it is
paid per token. Nothing here knows about FinPilot; it only sends messages and returns the reply.

Configuration (environment):
  LLM_FAST_URL, LLM_FAST_MODEL, LLM_FAST_KEY     first choice for everyday work
  LLM_ALT_URL,  LLM_ALT_MODEL,  LLM_ALT_KEY      used when the first one fails
  DEEPSEEK_API_KEY, DEEPSEEK_URL, DEEPSEEK_MODEL the hard tier
With nothing set, `available()` is False and callers fall back to their non-AI path.
"""
from __future__ import annotations

import os
import re

import httpx


class LLMUnavailable(RuntimeError):
    """No configured model could answer."""


def _provider(prefix: str, default_url: str = "", default_model: str = "") -> dict | None:
    url = os.environ.get(f"{prefix}_URL", default_url).rstrip("/")
    model = os.environ.get(f"{prefix}_MODEL", default_model)
    if not url or not model:
        return None
    return {"name": prefix.lower(), "url": url, "model": model, "key": os.environ.get(f"{prefix}_KEY", "")}


def providers(tier: str = "fast") -> list[dict]:
    local = [p for p in (_provider("LLM_FAST"), _provider("LLM_ALT")) if p]
    if tier != "hard":
        return local
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    deep = None
    if key:
        deep = {"name": "deepseek", "url": os.environ.get("DEEPSEEK_URL", "https://api.deepseek.com").rstrip("/"),
                "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"), "key": key}
    # a hard question still gets an answer from a local model when DeepSeek is not set up or is out of credit
    return ([deep] if deep else []) + local


def available(tier: str = "fast") -> bool:
    return bool(providers(tier))


def _clean(text: str | None) -> str:
    """Models that think out loud wrap it in <think> tags; that is never shown to the person."""
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()


def chat(messages: list[dict], tools: list[dict] | None = None, tier: str = "fast", max_tokens: int = 1200,
         temperature: float = 0.2, timeout: float = 90.0) -> dict:
    """Returns {"content": str, "tool_calls": [...], "model": str}. Raises LLMUnavailable when nothing answers."""
    last = "no model is configured"
    for p in providers(tier):
        body: dict = {"model": p["model"], "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
        if tools:
            body["tools"] = tools
        headers = {"Authorization": f"Bearer {p['key']}"} if p["key"] else {}
        base = p["url"] if p["url"].endswith("/v1") or "deepseek" in p["url"] else p["url"] + "/v1"
        # Local reasoning models (Qwen) otherwise spend the whole allowance thinking and return nothing.
        quiet = p["name"] != "deepseek"
        try:
            r = httpx.post(f"{base}/chat/completions", json={**body, "chat_template_kwargs": {"enable_thinking": False}} if quiet else body, headers=headers, timeout=timeout)
            if quiet and r.status_code == 400:  # a server that does not know the switch
                r = httpx.post(f"{base}/chat/completions", json=body, headers=headers, timeout=timeout)
            if r.status_code >= 400:
                last = f"{p['name']} answered {r.status_code}"
                continue
            message = r.json()["choices"][0]["message"]
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            last = f"{p['name']}: {type(exc).__name__}"
            continue
        return {"content": _clean(message.get("content")), "tool_calls": message.get("tool_calls") or [], "model": p["model"].split("/")[-1]}
    raise LLMUnavailable(last)
