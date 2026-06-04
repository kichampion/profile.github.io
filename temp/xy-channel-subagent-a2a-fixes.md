# XY Channel Subagent/A2A 状态机修复总结

本文档总结本轮 `xy_channel` 针对 OpenClaw subagent、A2A 返回、steer 并发、push 回跳和任务状态清理相关问题的修改。

## 背景

问题集中出现在基于 XY Channel 的主对话调用 OpenClaw subagent 后：

- subagent 已完成，但主对话没有收到最终结果。
- 多个 subagent 只返回一个结果或第一个结果看起来就结束任务。
- 任务实际结束后，A2A 任务状态仍显示“正在处理中”。
- 新任务被误判为 steer，返回 `No active run to steer in this session`。
- 多次 push 使用旧任务或点击 push 后无法定位正确结果。
- `tasks/cancel` 缺少 `params.sessionId` 时清理异常。
- 用户连续发多条消息时，taskId/session 上下文互相覆盖。
- 普通简单问题没有调用 subagent，也可能让对话页收到错误 final 或停在处理中。

核心根因是：原实现把“channel 仍有 task 绑定”“OpenClaw 仍有可 steer 的活跃 run”“subagent wait 状态”“A2A 任务最终完成”混在了一套状态里处理，导致等待态、流式态和任务完成态互相污染。

## 主要修改文件

- `src/bot.ts`
- `src/monitor.ts`
- `src/reply-dispatcher.ts`
- `src/outbound.ts`
- `src/formatter.ts`
- `src/task-manager.ts`
- `src/parser.ts`
- `src/push.ts`
- `src/subagent-wait-state.ts`
- `src/steered-completion-state.ts`

## 问题与方案

### 1. 新任务误走 steer

现象：

- 任务完成或等待 subagent 后，再发新消息仍进入 `STEER MODE`。
- OpenClaw 返回 `No active run to steer in this session`。

根因：

- `monitor.ts` 和 `bot.ts` 只用 `hasActiveTask(sessionId)` 判断是否可 steer。
- 但 subagent wait 会保留 task 绑定，这不代表 OpenClaw 仍有活跃 run。
- 旧 `streamingSignals` 没有在父 dispatcher settled 后清掉。

方案：

- `bot.ts` 新增 `hasSteerableRun(sessionId)`，只有存在真实 streaming signal 才允许 steer。
- `monitor.ts` 改为 `hasActiveTask(sessionId) && hasSteerableRun(sessionId)` 才并发 steer。
- `bot.ts` 的 `onSettled` 即使保留 subagent wait，也会先删除 `streamingSignals`。

关键日志：

- 正常新任务：`Active task binding exists but no steerable run; starting a new task`
- 不应再出现旧任务等待期间的新消息直接进入 `STEER MODE`。

### 2. subagent 结果回来后主任务不结束

现象：

- `Completion delivered count=1/1, complete=true` 后仍发送 `final=false`。
- 前端持续显示“任务正在处理中”。
- subagent 实际已经产出结果，但主对话没有收到最终 answer artifact。

根因：

- subagent 结果被当作普通中间结果发送，最终状态没有转换为 A2A `completed/final=true`。
- 父 dispatcher 已经 settled 后，实际上没有主 agent 可以继续整理结果，但 wait 状态仍一直保持。

方案：

- `src/subagent-wait-state.ts` 新增 `parentSettled`。
- `bot.ts` 在父 dispatcher `onSettled` 时调用 `markSubagentWaitParentSettled()`。
- `outbound.ts` 在 subagent 结果到齐且 `parentSettled=true` 时：
  - 发送 `A2A_STATUS state=completed`。
  - 发送 `A2A_RESPONSE final=true`。
  - 清理 subagent wait、taskId 和 session。

关键日志：

- `Parent dispatcher settled while waiting`
- `Completion delivered count=N/N, complete=true`
- `A2A_STATUS ... 任务处理已完成~`
- `A2A_RESPONSE ... final=true`
- `Cleared wait state, reason=all-subagent-results-delivered-after-parent-settled`

### 3. subagent 已完成，但主对话没有收到最终结果

现象：

- 子任务运行完成并通过 push 发出了结果。
- 主对话页只看到“子任务正在处理中”或“子任务结果已收齐，主任务正在整理最终回复~”。
- 没有收到真正结束 A2A task 的 final artifact。

根因：

- OpenClaw 的 subagent completion 可能通过 outbound/message 工具回到 channel，而不是回到原 dispatcher 的 `deliver(final)`。
- 父 dispatcher 在 `sessions_yield` 后已经 idle/settled，此时如果 channel 只保留 wait 状态，不主动把 completion 映射回原 A2A task，主对话就不会收到最终结果。
- 旧逻辑认为“subagent 结束不等于主任务结束”，所以只发 `final=false`，但在父 dispatcher 已 settled 的路径下，已经没有活跃主 agent 可以再发送最终整理结果。

方案：

- `subagent-wait-state.ts` 保存原始 A2A task 的 `sessionId/taskId/messageId/sessionKey`。
- `bot.ts` 在父 dispatcher settled 时标记 `parentSettled=true`，同时保留 waitState 给后续 completion 使用。
- `outbound.ts` 在收到 subagent completion 时，解析原始 waitState：
  - 未收齐：只发 working/status 和 reasoningText。
  - 已收齐且 `parentSettled=true`：把聚合后的 completion 文本作为原任务最终结果，发送 `completed + final=true`。
- 完成后清理 waitState、taskId 和 session，防止同一 task 后续继续心跳。

关键日志：

- `SUBAGENT-WAIT] Parent dispatcher settled while waiting`
- `xyOutbound.resolveTarget] Enhanced target ... session::task`
- `SUBAGENT-WAIT] Completion delivered count=N/N, complete=true`
- `xyOutbound.sendText] ... parentSettled=true`
- `A2A_RESPONSE] Sending artifact-update ... final=true`

### 4. 多个 subagent 只返回一个或提前完成

现象：

- 创建两个 subagent，但第一个结果回来后 UI 像是任务完成。
- 第二个结果再回来时展示混乱。

根因：

- 每个 subagent 结果都以普通 `text artifact-update` 发给原 A2A task。
- 客户端会把第一个普通 text artifact 当成主结果区内容。
- `append=true` 还依赖稳定 artifactId，原实现每次生成新 artifactId。

方案：

- `subagent-wait-state.ts` 增加：
  - `expectedCompletions`
  - `deliveredCompletions`
  - `completionTexts`
  - `artifactId`
- `reply-dispatcher.ts` 在 `sessions_spawn` 时递增 expected。
- `outbound.ts` 在中间 subagent 结果阶段：
  - 只发 `working` status。
  - 用 `reasoningText` 展示子任务结果。
  - 不再发普通 `A2A_RESPONSE text final=false`。
- 所有 subagent 收齐后，聚合 `completionTexts`，一次性发送唯一 `A2A_RESPONSE final=true`。
- `formatter.ts` 支持传入稳定 `artifactId`。

关键日志：

- 第一个结果：`Completion delivered count=1/2, complete=false`
- 第一个结果不应再出现普通 `A2A_RESPONSE ... final=false`
- 最后一个结果：`Completion delivered count=2/2, complete=true`
- 最终返回：`A2A_RESPONSE ... final=true`

### 5. 简单问题导致对话页报错

现象：

- 用户发送普通简单问题，不需要 subagent。
- 对话页直接收到错误回复，例如 `No active run to steer in this session`。
- 或者简单任务的正常 final 被旧任务/旧 wait 状态污染，页面显示错误或持续 working。

根因：

- 简单问题也会复用同一个 conversation session。
- 如果上一轮任务留下了 active task 绑定或 streaming signal，新消息会被错误判断为 steer 更新。
- 如果上一轮 waitState 尚未清理，`sendStatusUpdate()` 默认使用最新 taskId，也可能把状态更新发到错误任务。
- `tasks/cancel` 或 clearContext 的参数结构不稳定时，旧 task 没清理干净，也会污染下一次普通问答。

方案：

- `monitor.ts` 和 `bot.ts` 都使用 `hasActiveTask && hasSteerableRun` 判断 steer，普通问题不会因为旧 task 绑定误走 `/steer`。
- 父 dispatcher settled 后先删除 streaming signal，再决定是否保留 subagent wait。
- `sendStatusUpdate()` 增加 `useLatestTask=false`，subagent/wait/completion 相关状态固定回写原 task，不污染新普通任务。
- `task-manager.ts` 使用 task stack，清理时带 `expectedTaskId`，避免旧任务完成时误删新普通任务。
- `tasks/cancel` 支持从 `params`、顶层字段和 WebSocket fallback 读取 session/task，减少清理失败。

关键日志：

- 普通新问题不应出现：`STEER MODE - Second message detected`
- 如果旧 task 仍存在但不可 steer，应出现：`Active task binding exists but no steerable run; starting a new task`
- 简单问题最终应出现：`ON-IDLE] Sent completion status update` 和 `ON-IDLE] Sent final response`

### 6. `sessions_yield` 单独出现导致无限等待

现象：

- 日志只有 `sessions_yield`，没有 `sessions_spawn`。
- 通道进入 `Started waiting ... expected=1`，然后无限心跳。

根因：

- 旧逻辑看到 `sessions_yield` 就默认创建 `expected=1`。
- 但 OpenClaw 的 `sessions_yield` 应该用于等待已创建的 subagent completion；没有 `sessions_spawn` 时不应制造等待状态。

方案：

- `markSubagentWaitStarted()` 不再默认 expected=1。
- 只有 `sessions_spawn` 先登记过 expected，`sessions_yield` 才创建 waitState。

关键日志：

- 异常 yield：`Skipping wait start because no sessions_spawn completion was expected`
- `TOOL-START] sessions_yield detected without sessions_spawn; not entering subagent wait`

### 7. steered 结果没有返回 A2A final

现象：

- steer dispatch 只打印 `steered current session` 或跳过 final。
- 第二条消息或后续消息没有收到结果。

根因：

- steered dispatcher 过去直接跳过所有 deliver 内容。
- 对真正的 final 文本和 OpenClaw 控制确认文本没有区分。

方案：

- 新增 `src/steered-completion-state.ts` 保存 steered task 的待完成状态。
- `reply-dispatcher.ts`：
  - 跳过 `steered current session` 等控制文本。
  - 对非控制 final 发送 `completed + final=true`。
  - 完成后清理 steered 状态、taskId 和 session。
- `outbound.ts` 支持通过 steered completion state 把 message 工具输出映射回当前 A2A task。

关键日志：

- `STEERED-COMPLETION] Started waiting for steered result`
- `DELIVER] Steered final response sent`
- `STEERED-COMPLETION] Cleared pending state`

### 8. 多消息并发导致 taskId 覆盖

现象：

- 用户连续发多条消息后，多次 push 或返回使用最初 task。
- 当前 taskId 被后来的消息覆盖，旧任务清理时误删新任务。

根因：

- `task-manager.ts` 原来每个 session 只维护一个 `currentTaskId`。
- 新旧任务并发或 steer 时会互相覆盖。

方案：

- `task-manager.ts` 改为 task stack：
  - `tasks: TaskIdEntry[]`
  - `registerTaskId()` 将新任务压入栈顶。
  - `decrementTaskIdRef(sessionId, expectedTaskId)` 只移除指定 task。
  - 移除当前 task 后恢复前一个 task。

关键日志：

- `Updating taskId: old -> new`
- `Removed taskId <new>, restored current taskId <old>`
- `Removing taskId`

### 9. `tasks/cancel missing sessionId in params`

现象：

- XY 客户端发送的 `tasks/cancel` 可能没有 `params.sessionId`。
- 处理时报错或无法清理正确 task。

根因：

- 旧实现只读取 `message.params.sessionId` 和 `message.params.id`。

方案：

- `bot.ts` 新增：
  - `getRequestSessionId()`
  - `getRequestTaskId()`
- 支持从 `params`、顶层字段和 WebSocket session fallback 读取。
- 当 cancel 命中 subagent wait 时，不删除原 task/session，保留给后续 subagent completion 关闭。

### 10. push 点击后无法定位结果

现象：

- push 已发送，但点击 push 回对话页取不到对应结果。
- 多次 push 可能复用错误 session/task。

根因：

- push payload 缺少 sessionId。
- Trigger 数据解析只兼容部分结构。

方案：

- `push.ts`：push payload 中携带 `sessionId`。
- `parser.ts`：`extractTriggerData()` 支持：
  - `part.data.pushDataId`
  - `event.payload.dataMap.pushDataId`
  - `event.payload.pushDataId`
- `outbound.ts`：push target 归一化，只把 `sessionId::taskId` 的 session 部分用于 push，A2A 仍使用完整 task target。

## 状态机设计摘要

### 正常任务

1. `bot.ts` 注册 task/session。
2. 创建 streaming signal。
3. dispatcher 运行。
4. 无 subagent wait：
   - `onIdle` 发送 `completed + final=true`。
   - 清理 streaming signal、taskId、session。

### 简单问答任务

1. 即使同一 session 里存在旧 task 绑定，也必须先确认 `hasSteerableRun=true` 才能进入 steer。
2. 没有可 steer run 时，按新普通任务处理。
3. 普通问题走 `deliver -> accumulatedText -> onIdle`。
4. `onIdle` 发送 `completed + final=true`，随后清理 task/session。
5. 旧 subagent wait 的状态更新必须使用原 task，不得覆盖当前简单问题 task。

### subagent 任务

1. `sessions_spawn` 递增 expected。
2. `sessions_yield` 创建 waitState。
3. 父 dispatcher settled：
   - 删除 streaming signal。
   - 标记 `parentSettled=true`。
   - 保留 task/session 供 subagent completion 使用。
4. subagent completion 到达：
   - 未收齐：发 working status + reasoningText。
   - 收齐且 parent settled：聚合结果，发 completed + final=true，并清理状态。

### steer 任务

1. 只有 `hasActiveTask && hasSteerableRun` 才进入 steer。
2. steer dispatch 只跳过控制确认文本。
3. 真正 final 或 outbound completion 会回写对应 A2A task。
4. 完成后清理 steered completion/task/session。

## 验证方式

当前本地验证：

```bash
npm run build
```

期望日志检查：

- 不应在旧 wait 状态下误触发 `STEER MODE`。
- 子任务中间结果不应发普通 `A2A_RESPONSE ... final=false`。
- 所有子任务收齐后应出现 `A2A_RESPONSE ... final=true`。
- subagent 完成但父 dispatcher 已 settled 时，应由 `outbound.ts` 主动回写原 A2A task 的 final。
- 简单问题不应返回 `No active run to steer in this session`。
- `tasks/cancel` 命中 subagent wait 时应保留上下文。
- 最终完成后不应继续出现同一 task 的 30 秒心跳。

## 后续建议

- 给 subagent wait 状态机补单元测试，至少覆盖：
  - 单 subagent completion 后关闭任务。
  - 多 subagent 只在全部 completion 后 final。
  - `sessions_yield` without `sessions_spawn` 不进入 wait。
  - parent settled 后新消息不走 steer。
- 给 A2A artifact append 行为补协议级 fixture，验证稳定 artifactId 和 final=true。
- push 429 可以单独做退避或限流策略；本轮只保留原 push 发送行为，不改变推送重试策略。
