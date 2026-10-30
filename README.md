# dsh-pitfall-memory

> Long-term failure memory for DeepSeek Harness: records tool failures as they happen, folds them into
> reusable lessons, and injects a short briefing into later sessions so the same pitfall is hit once.

It is not a replacement for `AGENTS.md`. `AGENTS.md` holds rules you wrote by hand; this plugin grows
the rules your hand-written file has not covered yet, from what actually failed at runtime.

中文说明见 [README.zh.md](./README.zh.md)。

## What it does

Four-layer convergence, computed on every read — nothing here is a separately hand-written document:

```
L1 observation   raw failure evidence: command, output, exit code
        │  rule classification + signature normalization
L2 lesson        one row per signature: symptom + the fix, with an occurrence count
        │  grouped by root cause
L3 pattern       why this area keeps failing (restricted token / sandbox boundary / runtime resolution …)
        │  first sentence of each fix, ranked by severity
L4 rule          the executable short list shown first in the briefing
```

Three summary periods:

| period | trigger | artifact |
| --- | --- | --- |
| per session | `agent/disposed` and plugin teardown | `summaries/session-<id>.md`: captured, new, re-offended |
| daily | lazy, on the first briefing render of the day | `summaries/daily-YYYY-MM-DD.md`: root-cause ranking, highlights |
| weekly | lazy, once the ISO week rolls over | `summaries/weekly-YYYY-Www.md`: 7-day roll-up plus rules worth promoting into `AGENTS.md` |

## Install

```bash
node scripts/install.mjs --dry-run      # preview the plan
node scripts/install.mjs                # copy into <profile>/node_modules and add to dsh.profile.bundles
```

Then restart DSH. The briefing and the `pitfall_*` tools appear right away; the **settings page needs
the restart**, because `dsh-client-modules` scans `dsh.client` declarations only at process start.

## Injection channel

The briefing is registered as a dynamic context section:

```js
ctx.inject(['systemPrompt'], (scope) => {
  scope.systemPrompt.context({ name: 'pitfall:briefing', order: 950, text: render })
})
```

It rides along with the `Current runtime context` snapshot of every request, so it works regardless of
when the plugin was loaded — including sessions restored after a restart.

> A note for plugin authors: returning extra `messages` from an `agent/pre-step` waterfall listener is
> **not** enough — in testing, the constructed messages never reached the session log. Use
> `systemPrompt.context`, which is what the in-box `sandbox-policy`, `user-approval` and `subagent`
> plugins do.

## Web settings page

**Settings → Plugins → Pitfall memory**, two tabs (requires the DSH restart to appear):

- **Lessons** — counts, a status filter, expandable symptom/fix per row, and re-activate / resolve /
  mute actions.
- **Summaries** — the latest daily and weekly summary, with a regenerate button.

The host half mounts plain JSON endpoints through `webServer.register`:

| endpoint | method | purpose |
| --- | --- | --- |
| `/dsh-pitfall-memory/api/overview` | GET | counts, status split, rule cards, heartbeat |
| `/dsh-pitfall-memory/api/list` | GET | lessons (`?status=`, `?category=`) |
| `/dsh-pitfall-memory/api/summaries` | GET | latest daily / weekly |
| `/dsh-pitfall-memory/api/set-status` | POST | `{ id, status }` |
| `/dsh-pitfall-memory/api/refresh` | POST | recompute daily + weekly |

A request carrying an `Origin` header must match the loopback `Host`, otherwise it gets 403.

## Tools

| tool | purpose |
| --- | --- |
| `pitfall_list` | list lessons (by status / category / project scope) |
| `pitfall_remember` | record a "root cause + fix" the model worked out |
| `pitfall_resolve` | mark resolved / muted / active |
| `pitfall_review` | review the current session: new, repeated, or resolved-then-reoffended |
| `pitfall_summary` | generate or read the session / daily / weekly summary |

## Built-in rules

16 classification rules cover the failure classes this kind of environment actually produces: sandbox
boundary violations, restricted-token operations (pipes, `pip`, `mkdtemp`), runtime resolution
(store-aliased `python`), CJK encoding, Git identity, network and credential errors, unknown tools, and
a generic non-zero-exit fallback. Anything unrecognized lands in one of the two fallbacks instead of
being dropped.

On first run the store is seeded with 14 lessons describing this environment's known pitfalls, so the
very first session already has something to inject.

## Configuration

Line config lives in `cordis.patch.yml` and can be overridden per id `pitfall-memory` in the profile's
own patch file:

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `seed` | `true` | seed known pitfalls when the store is empty |
| `summaries` | `true` | session / daily / weekly summaries |
| `capture` | `true` | capture tool failures |
| `inject` | `true` | render the briefing as a dynamic context |
| `maxLessons` | `12` | lessons in the "other frequent" section |
| `maxInjectBytes` | `6000` | UTF-8 byte ceiling for the briefing |
| `minOccurrences` | `1` | minimum occurrences before a lesson is injected |
| `injectIntoSubagents` | `false` | also brief subagent sessions |
| `repeatWarn` | `true` | one-line reminder when a signature repeats within a session |
| `projectScoped` | `true` | only this project's lessons plus global ones |
| `maxFindingsPerSession` | `200` | per-session capture cap |
| `maxLessonsStored` | `300` | store cap (seed and manual lessons are never evicted) |
| `storeDir` | empty | storage dir; empty = `<profile>/.dsh-pitfall-memory` |
| `captureTools` | `[]` | capture only these tools (empty = all) |

## Storage

`<profile>/.dsh-pitfall-memory/`:

| file | content |
| --- | --- |
| `lessons.json` | structured lesson store (source of truth) |
| `lessons.md` | human-readable list with a rule-card section |
| `observations.ndjson` | raw failure evidence (append-only, rotates at 1 MB) |
| `state.json` | roll-up progress (`lastDaily` / `lastWeekly`) |
| `summaries/` | session, daily and weekly summaries (json + md) |
| `.heartbeat.jsonl` | load and render heartbeats — the first stop when something "does not work" |

A lesson belongs to a project, whose root is the nearest ancestor containing `.git` or `AGENTS.md`;
lessons recorded with `scope: global` apply everywhere.

## Troubleshooting

Run `node scripts/doctor.mjs`. It reports, in order:

1. bundle mounted and files copied;
2. lesson store present, with counts;
3. heartbeat truth: `apply-ok` (loaded?) → `context-render` (rendering?) → `settings-api-mounted`
   (settings backend?);
4. `dsh.client` declaration ready, with the restart reminder.

The same order works by hand on `.heartbeat.jsonl`.

## Tests

```bash
node test/detect.test.mjs          # 16 — rule classification
node test/store.test.mjs           # 7  — merging, persistence, pruning
node test/render.test.mjs          # 6  — briefing rendering and byte caps
node test/summary.test.mjs         # 8  — four-layer convergence, daily/weekly
node test/smoke.test.mjs           # 6  — capture → store → inject → tools, end to end
node test/settings-api.test.mjs    # 4  — projections, routing, Origin checks
node test/client.test.mjs          # 3  — browser bundle exports, slot registration, render
```

50 tests, all plain Node with no DSH runtime required. Run the files individually: `node --test test/`
spawns child processes and fails with `EPERM` under a restricted token on Windows.

## License

MIT
