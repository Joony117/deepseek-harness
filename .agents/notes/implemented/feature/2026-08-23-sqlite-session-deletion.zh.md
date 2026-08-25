# Agent Note: SQLite 会话删除

Status: implemented

[English](2026-08-23-sqlite-session-deletion.md) | 中文

## 问题

SQLite 持久化后端继承了 `supportsDeletion = false`，将删除报告为不支持，而 JSONL 后端已经实现了由能力开关控制的 `delete()` 契约。因此 host 的删除路径（`session.delete`）会拒绝任何 SQLite 存储的会话，接缝文档也把 SQLite 列在拒绝删除的后端之中。

## 决策

### 经由 coordinator，后端只负责行删除

`SessionPersistenceSqlite` 设置 `override readonly supportsDeletion = true`，并把 `delete(id, signal)` 实现为对 `coordinator.delete(id, remove, signal)` 的调用。所有拒绝语义——会话仍在活动、持久化工作尚未完成——都留在 coordinator 中，与 JSONL 完全一致。后端只贡献 `SqliteStore.remove(id, signal)`。

### 单一事务，由级联完成扩散

`remove()` 执行 `BEGIN IMMEDIATE` → `validateSchemaForMutation` → 单条 `DELETE FROM sessions WHERE id = ?`（新增 `delete-session` SQL 资源）→ `COMMIT`，失败时经由 store 现有的 `rollback(error, 'delete')` 路径回滚。事件行随会话行一起删除，因为 `events.session_id` 声明了 `ON DELETE CASCADE`，而 store 唯一的记忆化连接开启了 `PRAGMA foreign_keys = ON`；单例的 `persistence_state` 行不受影响。模式校验在事务内进行，与 `appendBatch` 和 `commitRepair` 一致。

### 后代不级联

`sessions.parent_session` 没有外键。删除父会话时，每个后代的 header、事件以及 `parentSession` 值都原样保留——与 JSONL 后端记录的非级联策略相同。不存在的 id 是成功的空操作，符合基础契约。

## 考虑过的替代方案

**逐表的多语句显式删除。** 两条语句而非一条，并且重复了模式已经拥有的不变量；spec 通过第二个连接断言级联生效，而不是凭信任接受它。

**为 `api-proxy-delete.spec.ts` 增加 SQLite 用例。** 该 spec 直接导入 JSONL 后端并对 `SessionLocation` 路径断言，而 SQLite 后端不产生这种路径（`locate()` 返回 `undefined`）；API 删除路径从不调用 `locate()`，coordinator 接缝测试已经覆盖共享行为。扩展它是一次重写，而不是新增一个用例。

**级联删除后代。** 会偏离 JSONL 后端记录的策略，并悄悄扩大单会话删除的影响范围。

## 后果

host 删除路径现在对 SQLite 存储的会话可用，拒绝语义不变。中止处理在构造上是浅层的：`remove()` 只在事务打开前观察 signal，因为同步的 `node:sqlite` 语句无法在事务中途被打断——部分删除的状态不可达。

## 测试

`tests/sqlite-delete.spec.ts`（六个测试）：能力声明；空闲会话删除会移除其所有行，并通过第二个原始连接验证；其他会话不受影响；不存在的 id 是空操作；父会话删除后后代的行与 `parentSession` 原样保留；持久化工作尚未完成时删除被拒绝且行保留。传输中追加的拒绝本身由 coordinator 通用处理，在 `session-persistence` 自己的测试套件中覆盖。
