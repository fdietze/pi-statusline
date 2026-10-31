export function formatWindow(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function formatResetCountdown(resetAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

// Milliseconds until formatResetCountdown(resetAt) shows different text, or undefined once it
// reads "now". Its whole-minute ceil drops exactly when resetAt - now reaches a multiple of 60 s;
// stepping over those boundaries until the text differs makes a timer armed with this delay wake
// only on visible changes: per minute below 1 day, per hour above (CPU deep sleep). Bounded by
// 60 steps because the coarsest format ("NdMh") changes at least hourly.
export function msUntilResetCountdownChange(resetAt: number, now = Date.now()): number | undefined {
  const remaining = resetAt - now;
  if (!(remaining > 0)) return undefined;
  const shown = formatResetCountdown(resetAt, now);
  let delay = remaining - (Math.ceil(remaining / 60_000) - 1) * 60_000;
  while (formatResetCountdown(resetAt, now + delay) === shown) delay += 60_000;
  return delay;
}
