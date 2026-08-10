# AGENTS.md

pi-statusline: a configurable status footer extension for [pi](https://github.com/earendil-works/pi-mono).

## Commands

- `nix develop` — enter the pinned Node 24 development shell; Git is expected from the host
- `npm ci` — install the exact JavaScript/TypeScript dependencies from `package-lock.json`
- `npm test` — run tests (`node --test test/*.test.ts`)
- `npm run typecheck` — `tsc --noEmit`
- `pi --no-extensions -e .` — try only this extension from the working tree
- `pi` — from this repository, `.pi/settings.json` replaces an installed `futile/pi-statusline` with the working tree after project trust is approved

## Layout

- `extensions/statusline.ts` — pi extension entry point (registers the footer + `/statusline` command)
- `src/` — segment logic (`bar`, `config`, `derive`, `format`, `git`, `ratelimit`, `segments`, `throughput`)
- `test/` — one test file per `src/` module

<!-- BEGIN COMPOUND PI TOOL MAP -->
## Compound Engineering (Pi compatibility)

This block is added by the pi-compound-engineering package.

Pi extensions used by skills shipped by this package:
- Required for full functionality: `pi-subagents` (by nicobailon) provides the `subagent` tool used by ce-compound, ce-code-review, ce-plan, ce-compound-refresh, and other parallel-agent skills.
- Recommended: `pi-ask-user` (by edlsh) provides the `ask_user` tool; skills fall back to numbered options in chat when it is missing.

Install with:
  pi install npm:pi-subagents
  pi install npm:pi-ask-user
<!-- END COMPOUND PI TOOL MAP -->
