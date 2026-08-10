import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SEGMENT_ORDER = [
  "project",
  "model",
  "effort",
  "extensions",
  "context",
  "session",
  "throughput",
  "time",
] as const;

export type SegmentId = (typeof SEGMENT_ORDER)[number];

export interface Segment {
  id: SegmentId;
  enabled: boolean;
  render: () => string;
}

export function createSegments(
  enabled: Record<SegmentId, boolean>,
  renderers: Record<SegmentId, () => string>,
): Segment[] {
  return SEGMENT_ORDER.map((id) => ({ id, enabled: enabled[id], render: renderers[id] }));
}

const COMPACT_ORDER: SegmentId[] = ["context", "extensions", "session", "model", "effort", "project", "throughput", "time"];
const DROP_ORDER = COMPACT_ORDER.slice(1).reverse();

export function composeSegments(
  segments: Segment[],
  width: number,
  separator = " · ",
  dropOrder: readonly SegmentId[] = DROP_ORDER,
): string {
  if (width <= 0) return "";
  let parts = segments.flatMap((segment) => {
    if (!segment.enabled) return [];
    const value = segment.render();
    return value ? [{ id: segment.id, value }] : [];
  });
  const line = parts.map((part) => part.value).join(separator);
  if (visibleWidth(line) <= width) return line;

  for (const id of dropOrder) {
    parts = parts.filter((part) => part.id !== id);
    const compactLine = parts.map((part) => part.value).join(separator);
    if (visibleWidth(compactLine) <= width) return compactLine;
  }
  return truncateToWidth(parts.map((part) => part.value).join(separator), width, "");
}
