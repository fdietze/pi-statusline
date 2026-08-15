# @shvax/pi-statusline

A configurable, single-line footer for [pi](https://github.com/earendil-works/pi-mono). It uses the active pi theme for semantic colors, shows only the data available for the active model and provider, includes statuses published by other extensions, and drops lower-priority segments before truncating at narrow widths.

```text
📁 pi-statusline  main ✓ > 🤖 qwen36-coder > 🧠 medium > 🪟  55.0%/1.0M > ⚡↑1.2k ↓74 t/s > ⏳ 12m34s
📁 pi-statusline  main ↑2 > 🤖 claude-sonnet-5 > 🧠 high > FAST > 🪟  30.2%/200K > 5h ╺━━────────╴ 23% ↻2h14m wk ╺━━━━──────╴ 41% ↻4d6h > ⏳ 8m02s
📁 pi-statusline  main ✓ > 🤖 gpt-5 > 🧠 high > 🪟  12.0%/400K > 🧾 ↑128K ↓34K $0.512 > ⏳ 3m20s
anthropic 5h ╺━━━━━━━━━━╸ 100% ↻1h44m >wk ╺──────────╴ 12% ↻6d5h
openai-codex wk ╺━━━━──────╴ 38% ↻4d14h ≈3pp over
zai 5h ╶──────────╴ 0% >wk ╺──────────╴ 5% ↻2d19h
```

The first line is a local model (live token rates), the second an Anthropic subscription (quota bars, no throughput at idle), the third an API-key provider (running token totals and session cost). See [Throughput and time](#throughput-and-time). The last three lines are provider-tracking rows: every provider you select in `/statusline` (not just your active model) gets its own row with its own live usage, so you can compare available capacity across providers without switching. See [Provider tracking](#provider-tracking).

Usage is a thin continuous line with rounded half-line ends and a dark-gray track. Its bright truecolor fill gives a restrained glow, moving smoothly from neon green through vivid orange to blood red as usage rises. Each provider-reported window includes a compact live reset countdown. When Codex also reports the window duration, the footer compares consumed usage with the elapsed share of the window and appends an approximate `over`, `under`, or measured `on pace` value such as `≈0.6pp on pace`; it does not show a per-day allowance.

## Install

```bash
pi install npm:@shvax/pi-statusline
```

Try only a local checkout without installed extensions:

```bash
pi --no-extensions -e .
```

This fork also commits a project-local `.pi/settings.json`. When Pi is launched
from the repository and the project is trusted, that configuration disables the
globally installed `futile/pi-statusline` extension and loads the working tree
instead. Other installed extensions remain available, and Pi launched outside
the repository continues to use the commit-pinned Git package. Run `npm ci`
first so the working tree has its runtime dependencies.

## Segments

At full width, segments render in the order below. When the line no longer fits, the configured narrow-drop priority removes segments one at a time; by default `time` drops first and `context` is retained until last.

| Segment | Default | Contents |
|---|---:|---|
| `project` | on | Current directory name and compact Git HUD |
| `model` | on | Active model id |
| `effort` | on | Thinking level; hidden for non-reasoning models |
| `extensions` | on | Statuses published through Pi's `ctx.ui.setStatus()`, preserving publisher order and styling |
| `context` | on | Context percent and window; green below 120K tokens, orange from 120K, red from 170K (75%/90% also warn for smaller windows) |
| `session` | on | Available subscription usage windows and reset countdowns; Codex labels come from the account's current limits |
| `throughput` | on | Token throughput, adapted to how the model is billed — live `↑/↓` rates, a running `🧾` token/cost ledger, or nothing (see below) |
| `time` | on | Live-ticking cumulative active agent time (foreground plus compatible background sources) |

The Git HUD defaults on inside repositories: `main ✓`. It shows `↓` incoming/behind and `↑` outgoing/ahead counts; `✓` means neither is pending. Local working-tree changes are intentionally ignored. Colors use the active theme's accent, success, warning, and error roles.

Extension statuses are read from Pi's footer data on every render, so a `ctx.ui.setStatus()` update appears without coupling this footer to a particular extension. Multiple statuses retain Pi's map order and any ANSI styling supplied by their publishers. They are dropped only after the other default narrow-priority segments when the terminal cannot fit them.

Status keys listed in `layout.rightAlignedExtensionStatuses` are removed from the ordinary extension segment and placed at the far right only when the complete left side leaves enough spare width. They render in configured order with the main separator; when the full cluster is too wide, values drop from the left so the rightmost keys survive. The default `["ponytail", "mcp"]` renders `🐴 ponytail: MODE > 🔌 MCP N/N`, omitting Ponytail's leading idle/busy circle and dropping Ponytail before MCP under width pressure. The MCP glyph follows the global icon style and can be overridden with `icons.symbols.mcp`; statuses such as Fast remain inline. Set the list to `[]` to keep every extension status inline.

The keyed `fast` status has a small presentation adapter: its publisher supplies plain `fast`, while the default emoji and Nerd Font styles render `⚡ fast` inline after the effort segment with the text in the theme's warning color. Override the glyph with `icons.symbols.fast`; other status keys remain generic and publisher-styled.

Icons default to the **emoji** style. The **Icons** section of `/statusline` switches the whole line to Nerd Font, Unicode, ASCII, minimal, or none (ASCII and none are safe fallbacks for terminals without glyph support), and overrides the symbols the footer actually renders plus provider icons. Optional extras default off: `cost` (appends session `$cost` to the model segment), `sessionElapsed`, `lastTurn`, and `pending` — all toggleable in **Display**.

## Configure

Run `/statusline` to open the keyboard-driven settings app. It needs the interactive terminal UI: in TUI mode it opens the app, and any non-empty argument gets a deterministic "no arguments" notice; in RPC/JSON/print mode it reports that settings require the interactive terminal UI instead of silently doing nothing. The legacy `on`/`off`/`toggle <segment>` argument shortcuts have been removed — every control now lives in the app.

The app has three sections:

| Section | Controls |
|---|---|
| **Statusline & Providers** | Master footer and provider-tracking toggles; enable, reorder, refresh, and configure each provider's active-model segments and available quota windows. |
| **Display** | Segment visibility and extras (Git HUD, cost, elapsed/last-turn time, pending); segment order and narrow-drop priority; live separators/spacing/padding; bar style, characters, width, truecolor and thresholds; context warning/critical thresholds. |
| **Icons** | Global icon style (emoji / unicode / ascii / nerd font / minimal / none), rendered symbol overrides, and per-provider icons. |

The app opens a draft cloned from your live settings, renders a live preview through the real footer renderer, and writes only on **Save**. Saving is persist-first: the file is written before the live settings are swapped, so a failed write changes nothing. **Escape** on a dirty draft offers Save / Discard / Cancel; a clean draft closes immediately. Root, section, and provider resets update only the draft until you save.

Settings persist as a versioned document in `~/.pi/agent/statusline.json`. An unversioned document from an earlier release is migrated once into the new shape on first load and becomes durable only on your next save. Schema-version-1 settings are upgraded in memory with the extension-status segment inserted into their existing custom order and drop priority; saving makes that upgrade durable. A document from a newer schema version than this extension supports opens read-only and is never overwritten. Provider refresh runs no faster than once every 10 seconds per provider (the settings preview itself performs no I/O, but the background coordinator keeps running and an eligible provider can be refreshed on demand); a shared cross-process cache (`~/.pi/agent/statusline/provider-usage/`) retains the last result for up to 5 minutes so a new session renders immediately and only one process fetches each provider.

## Provider tracking

Configure providers in **Statusline & Providers** under `/statusline`. It lists every provider returned by pi's configured `getAvailable()` models — whatever you're authenticated with, not a fixed list — and selects newly authenticated providers automatically while keeping your saved selection, order, and overrides.

For each provider you can toggle it on or off (its configuration is retained when turned back on), reorder it, override active-model segments, and configure each reported usage window's visibility, label, bar, percent, reset format, and width. A provider with no adapter, or one that is unauthorized, stays listed but shows a sanitized reason instead of a row — never a raw error, token, or credential.

Fresh selected providers render in that saved order beneath the active-session line, **simultaneously and independently of which model is currently active**—selecting both Anthropic and Codex shows both rows at once even while you're talking to a third provider. Every pi process shares fresh quotas through `~/.pi/agent/statusline/provider-usage/` (scoped per Codex account), so a new session renders the last result immediately and only one process fetches each provider/account every 10 seconds. A row is hidden when both enabled metrics are unavailable, or when its usage is missing, unauthorized, expired, or stale. The active provider's quota stays on its own row while visible and falls back to the plain session line otherwise, so it's never shown twice.

## Provider applicability

| Data | Local models | Anthropic subscription | OpenAI Codex subscription | Other cloud/API key |
|---|:---:|:---:|:---:|:---:|
| Project, model, effort, context | ✓ | ✓ | ✓ | ✓ |
| Available usage bars | — | ✓ | ✓ | — |
| Live token rates (`↑/↓`) | ✓ | — | — | — |
| Token totals + session cost | — | — | — | ✓ |
| Streaming `↓` speed pulse | ✓ | ✓ | ✓ | ✓ |
| Time | ✓ | ✓ | ✓ | ✓ |

Anthropic OAuth fetches its current `5h` and `wk` limits when the session starts, then updates them from response headers, and again in the background for provider tracking. Codex fetches its current account limits and shows only the windows returned by the account, labeled by duration. Reset countdowns appear for every Claude or Codex window that reports a reset time; absent data is omitted rather than rendered as `—`.

Quota bars and percentages show consumed usage. Codex pace is a separate heuristic: the footer treats `reset_at - limit_window_seconds` as the window start, compares actual consumed percentage with elapsed-window percentage, and marks the result approximate because the service does not explicitly guarantee fixed-window semantics. Pace stays hidden when duration/reset data is absent or invalid or after expiry.

Codex also shows approximate percentage points used during the current operational day (`≈Npp today`), whose local boundary is 05:00. It persists one latest per-account/window baseline in `~/.pi/agent/statusline/quota-history/openai-codex.json`; if pi sleeps through 05:00, the last observation from the preceding day becomes the boundary estimate. First use, multi-day gaps, and incompatible windows quietly start a new baseline, so unobserved use on another machine may be missing. This is deliberately separate from OpenAI's UTC daily token counters, which are tokens rather than subscription-quota percentages.

Any other provider you've authenticated (OpenRouter, custom endpoints, …) still appears in the Providers list, but has no adapter yet—pi-statusline only ever uses pi's own stored credentials for that provider. Concretely: OpenRouter's only usage endpoint (`/api/v1/credits`) explicitly rejects the regular inference key pi stores and requires a separate management key pi doesn't manage, so it shows that sanitized reason instead of a row.

GLM (Z.AI) is the one exception to "documented endpoint only": it uses `GET https://api.z.ai/api/monitor/usage/quota/limit`, which Z.AI has not published in its own API docs—only known from a third-party reverse-engineered tool. It works with pi's stored GLM key and reports the same `5h`/`wk` credit windows Z.AI documents for the Coding Plan (docs.z.ai/devpack/teamplan), but which of the two returned windows is which isn't labeled by the API either; pi-statusline infers it from reset-countdown behavior (see `parseZaiUsage` in `src/ratelimit.ts`) and hides the row entirely rather than guess if the response shape changes. Treat the GLM row as best-effort: Z.AI can change or remove this endpoint without notice.

## Throughput and time

The `⚡` segment adapts to how the active model is billed, because a token rate does not mean the same thing in every case:

- **Local models** (loopback/LAN endpoint) show live `↑`/`↓` token rates. `↓` is output tokens over the generation window (first update → message end, so tool execution time is excluded); `↑` is the prompt-processing rate (input tokens over turn start → first update). Both start at `0 t/s` and stay visible while idle. If the generation window is unavailable, `↓` falls back to output tokens over the whole turn.
- **API-key providers** show a running ledger while idle — `🧾 ↑<input> ↓<output> $<cost>` — cumulative session input and output tokens (cached and cache-write tokens folded into input) and total session cost. A per-token rate over a network is just request latency plus prompt caching, so it is dropped in favour of what you are actually spending.
- **Subscription providers** (Anthropic OAuth, OpenAI Codex) show nothing at idle; the `session` usage bars already track the only budget that matters — your quota window.
- **While a turn streams**, every hosted provider shows a live `↓ t/s` speed pulse so you can see generation is progressing and how fast.

Rate coloring compares each direction to its own recent same-model baseline: green at or above 90%, orange from 60–89%, and red below 60%. Until three samples are available it stays neutral; output at or below 15 t/s is always red. Changing models resets both rates and baselines.

Active time counts the wall-clock union of foreground turns and compatible background activity. Overlapping agents count once rather than multiplying time by thread count. Foreground prompt-wait, throughput, and optional last-turn duration retain their foreground-turn semantics. The timer stops when every activity source settles, including interrupted or failed work. Optional elapsed time remains wall-clock time since the session loaded.

### Background activity and terminal progress

Foreground extensions can publish version 1 source snapshots on Pi's shared `pi.agent-activity.v1:update` event channel with `{ version: 1, source, active, terminalProgress }`. The statusline requests current snapshots on `pi.agent-activity.v1:request` when a session starts, so extension load order does not lose live state. Raw `active` contributes to the union timer; `terminalProgress` contributes to OSC progress independently, allowing Pi's `showTerminalProgress` setting to disable OSC without disabling time accounting.

The footer arbitrates external progress with Pi's native foreground request through the existing terminal's `setProgress()` method. Pi's terminal remains the sole OSC 9;4 writer and keepalive owner. The multiplexer observes the shared terminal's `start()` lifecycle and reasserts an active aggregate after a renderer restart, without adding another timer or OSC writer.

## License

MIT
