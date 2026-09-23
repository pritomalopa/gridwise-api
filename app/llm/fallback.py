"""Degraded-mode interpreter, used ONLY when every LLM is unavailable.

The LLM is the primary interpreter; this keyword/regex parser exists so a provider
outage produces a controlled, best-effort answer instead of a 5xx. Its output goes
through the same guardrails and is flagged in the explanation.

Ported from the proven Node heuristic (10/10 public samples offline) but returns
the intermediate schema (windows/value/unit) so guardrails do the arithmetic.
"""
from __future__ import annotations

import re

_WORD_HOUR = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
_FRACTIONS = {
    "half": 50, "halve": 50, "nothing": 0, "no output": 0, "zero": 0,
    "quarter": 25, "a third": 100 / 3, "one-third": 100 / 3, "one third": 100 / 3,
    "one-fifth": 20, "one fifth": 20, "a fifth": 20,
    "three quarters": 75, "three-quarters": 75, "two-thirds": 200 / 3,
}
_TIME = r"(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)"
_RANGE = re.compile(_TIME + r"\s*(?:to|until|till|through|and|-|–)\s*" + _TIME, re.I)


def _parse_time(tok: str) -> tuple[int | None, str | None]:
    t = tok.lower().replace(".", "").strip()
    if t == "noon":
        return 12, "pm"
    if t == "midnight":
        return 0, "am"
    m = re.match(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", t)
    if not m:
        return None, None
    h, mer = int(m.group(1)), m.group(3)
    if not 0 <= h <= 23:
        return None, None
    if mer == "pm" and h < 12:
        h += 12
    elif mer == "am" and h == 12:
        h = 0
    if mer is None and ":" in t:
        mer = "24h"
    return h, mer


def _window(note: str) -> list[dict]:
    """Return [{"start_hour": s, "end_hour": e}] with end-exclusive semantics.

    Guardrails expand_windows() handles s>e as an overnight wrap and s==e as a
    single hour, so we preserve the raw pair here.
    """
    text = note
    for w, n in _WORD_HOUR.items():
        text = re.sub(rf"\b{w}\b", str(n), text, flags=re.I)
    low = text.lower()
    is_solar = bool(re.search(r"solar|pv|photovoltaic|panel|rooftop|inverter", low))

    # shared-suffix range: "1-3 pm", "2 to 4 PM"
    m = re.search(r"\b(\d{1,2})\s*(?:-|–|—|to|until|till|through|thru)\s*(\d{1,2})\s*(am|pm)\b", low)
    if m:
        suf = m.group(3)
        s, _ = _parse_time(f"{m.group(1)} {suf}")
        e, _ = _parse_time(f"{m.group(2)} {suf}")
        if s is not None and e is not None:
            if e == 0 and suf == "am":
                e = 24
            return [{"start_hour": s % 24, "end_hour": e if e == 24 else e % 24}]
    # word range: "one until three", "ten until noon"
    m = re.search(
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*"
        r"(?:-|–|—|to|until|till|through|thru)\s*"
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)\b(?:\s*(am|pm))?",
        low,
    )
    if m:
        s = _WORD_HOUR[m.group(1)]
        e_tok = m.group(2)
        e = 12 if e_tok == "noon" else 0 if e_tok == "midnight" else _WORD_HOUR[e_tok]
        suf = m.group(3)
        if suf == "pm":
            if s < 12:
                s += 12
            if e < 12 and e != 0:
                e += 12
        elif suf == "am":
            if s == 12:
                s = 0
            if e == 12:
                e = 0
        elif is_solar and 1 <= s <= 11:
            s += 12
            e = 12 if e == 12 else (e + 12 if 1 <= e <= 11 else e)
        elif 1 <= s <= 12 and 1 <= e <= 12 and e <= s:
            e += 12
        if e == 0 and "midnight" in low:
            e = 24
        return [{"start_hour": s % 24, "end_hour": e if e == 24 else e % 24}]

    m = _RANGE.search(text)
    if m:
        (s, sm), (e, em) = _parse_time(m.group(1)), _parse_time(m.group(2))
        if s is None or e is None:
            return []
        if sm is None and em == "pm" and s < 12:
            s = s + 12 if s + 12 <= e else s
        if sm is None and em is None and s < 7 and e <= 7:
            s, e = s + 12, e + 12
        if em is None and sm == "pm" and e < 12:
            e += 12
        if m.group(2).lower() == "midnight":
            e = 24
        return [{"start_hour": s % 24, "end_hour": e if e == 24 else e % 24}]

    single = re.search(r"(?:at|during the|for the|in the)\s+" + _TIME + r"(?:\s+hour)?", text, re.I)
    if single and re.search(r"\d|noon|midnight", single.group(1), re.I):
        h, mer = _parse_time(single.group(1))
        if h is None:
            return []
        if mer is None and h < 7:
            h += 12
        return [{"start_hour": h % 24, "end_hour": (h % 24) + 1}]
    return []


def _percent(note: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:%|percent)", note, re.I)
    if m:
        return float(m.group(1))
    low = note.lower()
    for w, v in sorted(_FRACTIONS.items(), key=lambda kv: -len(kv[0])):
        if w in low:
            return v
    return None


def _kwh(note: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*kwh", note, re.I)
    return float(m.group(1)) if m else None


def _pct_of_capacity(note: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*of[^.]*?(?:batter|capacity|storage)", note, re.I)
    return float(m.group(1)) if m else None


def interpret_fallback(note: str) -> dict:
    low = note.lower()
    windows = _window(note)
    base = {"windows": windows, "value": 0, "value_unit": "none",
            "explanation": "[fallback parser: LLM unavailable] "}
    if not windows or re.search(r"next (week|month|year)|last (week|month)", low):
        return {**base, "directive_type": "no_op", "windows": [],
                "explanation": base["explanation"] + "No schedulable energy constraint found."}

    has_solar = bool(re.search(r"solar|pv|panel|inverter|photovoltaic|rooftop|cloud|generation|production", low))
    if has_solar and re.search(r"reduc|drop|fall|leav|%|half|quarter|fifth|usable|forecast|output|cloud|wash|clean|inspect|maintenance|inverter|cover|shade|haze", low):
        pct = _percent(note)
        if pct is not None:
            unit = (
                "percent_reduction"
                if re.search(r"reduc|cut|by \d|lower by|decrease|loses", low)
                and not re.search(r"to (about |roughly )?\d", low)
                else "percent_remaining"
            )
            return {**base, "directive_type": "solar_reduction", "value": pct, "value_unit": unit,
                    "explanation": base["explanation"] + "Solar output reduced."}

    # Grid cap BEFORE reserve: "grid/import/intake + kWh cap" is never a battery reserve,
    # even when the note says "stay/remain at or below".
    has_grid = bool(re.search(r"grid|import|intake|feeder|transformer|substation", low))
    if has_grid and _kwh(note) is not None:
        return {**base, "directive_type": "max_grid_window", "value": _kwh(note), "value_unit": "kwh",
                "explanation": base["explanation"] + "Grid import capped."}

    has_battery = "batter" in low or "stor" in low
    if has_battery and re.search(r"reserve|keep|retain|hold|at least|remain|minimum|maintain|never drop|cushion|buffer|emergency|data center", low):
        pct_cap = _pct_of_capacity(note)
        if pct_cap is not None:
            return {**base, "directive_type": "minimum_battery_reserve", "value": pct_cap,
                    "value_unit": "percent_remaining",
                    "explanation": base["explanation"] + "Battery reserve required."}
        pct = _percent(note)
        if pct is not None and re.search(r"capac|batter|stor", low):
            return {**base, "directive_type": "minimum_battery_reserve", "value": pct,
                    "value_unit": "percent_remaining",
                    "explanation": base["explanation"] + "Battery reserve required."}
        kwh = _kwh(note)
        if kwh is not None:
            return {**base, "directive_type": "minimum_battery_reserve", "value": kwh, "value_unit": "kwh",
                    "explanation": base["explanation"] + "Battery reserve required."}

    if re.search(r"discharg|(not|never|no|cannot|from)\b.{0,25}\b(suppl|deliver|provid|export)", low):
        return {**base, "directive_type": "no_discharge_window",
                "explanation": base["explanation"] + "Battery discharge blocked."}
    dis_signal = bool(re.search(r"not discharge|no discharge|without discharg|discharg.{0,40}unavailable|discharg.{0,40}disabled|do not discharge|must not discharge|discharge.{0,20}disabled", low))
    if "discharg" in low and dis_signal:
        return {**base, "directive_type": "no_discharge_window",
                "explanation": base["explanation"] + "Battery discharge blocked."}
    if "charg" in low:
        return {**base, "directive_type": "no_charge_window",
                "explanation": base["explanation"] + "Battery charging unavailable."}
    return {**base, "directive_type": "no_op", "windows": [],
            "explanation": base["explanation"] + "No schedulable energy constraint found."}
