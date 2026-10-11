# Qwen 27B e2e perf probe (fork-local)

Drives one headless dsh session against the local Qwen server through a recording
proxy and reports the audit's checks: effective compaction config, compactions vs
steps (with failures sorted into #5521 / #3465 / #7212-#8785), `reasoning_effort`,
`tool_choice` and `max_tokens` per request kind, cache-hit tokens and time to first
token for normal / compaction / post-tool-change / resumed requests, the 300 s idle
watchdog (#6553), and dsh's own Node heap (#4722).

```sh
# plumbing check, no GPU (scripted fake server)
node scripts/qwen-e2e/run.mjs --mock --scenario quick --label mock
# real run against the server on :8080, testing a built checkout
node scripts/qwen-e2e/run.mjs --scenario quick --harness E:/dsh-worktrees/<branch> --label <branch>
```

Scenarios: `smoke` (3 files), `quick` (24 files, declared window 120K so the default
65,536 headroom triggers compaction early), `full` (40 files, real 200K window).
The server keeps its real context either way; only what dsh believes changes.

How it measures:
- `proxy.mjs` sits on :8089 between dsh and the server and logs every chat request
  (effort, tools hash, shared-prefix length with the previous request) and the
  server's answer (TTFT, `cached_tokens`, `timings`, `finish_reason`).
- `dyn-mcp.mjs` is a tiny MCP server; the task makes the model call `add_tool`, which
  adds `extra_tool` mid-session, so the next request has a changed tool list (#935).
- A second process resumes the session with `--session-id` for the resumed-step numbers.
- `heap-sampler.mjs` is loaded via `NODE_OPTIONS=--import` and samples the dsh heap and GC.
- `analyze.mjs <runDir>` re-renders a saved run.
- `--save-bodies` keeps every request body; `prefix-diff.mjs <runDir>/bodies <a> <b>` shows
  where two requests stop sharing a prefix.
- `--inject '{"preserve_thinking":true}'` merges JSON into every request, for server-flag
  experiments without changing dsh.

Output: `.qwen-e2e-runs/<label>-<scenario>-<time>/report.md` (+ raw files).
The computed trigger mirrors rc.2's `compaction-basic/src/config.ts`; the measured
trigger is the prompt size the loop had reached when each compaction started.
