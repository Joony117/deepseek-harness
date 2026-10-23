# Possible bugs: compaction tool-call nudge (#5521)

Fix reference: branch `fix/compaction-tool-choice`, discussion #5521.
Code: `summarizeWithLlm` in `packages/compaction/compaction-basic/src/summarizer.ts`.

The fix: when the compaction model answers the summary instruction with only
tool calls, the harness asks once more with the same request plus one user
message ("Tool calls are disabled ... output only the checkpoint text"). The
first answer is logged as `rejectedOutput` on `compaction/summary`, and replay
plays both calls in order.

Each entry: what can go wrong, which change causes it, how to spot it.

## Caused by the nudge

1. **One extra model call per affected compaction.**
   Cause: the re-ask in `summarizeWithLlm`.
   Spot: `compaction/summary` events that carry `rejectedOutput`. The re-ask
   reuses the cached prefix, so the cost is the instruction, the nudge and the
   output, not the whole history.

2. **The first call's token usage is not recorded.**
   Cause: only the second call's `usage` goes on the event (deliberate
   simplification). Token accounting under-counts compactions that re-asked.
   Fix if it matters: sum both usages, or add `rejectedUsage`.

3. **The model calls a tool again on the re-ask.**
   Cause: the nudge is advisory; tools stay in the request to keep the cache warm.
   Result: compaction throws "summarization produced no text summary content",
   same as before the fix. There is exactly one re-ask, by design.

4. **The model writes the tool call as plain text.**
   Cause: the harness only checks for non-empty text. Text such as
   `<tool_call>{...}</tool_call>` passes and becomes a junk checkpoint.
   Spot: a `<compacted-summary>` that holds tool-call markup. Not handled.

5. **Thinking-budget interplay (#3465, shelved).**
   Cause: if the model spends its output cap on reasoning, both calls can come
   back empty or tool-only. The nudge does not raise the cap.

6. **Persistence field and replay order.**
   Cause: new optional `rejectedOutput` on `compaction/summary`
   (`packages/compaction/compaction/src/types.ts`, record
   `docs/persistence-changes/2026-10-10-compaction-rejected-output.md`).
   `deriveReplayScript` in `packages/test-support/llm-replay/src/index.ts`
   emits the rejected call first. Any other reader that assumes one LLM call
   per `compaction/summary` (cost tools, log analyzers) is now wrong for these
   events.

7. **Pressure backoff only sees throws.**
   Cause: the compaction-pressure retry logic (fix/compaction-pressure) counts
   failed compactions. A re-ask that succeeds is not a failure, so slow
   compactions caused by the extra call are invisible to it.

8. **Both calls sit inside one `compaction/start` / `compaction/end` pair.**
   Cause: deliberate, so `recordAutomaticFailure` reads the log the same way.
   If someone moves the re-ask outside `summarize()` (for example into
   `index.ts`), it would open a second pair and change that reading.

## Background: why not `toolChoice: "none"`

9. **ninfer drops tools on `tool_choice: "none"`.**
   ninfer-serve (`E:\ninfer-4090`, `src/serve/translate.cpp`) treats "none" as
   "no tools", removes them from the system block, and the prefix cache goes
   cold. Any future change that sends "none" to ninfer, or changes the tools
   list on the summary or nudge request, loses the cache.

10. **llama.cpp "none" only disables parsing.**
    Tools stay rendered, so the model can still emit tool-call text, which then
    lands as plain text (see 4).

11. **ninfer parses `logit_bias` but does not apply it.**
    The GPU sampler has no bias input, so banning the tool-call token there is
    not a fix today.

The old `toolChoice: "none"` work is kept on branch
`backup/compaction-tool-choice-none`.

## Related gap (not caused by this fix)

12. **Web preset ignores host compaction config.**
    `packages/bundle/web-app/cordis.patch.yml` disables the host
    `compaction-basic`; each preset in `packages/bundle/web-app/presets/`
    mounts its own copy with no config. Settings put on the host instance never
    reach Web sessions. Nothing is configured there today, so it is latent.
