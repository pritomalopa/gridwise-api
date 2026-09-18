/**
 * SAFETY NET ONLY.
 *
 * The mandatory interpretation path is the language model in interpretNotes.ts.
 * This module exists purely so that a provider outage, a quota error or a hard
 * timeout produces a controlled, still-useful response instead of a 5xx.
 * It is never used while the model is reachable, and it is not the interpreter
 * the solution relies on.
 */

const WORD_FRACTIONS: [RegExp, number][] = [
  [/\bhalf\b/i, 0.5],
  [/\bone[- ]half\b/i, 0.5],
  [/\ba quarter\b|\bone[- ](?:quarter|fourth)\b/i, 0.25],
  [/\bthree[- ]quarters\b/i, 0.75],
  [/\bone[- ]fifth\b/i, 0.2],
  [/\bone[- ]third\b/i, 1 / 3],
  [/\btwo[- ]thirds\b/i, 2 / 3],
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

interface TimePoint {
  hour: number;
  index: number;
}

/** Collect clock references such as "6 PM", "18:00", "noon", "two". */
function findTimePoints(text: string): TimePoint[] {
  const points: TimePoint[] = [];
  const pushed = new Set<number>();

  const push = (hour: number, index: number) => {
    if (hour < 0 || hour > 24) return;
    if (pushed.has(index)) return;
    pushed.add(index);
    points.push({ hour: hour % 24, index });
  };

  const meridiem = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
  for (let m = meridiem.exec(text); m; m = meridiem.exec(text)) {
    let h = parseInt(m[1], 10) % 12;
    if (/p/i.test(m[3])) h += 12;
    push(h, m.index);
  }

  const clock24 = /\b(\d{1,2}):(\d{2})\b/g;
  for (let m = clock24.exec(text); m; m = clock24.exec(text)) {
    push(parseInt(m[1], 10), m.index);
  }

  const noon = /\bnoon\b|\bmidday\b/gi;
  for (let m = noon.exec(text); m; m = noon.exec(text)) push(12, m.index);

  const midnight = /\bmidnight\b/gi;
  for (let m = midnight.exec(text); m; m = midnight.exec(text)) push(0, m.index);

  // "from one until three" style, only when no explicit clock was found
  if (points.length === 0) {
    const words = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");
    for (let m = words.exec(text); m; m = words.exec(text)) {
      const base = NUMBER_WORDS[m[1].toLowerCase()];
      // daytime assumption for bare numerals in an afternoon-sounding note
      push(base <= 6 ? base + 12 : base, m.index);
    }
  }

  return points.sort((a, b) => a.index - b.index);
}

function expand(startHour: number, endExclusive: number): number[] {
  const hours: number[] = [];
  let h = startHour;
  for (let guard = 0; guard < 24; guard++) {
    if (h === endExclusive) break;
    hours.push(h);
    h = (h + 1) % 24;
  }
  return hours.length > 0 ? hours : [startHour];
}

function extractHours(text: string): number[] | null {
  const points = findTimePoints(text);
  if (points.length >= 2) return expand(points[0].hour, points[1].hour);
  if (points.length === 1) {
    const h = points[0].hour;
    if (/\bafter\b|\bfrom\b|\bonwards?\b|\bbeyond\b/i.test(text)) {
      return expand(h, 0);
    }
    if (/\bbefore\b|\buntil\b|\bby\b/i.test(text)) {
      return expand(0, h);
    }
    return [h];
  }
  if (/\ball day\b|\bthroughout the day\b|\bwhole day\b/i.test(text)) {
    return Array.from({ length: 24 }, (_, i) => i);
  }
  return null;
}

function extractFactor(text: string): number | null {
  const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
  const reductionLanguage = /\breduc|\bdrop by|\bdecreas|\bloss|\blower by|\bcut by|\bdown by/i.test(text);
  if (pct) {
    const p = parseFloat(pct[1]) / 100;
    const factor = reductionLanguage ? 1 - p : p;
    return Math.min(Math.max(factor, 0), 1);
  }
  for (const [re, value] of WORD_FRACTIONS) {
    if (re.test(text)) return reductionLanguage ? 1 - value : value;
  }
  if (/\bno solar\b|\bzero solar\b|\bsolar (?:is )?unavailable\b|\boffline\b/i.test(text)) {
    return 0;
  }
  return null;
}

function extractKwh(text: string): number | null {
  const kwh = /(\d+(?:\.\d+)?)\s*kwh/i.exec(text);
  if (kwh) return parseFloat(kwh[1]);
  return null;
}

export interface FallbackDirective {
  note_index: number;
  applies: boolean;
  directive_type: string;
  structured_adjustment: Record<string, unknown> | null;
  explanation: string;
}

export function fallbackInterpret(
  notes: string[],
  batteryCapacityKwh: number,
): FallbackDirective[] {
  return notes.map((note, note_index) => {
    const text = String(note);
    const hours = extractHours(text);
    const noOp = (why: string): FallbackDirective => ({
      note_index,
      applies: false,
      directive_type: "no_op",
      structured_adjustment: null,
      explanation: why,
    });

    const mentionsGridCap =
      /\bgrid\b|\bimport\b|\bintake\b|\bfeeder\b|\btransformer\b|\bsubstation\b/i.test(text) &&
      /\bexceed\b|\bcap\b|\blimit\b|\bat or below\b|\bno more than\b|\bmaximum\b|\bmust stay\b/i.test(text);

    const mentionsSolar = /\bsolar\b|\bpv\b|\bpanel\b|\brooftop\b|\bphotovolt|\binverter\b/i.test(text);
    const mentionsDischarge = /\bdischarg/i.test(text);
    const mentionsCharge = /\bcharg/i.test(text) && !mentionsDischarge;
    const blocked = /\bnot\b|\bno\b|\bdisabl|\bunavail|\bisolat|\bprohibit|\bsuspend|\bavoid\b|\boffline\b|\bblocked\b/i.test(text);
    const mentionsReserve =
      /\bat least\b|\breserve\b|\bminimum\b|\bbackup\b|\bremain in the battery\b|\bkeep\b/i.test(text) &&
      /\bbattery\b|\bkwh\b|\bstored\b|\bcapacity\b/i.test(text);

    if (!hours) return noOp("No usable time window was detected in this note.");

    if (mentionsGridCap) {
      const cap = extractKwh(text);
      if (cap !== null) {
        return {
          note_index,
          applies: true,
          directive_type: "max_grid_window",
          structured_adjustment: { hours, max_grid_kwh: cap },
          explanation: "Grid import is capped during the stated window.",
        };
      }
    }

    if (mentionsSolar) {
      const factor = extractFactor(text);
      if (factor !== null) {
        return {
          note_index,
          applies: true,
          directive_type: "solar_reduction",
          structured_adjustment: { hours, factor },
          explanation: "Usable solar is reduced during the stated window.",
        };
      }
    }

    if (mentionsDischarge && blocked) {
      return {
        note_index,
        applies: true,
        directive_type: "no_discharge_window",
        structured_adjustment: { hours },
        explanation: "Battery discharge is unavailable during the stated window.",
      };
    }

    if (mentionsCharge && blocked) {
      return {
        note_index,
        applies: true,
        directive_type: "no_charge_window",
        structured_adjustment: { hours },
        explanation: "Battery charging is unavailable during the stated window.",
      };
    }

    if (mentionsReserve) {
      let reserve = extractKwh(text);
      if (reserve === null) {
        const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
        if (pct) reserve = (parseFloat(pct[1]) / 100) * batteryCapacityKwh;
      }
      if (reserve !== null) {
        return {
          note_index,
          applies: true,
          directive_type: "minimum_battery_reserve",
          structured_adjustment: { hours, minimum_energy_kwh: reserve },
          explanation: "A minimum battery reserve is required during the stated window.",
        };
      }
    }

    return noOp("This note does not map to a supported energy directive.");
  });
}
