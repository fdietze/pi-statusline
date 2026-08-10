import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import type { SegmentId, StatuslineSettings } from "./schema.ts";
import { parseStatuslineSettings } from "./validation.ts";

export interface SeparatorsScreenRow {
  id: string;
  label: string;
}

type Group = "segments" | "extras" | "layout" | "separators" | "bars" | "thresholds";
type Row = SeparatorsScreenRow & (
  | { kind: "toggle"; group: "segments" | "extras" | "bars"; field: string }
  | { kind: "order"; field: "segmentOrder" | "narrowPriority"; index: number }
  | { kind: "cycle"; group: "bars"; field: string; values: readonly string[] }
  | { kind: "number"; group: "separators" | "bars" | "thresholds"; field: string; step: number }
  | { kind: "text"; group: "separators" | "bars"; field: string }
  | { kind: "reset"; group: Group }
);

const SEGMENT_LABELS: Record<SegmentId, string> = {
  project: "Project / Git",
  model: "Model",
  effort: "Thinking",
  extensions: "Extension statuses",
  context: "Context",
  session: "Session quota",
  throughput: "Throughput",
  time: "Time",
};
const EXTRA_LABELS = {
  branch: "Git branch",
  cost: "Model session cost",
  sessionElapsed: "Elapsed time",
  lastTurn: "Last-turn time",
  pending: "Pending indicator",
} as const;
const BAR_STYLES = ["rounded", "block"] as const;

function shown(value: string): string {
  return JSON.stringify(value);
}

function rows(draft: StatuslineSettings): Row[] {
  const result: Row[] = [];
  for (const id of Object.keys(SEGMENT_LABELS) as SegmentId[]) {
    result.push({ id: `segments.${id}`, label: `${SEGMENT_LABELS[id]} visibility: ${draft.segments[id] ? "On" : "Off"}`, kind: "toggle", group: "segments", field: id });
  }
  for (const [field, label] of Object.entries(EXTRA_LABELS)) {
    result.push({ id: `extras.${field}`, label: `${label}: ${draft.extras[field as keyof typeof EXTRA_LABELS] ? "On" : "Off"}`, kind: "toggle", group: "extras", field });
  }
  draft.layout.segmentOrder.forEach((id, index) => result.push({ id: `layout.segmentOrder.${id}`, label: `Segment order ${index + 1}: ${SEGMENT_LABELS[id]}`, kind: "order", field: "segmentOrder", index }));
  draft.layout.narrowPriority.forEach((id, index) => result.push({ id: `layout.narrowPriority.${id}`, label: `Narrow priority ${index + 1}: ${SEGMENT_LABELS[id]}`, kind: "order", field: "narrowPriority", index }));
  for (const [field, label] of [
    ["main", "Main separator"],
    ["projectGit", "Project / Git separator"],
    ["padding", "Separator padding"],
  ] as const) result.push({ id: `separators.${field}`, label: `${label}: ${shown(draft.separators[field])}`, kind: "text", group: "separators", field });
  for (const [field, label] of [
    ["spacingBefore", "Spacing before"], ["spacingAfter", "Spacing after"], ["trailingSpacing", "Trailing spacing"],
  ] as const) result.push({ id: `separators.${field}`, label: `${label}: ${draft.separators[field]}`, kind: "number", group: "separators", field, step: 1 });
  result.push(
    { id: "bars.width", label: `Bar width: ${draft.bars.width}`, kind: "number", group: "bars", field: "width", step: 1 },
    ...(["fill", "empty", "capLeft", "capRight"] as const).map((field): Row => ({ id: `bars.${field}`, label: `Bar ${field}: ${shown(draft.bars[field])}`, kind: "text", group: "bars", field })),
    { id: "bars.showPercent", label: `Bar percentage: ${draft.bars.showPercent ? "On" : "Off"}`, kind: "toggle", group: "bars", field: "showPercent" },
    { id: "bars.style", label: `Bar style: ${draft.bars.style}`, kind: "cycle", group: "bars", field: "style", values: BAR_STYLES },
    { id: "bars.truecolor", label: `Bar truecolor: ${draft.bars.truecolor ? "On" : "Off"}`, kind: "toggle", group: "bars", field: "truecolor" },
    { id: "bars.warnAt", label: `Bar warning threshold: ${draft.bars.warnAt}`, kind: "number", group: "bars", field: "warnAt", step: 1 },
    { id: "bars.critAt", label: `Bar critical threshold: ${draft.bars.critAt}`, kind: "number", group: "bars", field: "critAt", step: 1 },
    { id: "thresholds.contextWarn", label: `Context warning threshold: ${draft.thresholds.contextWarn}`, kind: "number", group: "thresholds", field: "contextWarn", step: 1 },
    { id: "thresholds.contextCrit", label: `Context critical threshold: ${draft.thresholds.contextCrit}`, kind: "number", group: "thresholds", field: "contextCrit", step: 1 },
  );
  for (const group of ["segments", "extras", "layout", "separators", "bars", "thresholds"] as const) {
    result.push({ id: `reset.${group}`, label: `Reset ${group} to defaults`, kind: "reset", group });
  }
  return result;
}

export function buildSeparatorsScreen(draft: StatuslineSettings): readonly SeparatorsScreenRow[] {
  return rows(draft);
}

function cycle(values: readonly string[], current: string, backwards: boolean): string {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + (backwards ? values.length - 1 : 1)) % values.length];
}

// ponytail: allowlist, not denylist — a denylist leaks unknown named keys (Ctrl+ArrowUp, Tab, F1) into the field as literal text.
function isTextInput(key: string): boolean {
  if (key === "Backspace" || key === "Space" || key === " ") return true;
  return key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) !== 0x7f;
}

export function routeSeparatorsKey(
  draft: StatuslineSettings,
  selected: number,
  key: string,
): { draft: StatuslineSettings; selected: number } {
  const screenRows = rows(draft);
  const row = screenRows[selected];
  if (!row) return { draft, selected };
  if (row.kind === "text" && isTextInput(key)) {
    const next = structuredClone(draft);
    const group = next[row.group] as unknown as Record<string, string>;
    const ch = key === "Space" ? " " : key;
    group[row.field] = key === "Backspace" ? group[row.field].slice(0, -1) : group[row.field] + ch;
    const parsed = parseStatuslineSettings({ ...DEFAULT_STATUSLINE_SETTINGS, [row.group]: next[row.group] }).settings;
    if (row.group === "separators") {
      (next.separators as unknown as Record<string, unknown>)[row.field] = parsed.separators[row.field as keyof typeof parsed.separators];
    } else {
      next.bars = parsed.bars;
    }
    return { draft: next, selected };
  }
  if (key === "ArrowUp" || key === "k") return { draft, selected: Math.max(0, selected - 1) };
  if (key === "ArrowDown" || key === "j") return { draft, selected: Math.min(screenRows.length - 1, selected + 1) };
  if (key === "Home") return { draft, selected: 0 };
  if (key === "End") return { draft, selected: Math.max(0, screenRows.length - 1) };

  const backwards = key === "ArrowLeft" || key === "h";
  const forwards = key === "ArrowRight" || key === "l" || key === "Enter" || key === " " || key === "Space";
  const direction = key === "Ctrl+ArrowUp" || key === "Ctrl+Up" ? -1 : key === "Ctrl+ArrowDown" || key === "Ctrl+Down" ? 1 : 0;
  const next = structuredClone(draft);

  if (row.kind === "order" && direction) {
    const order = next.layout[row.field];
    const target = row.index + direction;
    if (target >= 0 && target < order.length) {
      [order[row.index], order[target]] = [order[target], order[row.index]];
      return { draft: next, selected: selected + direction };
    }
    return { draft, selected };
  }
  if (row.kind === "toggle" && forwards) {
    const group = next[row.group] as unknown as Record<string, boolean>;
    group[row.field] = !group[row.field];
  } else if (row.kind === "cycle" && (forwards || backwards)) {
    const group = next[row.group] as unknown as Record<string, string>;
    group[row.field] = cycle(row.values, group[row.field], backwards);
  } else if (row.kind === "number" && (forwards || backwards)) {
    const group = next[row.group] as unknown as Record<string, number>;
    group[row.field] += backwards ? -row.step : row.step;
  } else if (row.kind === "reset" && forwards) {
    (next as unknown as Record<Group, unknown>)[row.group] = structuredClone(DEFAULT_STATUSLINE_SETTINGS[row.group]);
  } else {
    return { draft, selected };
  }
  if (row.kind !== "reset") {
    const parsed = parseStatuslineSettings({ ...DEFAULT_STATUSLINE_SETTINGS, [row.group]: next[row.group] }).settings;
    if (row.group === "separators") {
      (next.separators as unknown as Record<string, unknown>)[row.field] = parsed.separators[row.field as keyof typeof parsed.separators];
    } else {
      (next as unknown as Record<Group, unknown>)[row.group] = parsed[row.group];
    }
  }
  return { draft: next, selected };
}
