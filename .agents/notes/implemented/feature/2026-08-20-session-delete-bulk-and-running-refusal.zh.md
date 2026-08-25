# Agent Note: 会话删除的批量选择与运行中拒绝

Status: implemented

[English](2026-08-20-session-delete-bulk-and-running-refusal.md) | 中文

## 问题

host 会以 `session-delete-unavailable` 拒绝删除正在运行的 Session。若仅依赖这次确认后的拒绝，操作者在提交后才会从未翻译的传输字符串中得知须先停止会话。

显示标题重复时，只列出名称的确认不足以在一次操作中区分多份日志。不存在批量 `session.delete` RPC；树已经用 `aria-selected` 表示当前 Session，因此在行内做多选会与点击打开、拖拽排序冲突。

Workspace 注册删除仍是另一套生命周期：它只移除 Workspace 记录，从不删除 Session 日志（[Workspace 注册删除](2026-07-27-workspace-registration-deletion.zh.md)）。

## 决策

### 单会话运行中拒绝

现有行菜单路径保持不变。浏览器持有的确认框根据当前 `SessionSummary.running` 值渲染，并在按下 Confirm 时再次检查。该位为真时，对话框说明必须先停止该 Session，Confirm 禁用，且不调用 `deleteSession`。若 agent 在这次客户端读取之后才开始运行，仍由 host 作为 TOCTOU 权威拒绝。

### 批量选择器

宽侧栏区头控件打开由 `WorkspaceBrowser` 持有的第二个 `Modal`。选择器按 host `session.list` 顺序列出每个普通、未归档、非空白 Session。origin 为 subagent 的行、已归档 id 和空白「新会话」行被排除；不会仅因为 `runningSubagentCount` 非零而阻止 parent。每行显示确切的 `displayTitle` 和不透明 Session id。正在运行的行保持可见，其原生 `input type="checkbox"` 禁用，并显示本地化的运行中状态。继续要求至少勾选一个空闲 Session，并把这些 title+id 对快照进不可撤销的确认框。搜索结果行仍然没有删除控件。

### 顺序确认

Confirm 对快照中的每个 id 按快照顺序调用一次现有的 `deleteSession(sessionId)`，并等待每次调用结束。每次调用前浏览器会重新读取 `running`；若 Session 正在运行，则跳过 RPC 并使用同一份须先停止的文案。成功的 id 通过运行时现有的移除变更从树中消失。按目标失败的项留在确认框中，带有 `role="alert"` 以及抛出的 `Error.message`；不重新映射传输错误码，也不为该 UI 再导出 `SessionDeleteError`。重复 Confirm 以及待处理期间关闭会被忽略。部分成功绝不会把失败的幸存者从对话框中拿掉。

## 考虑过的替代方案

**在树内使用复选框或修饰键点击选择。** `aria-selected` 已经表示当前 Session，而行点击会打开 Session、拖拽会重排顺序。单独的区头 `Modal` 把批量身份核对放在该行之外。

**新增批量 `session.delete` RPC 或使用 `Promise.all`。** 新的传输方法会扩大 schema、host 和运行时，却不改变按 id 拒绝的规则。并行调用会打乱顺序和部分结果。顺序复用 `deleteSession` 只保留一条路径。

**停止并删除。** 把取消正在运行的 agent 当作 Confirm 的副作用，会把不可撤销的日志删除藏在一次隐式停止后面。操作者先停止 Session；删除是另一次确认。

**在 UI 中映射 `SessionDeleteError` 错误码。** 运行时没有在 client 入口再导出该类，workspace 的 locale 策略也要求传输字符串原样通过。对 `running` 做预检，可避免为预期中的忙碌情况解析 host 消息。

**从搜索行删除。** 搜索行没有操作菜单；在那里增加删除会在行菜单和区头选择器之外再发明一个入口。

**在选择器中隐藏正在运行的 Session。** 操作者将看不到可见的运行中行为何不能被批量删除。禁用复选框加上本地化运行中状态，让这些行留在列表里。

## 后果

- 批量删除是两个对话框（选择，然后不可撤销确认）；单条删除仍是行菜单上的一次确认。
- 在继续与 Confirm 之间开始运行的 Session 会被客户端预检跳过；该次读取之后的空隙里开始运行的，仍由 host 拒绝。
- 已归档 Session 仍然没有查看或取消归档入口；未设置 `supportsDeletion` 的后端仍在 host 处拒绝。
- `runningSubagentCount` 仍只用于呈现；后代活动不会拒绝删除 parent。

## 测试

`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` 覆盖运行中单条删除拒绝、选择器显示确切标题与 id、禁用运行中复选框、多条删除的顺序调用、部分失败时幸存者告警，以及在继续之后变为运行中时 Confirm 不调用 `deleteSession`。Host 与运行时的删除测试仍是 `session-delete-unavailable` 以及成功后列表变更的权威。
