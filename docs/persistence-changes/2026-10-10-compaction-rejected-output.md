---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-compaction-rejected-output

English | [中文](2026-10-10-compaction-rejected-output.zh.md)

## Summary

compaction/summary gains optional rejectedOutput: the output of a first summarization call that held only tool calls, before the single re-ask whose output is rawOutput.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-compaction-rejected-output
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "7aefda7246ea473759f90a32b9b198c964ada08b88d259ca9cdd76494e5ad1bb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Optional and additive. Older sessions omit it and replay as one call; readers that ignore it still see a valid summary event.

<a id="verification"></a>
## Verification

compaction-basic and llm-replay tests cover the re-ask, the event field, and two-call replay ordering.

<a id="dev-note"></a>
## Dev Note

None.
