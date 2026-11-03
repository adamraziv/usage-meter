# usage-meter

A Claude Code mod that shows a band above the prompt with:

- **5h / 7d / per-model weekly (e.g. Fable) limits**: bars, % used, and a live countdown to reset
- **Run-out prediction**: when a limit is on pace to run out before it resets, the time left turns yellow (red when under an hour), e.g. `↻ 2h10m/48m`
- **Session cost, today's cost and cache-hit %**
- Current folder and git branch

## Install

In Claude Code:

```
/plugin marketplace add adamraziv/usage-meter
/plugin install usage-meter@usage-meter
```

## The helper

Today's spend, cache %, folder/branch and the per-model weekly limits come from a small Rust helper.
A prebuilt binary for **Apple Silicon macOS** is in `bin/`. On any other platform, build it (needs Rust):

```
sh helper/build.sh
```

Without the helper, the 5h/7d bars, countdowns and predictions still work.

## Good to know

- Every 5 minutes it runs `claude -p /usage` in the background (no model call) to refresh account limits.
- It reads `~/.claude.json` for the per-model weekly limits the app last fetched.
