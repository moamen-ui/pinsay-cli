import type { CapturedBody, NetworkCall, PageContextDto } from './types.js';

export const CAPTURE_PROMPT_MAX_CHARS = 12000;

const TIMELINE_MESSAGE_MAX_CHARS = 120;
const BODY_TEXT_CUT_CHARS = 1000;
const STEPS_FULL = 20;
const STEPS_REDUCED = 5;
const CONSOLE_REDUCED_MAX = 10;
const STACK_MAX_LINES = 3;

type Reductions = {
  droppedTimelineLines: number;
  stepLimit: number;
  consoleErrorsOnly: boolean;
  bodyTextLimit: number | null;
  strippedFailing: number;
  droppedFailing: number;
};

type TimelineItem = { t: number; line: string };

function timeMs(iso?: string | null): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

function callTime(c: NetworkCall): string | undefined {
  return c.startedAt ?? c.occurredAt;
}

function rel(pc: PageContextDto, iso?: string | null): string {
  if (!pc.captureMomentAt || !iso) return '';
  const moment = Date.parse(pc.captureMomentAt);
  const at = Date.parse(iso);
  if (Number.isNaN(moment) || Number.isNaN(at)) return '';
  const s = (at - moment) / 1000;
  if (Math.abs(s) < 0.05) return '0.0s';
  return `${s < 0 ? '-' : '+'}${Math.abs(s).toFixed(1)}s`;
}

function relSeconds(pc: PageContextDto, iso?: string | null): number {
  if (!pc.captureMomentAt || !iso) return Number.NaN;
  const moment = Date.parse(pc.captureMomentAt);
  const at = Date.parse(iso);
  if (Number.isNaN(moment) || Number.isNaN(at)) return Number.NaN;
  return (at - moment) / 1000;
}

function failing(c: NetworkCall): boolean {
  return c.statusCode === null || c.statusCode === undefined || c.statusCode >= 400;
}

function statusText(c: NetworkCall): string | number {
  return c.statusCode ?? (c.error ? c.error.replace('_', ' ') : 'network error');
}

function sortOldest<T>(items: T[], timeOf: (item: T) => string | undefined): T[] {
  return items
    .map((item, index) => ({ item, index, t: timeMs(timeOf(item)) }))
    .sort((a, b) => {
      const ta = Number.isNaN(a.t) ? Number.POSITIVE_INFINITY : a.t;
      const tb = Number.isNaN(b.t) ? Number.POSITIVE_INFINITY : b.t;
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map((e) => e.item);
}

function bodyLine(
  label: string,
  b: CapturedBody | null | undefined,
  textLimit: number | null,
): string | null {
  if (!b) return null;
  if (b.text != null) {
    const text =
      textLimit != null && b.text.length > textLimit ? `${b.text.slice(0, textLimit)}…` : b.text;
    return `    ${label} (${b.contentType ?? 'unknown type'}${b.truncated ? ', truncated' : ''}): ${text}`;
  }
  if (b.omitted) return `    ${label}: omitted (${b.omitted})`;
  return null;
}

export function formatCaptureSection(pc: PageContextDto): string {
  const calls = sortOldest(pc.networkCalls ?? [], callTime);
  const consoleAll = sortOldest(pc.consoleEntries ?? [], (c) => c.occurredAt);
  const steps = sortOldest(pc.stepEntries ?? [], (s) => s.occurredAt);

  const render = (red: Reductions): string => {
    const lines: string[] = [];

    let header = `Bug report: ${pc.windowSeconds ?? '?'} s before the comment until it was sent`;
    if ((pc.droppedEntryCount ?? 0) > 0) {
      header += `; ${pc.droppedEntryCount} entries omitted by the size limits`;
    }
    lines.push(`${header}.`);

    const allFailing = calls.filter(failing);
    const failingCalls = allFailing.slice(0, allFailing.length - red.droppedFailing);
    if (allFailing.length > 0) {
      lines.push('Failing calls:');
      for (const [index, c] of failingCalls.entries()) {
        const bare = index >= failingCalls.length - red.strippedFailing;
        let line = `  ${c.method} ${c.url} → ${statusText(c)} (${c.durationMs ?? 0} ms)`;
        if ((c.repeatCount ?? 0) > 1) line += ` ×${c.repeatCount}`;
        if (c.denied) line += ' (endpoint excluded by the project: no headers or bodies)';
        lines.push(line);
        if (bare) continue;
        const reqHeaders = c.requestHeaders ?? [];
        if (reqHeaders.length > 0) {
          lines.push(
            `    request headers: ${reqHeaders.map((h) => `${h.name}: ${h.value}`).join(', ')}`,
          );
        }
        const resHeaders = c.responseHeaders ?? [];
        if (resHeaders.length > 0) {
          lines.push(
            `    response headers: ${resHeaders.map((h) => `${h.name}: ${h.value}`).join(', ')}`,
          );
        }
        const reqBody = bodyLine('request body', c.requestBody, red.bodyTextLimit);
        if (reqBody) lines.push(reqBody);
        const resBody = bodyLine('response body', c.responseBody, red.bodyTextLimit);
        if (resBody) lines.push(resBody);
      }
      if (red.droppedFailing > 0) {
        lines.push(`  … ${red.droppedFailing} more failing calls omitted`);
      }
    }

    let consoleEntries = consoleAll;
    if (red.consoleErrorsOnly) {
      consoleEntries = consoleAll.filter((c) => c.level === 'error').slice(-CONSOLE_REDUCED_MAX);
    }
    if (consoleEntries.length > 0) {
      lines.push('Console:');
      for (const c of consoleEntries) {
        const r = rel(pc, c.occurredAt);
        lines.push(`  ${r ? `${r} ` : ''}[${c.level ?? 'info'}] ${c.message}`);
        if (!red.consoleErrorsOnly && c.stack) {
          for (const sl of c.stack.split(/\r?\n/).slice(0, STACK_MAX_LINES)) {
            lines.push(`      ${sl}`);
          }
        }
      }
    }

    const shownSteps = steps.slice(-red.stepLimit);
    if (shownSteps.length > 0) {
      lines.push(`Steps (last ${red.stepLimit}):`);
      for (const s of shownSteps) {
        const r = rel(pc, s.occurredAt);
        if (s.kind === 'click') {
          lines.push(`  ${r} click ${s.selector ?? ''}${s.label ? ` "${s.label}"` : ''}`);
        } else if (s.kind === 'input') {
          lines.push(
            s.masked
              ? `  ${r} input (masked field)`
              : `  ${r} input ${s.selector ?? ''}${s.valueLength != null ? ` (${s.valueLength} chars)` : ''}`,
          );
        } else if (s.kind === 'change') {
          lines.push(
            s.masked
              ? `  ${r} change (masked field)`
              : `  ${r} change ${s.selector ?? ''}${s.label ? ` "${s.label}"` : ''}`,
          );
        } else if (s.kind === 'route') {
          lines.push(`  ${r} route ${s.path ?? ''}${s.title ? ` "${s.title}"` : ''}`);
        }
      }
    }

    const timeline: TimelineItem[] = [];
    for (const c of calls) {
      const r = rel(pc, callTime(c));
      timeline.push({
        t: relSeconds(pc, callTime(c)),
        line:
          `  ${r.padStart(7)}  ${c.method.padEnd(6)} ${c.url}  ${statusText(c)}  ${c.durationMs ?? 0} ms` +
          `${failing(c) ? '  FAILED' : ''}${(c.repeatCount ?? 0) > 1 ? `  ×${c.repeatCount}` : ''}`,
      });
    }
    for (const c of consoleEntries) {
      const r = rel(pc, c.occurredAt);
      timeline.push({
        t: relSeconds(pc, c.occurredAt),
        line: `  ${r.padStart(7)}  console.${c.level ?? 'info'} ${c.message.slice(0, TIMELINE_MESSAGE_MAX_CHARS)}`,
      });
    }
    timeline.sort((a, b) => {
      const ta = Number.isNaN(a.t) ? Number.POSITIVE_INFINITY : a.t;
      const tb = Number.isNaN(b.t) ? Number.POSITIVE_INFINITY : b.t;
      return ta === tb ? 0 : ta - tb;
    });

    const kept = timeline.slice(red.droppedTimelineLines);
    const markerAt = kept.filter((e) => e.t < 0).length;
    lines.push('Timeline:');
    if (red.droppedTimelineLines > 0) {
      lines.push(`  … ${red.droppedTimelineLines} earlier timeline lines omitted`);
    }
    for (let i = 0; i < kept.length; i++) {
      if (i === markerAt) lines.push(`  ${'0.0s'.padStart(7)}  ── comment ──`);
      lines.push(kept[i].line);
    }
    if (markerAt >= kept.length) lines.push(`  ${'0.0s'.padStart(7)}  ── comment ──`);

    return lines.join('\n');
  };

  const red: Reductions = {
    droppedTimelineLines: 0,
    stepLimit: STEPS_FULL,
    consoleErrorsOnly: false,
    bodyTextLimit: null,
    strippedFailing: 0,
    droppedFailing: 0,
  };

  let text = render(red);
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  const droppable = calls.length + consoleAll.length;
  while (text.length > CAPTURE_PROMPT_MAX_CHARS && red.droppedTimelineLines < droppable) {
    red.droppedTimelineLines += 1;
    text = render(red);
  }
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  red.stepLimit = STEPS_REDUCED;
  text = render(red);
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  red.consoleErrorsOnly = true;
  text = render(red);
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  red.bodyTextLimit = BODY_TEXT_CUT_CHARS;
  text = render(red);
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  const failingCount = calls.filter(failing).length;
  while (text.length > CAPTURE_PROMPT_MAX_CHARS && red.strippedFailing < failingCount) {
    red.strippedFailing += 1;
    text = render(red);
  }
  while (text.length > CAPTURE_PROMPT_MAX_CHARS && red.droppedFailing < failingCount) {
    red.droppedFailing += 1;
    text = render(red);
  }
  if (text.length <= CAPTURE_PROMPT_MAX_CHARS) return text;

  return `${text.slice(0, CAPTURE_PROMPT_MAX_CHARS)}\n… [capture cut to ${CAPTURE_PROMPT_MAX_CHARS} characters]`;
}
