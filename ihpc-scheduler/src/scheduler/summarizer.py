"""Log summarizer — calls an LLM via litellm to convert raw experiment logs
into concise, readable email summaries.

litellm supports Anthropic, OpenAI, Gemini, and many others through a
unified interface. Set the model name in config.yaml under summarizer.model,
and provide an API key (or set the corresponding env var, e.g. ANTHROPIC_API_KEY).

If litellm is not installed or the API call fails, the raw log is returned
unchanged so that email notifications are never silently lost.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_PROMPTS_PATHS = [
    Path("configs/prompts.yaml"),
    _PROJECT_ROOT / "configs" / "prompts.yaml",
]

_prompts_cache: dict[str, str] | None = None


def _load_prompts() -> dict[str, str]:
    """Load prompt templates from configs/prompts.yaml (cached after first load)."""
    global _prompts_cache
    if _prompts_cache is not None:
        return _prompts_cache

    for path in _DEFAULT_PROMPTS_PATHS:
        if path.is_file():
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            _prompts_cache = {
                "success": raw.get("success", ""),
                "failure": raw.get("failure", ""),
            }
            return _prompts_cache

    logger.warning("prompts.yaml not found; LLM summarizer will return raw logs.")
    _prompts_cache = {}
    return _prompts_cache


@dataclass
class SummarizerConfig:
    """Configuration for the optional LLM log summarizer.

    Provider selection is determined by the model name prefix (litellm convention):
      - Anthropic : "claude-haiku-4-5-20251001"          env: ANTHROPIC_API_KEY
      - OpenAI    : "gpt-4o-mini"                         env: OPENAI_API_KEY
      - Gemini    : "gemini/gemini-2.0-flash"             env: GEMINI_API_KEY
      - OpenAI-compatible (vLLM, Ollama, local, …):
                    model="openai/<model-name>", api_base="http://host:port/v1"
    """

    enabled: bool = False
    model: str = "claude-haiku-4-5-20251001"
    api_key: str | None = None   # if None, litellm reads the env var for the provider
    api_base: str | None = None  # custom base URL for OpenAI-compatible endpoints
    max_log_lines: int = 150     # how many trailing log lines to send to the LLM
    max_tokens: int = 4096       # max output tokens (must cover thinking + response for reasoning models)


def summarize_log(
    log_content: str,
    exp_name: str,
    *,
    success: bool,
    config: SummarizerConfig,
    exit_code: int | None = None,
) -> str:
    """Return an LLM-generated summary of the log, or the raw log if unavailable.

    Always safe to call — falls back to raw content on any error.
    """
    if not config.enabled:
        return log_content

    try:
        import litellm  # optional dependency: uv sync --extra summarizer
    except ImportError:
        logger.warning(
            "litellm is not installed; returning raw log. Install with: uv sync --extra summarizer"
        )
        return log_content

    prompts = _load_prompts()
    key = "success" if success else "failure"
    prompt_template = prompts.get(key)
    if not prompt_template:
        logger.warning("Prompt template '%s' not found in prompts.yaml; returning raw log.", key)
        return log_content

    trimmed = "\n".join(log_content.splitlines()[-config.max_log_lines :])
    prompt = prompt_template.format(
        name=exp_name,
        exit_code=exit_code,
        log=trimmed,
    )

    kwargs: dict = {
        "model": config.model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": config.max_tokens,
    }
    if config.api_key:
        kwargs["api_key"] = config.api_key
    if config.api_base:
        kwargs["api_base"] = config.api_base

    try:
        response = litellm.completion(**kwargs)
        msg = response.choices[0].message
        text = msg.content or ""
        if not text.strip():
            text = getattr(msg, "reasoning_content", None) or ""
        return text.strip() or log_content
    except Exception as exc:
        logger.warning("Summarizer API call failed (%s); falling back to raw log.", exc)
        return log_content
