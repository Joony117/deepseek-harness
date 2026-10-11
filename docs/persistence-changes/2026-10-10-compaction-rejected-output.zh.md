---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-compaction-rejected-output

[English](2026-10-10-compaction-rejected-output.md) | 中文

## 概述

compaction/summary 新增可选字段 rejectedOutput：首次摘要调用只返回工具调用时的输出；随后重问一次，其输出为 rawOutput。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

可选且仅追加。旧会话不含该字段，按单次调用回放；忽略该字段的读取方仍看到有效的摘要事件。

<a id="verification"></a>
## 验证

compaction-basic 与 llm-replay 测试覆盖重问、事件字段以及两次调用的回放顺序。

<a id="dev-note"></a>
## 开发备注

无。
