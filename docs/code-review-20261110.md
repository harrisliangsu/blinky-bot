# 代码审查报告（第 1 轮）

分支：`integration/candidate-20261108` vs 基线 `integrate/20261108-public-release`（8108606，34 commits）
改动：303 文件，+9781 / -2820（src/main 非测试 ~105 文件、测试 60 文件、src/renderer 74 文件、Scripts 测试/工具 20+）

## Workflow / CI 改动核查（专项）

- 本分支全量 diff **未触碰** `.github/` 等 CI 配置（`git diff --name-only` 为空，`git log -- <path>` 34 个 commit 为零命中）
- origin 工作区（另一本地副本）的未提交改动也无 workflow/CI 文件
- 结论：推送报错提到的 workflow/CI 不是本分支内容引入的；本分支无可审查、无需保留或回退的 workflow 改动。报错疑似代码平台侧保护规则提示，建议下次推送时核对目标远端与分支

## 审查范围与覆盖度

重点深读（最终态 + diff 双重）：agent/approval.ts、agent/backendGateway.ts、agent/loop.ts、agent/modes.ts、collaboration/access.ts、collaboration/recovery.ts、collaboration/botAccess.ts、collaboration/workspaceRpc.ts、gateway/invoke.ts、gateway/protocol.ts、telemetry.ts、tools/results.ts、tools/agent/*、tasks/planning.ts
模式扫描：catch 吞错（2 处，均为有意降级并注释）、定时器（telemetry 两处均 unref）、Map 增长（均为测试夹具）、渲染器 HTML 注入面（零新增 dangerouslySetInnerHTML/innerHTML/eval）
测试证据：npm test 193✓、任务控制套件 76✓、clarifications 37✓、typecheck ✓、electron-vite build ✓、harness C 场景 3/3 验收通过。progressRuntime 2 个失败 + progressTurn 文件问题已用 git stash 在基线（208fe6d）复现，确认为 pre-existing。

## 1. 架构审查

- 远程访问：access.ts 持久化走 safeStorage（OS 凭证库），restore 严格校验（ed25519 类型、状态枚举、expiresAt 上限 8h、不延长租约）；botAccess 阻断远程提升 executionAgent accessMode；workspaceRpc 测试证明 retired routing 不可远程重开、view/room 越权 403。边界清晰。
- 审批链：executionApprovalSettings 三处读取点一致；full-access 执行经 capability + coordinator/readOnly 双重拒绝；executorAccessSignal 接入 AbortSignal.any；静默断连检测（turn 末 throwIfAborted）。
- 任务判断私有域：taskJudgmentScope 下 gateway 广告零工具、全部 mutation 拒绝、inspect 只读放行——双层门禁（list 扣留 + 执行拦截）一致。
- 遥测：纯元数据（id/时长/结果/大小），detail 上限 1KiB；缓冲有界、批量落盘、unref 定时器、保留期 + 行数双重 pruning。符合"埋点不拖累性能"的设计约束。

### 失败场景分析

| 代码路径 | 失败场景 | 有测试？ | 有错误处理？ | 用户可见？ |
|---------|---------|---------|------------|----------|
| collaboration/recovery.ts loadSharingRecovery | 恢复文件损坏/被篡改 | ✅（recoveryFile.test） | ✅（整体 catch → 'unavailable'） | 控制台 warn + 状态面真实显示 |
| collaboration/access.ts restore | 单个设备记录字段非法 | ⚠️ 见 P1-1 | ❌ 全量失败 | 共享恢复丢失（需重新分享） |
| telemetry flush | sqlite 写入失败 | ❌ | ✅（catch，下一批继续） | 无（观测数据） |
| gateway invoke manage_task resume | 恢复审批被拒 | ✅（taskActionApproval.test） | ✅（fresh forced approval） | 真实拒绝提示 |

## 2. 代码质量审查

### P0-Bug（必须修复）

无。

### P1-Optimization（可优化）

- [P1] source=INVARIANT:CORRECTNESS (confidence: 7/10) src/main/collaboration/access.ts:48 `restore()` — 单个非法设备记录即 throw，导致整个 sharing 恢复失败（loadSharingRecovery 全量 catch → 'unavailable'，所有已配对设备丢失）。一条脏数据放大为全部可用性损失。→ 修复建议：改为逐条校验、跳过非法项并计数日志（host identity 仍全量失败，因它是后续校验的根）；或至少在 catch 中区分"部分恢复"。

### P2-Suggestion（建议，不修复不评论）

- [P2] (confidence: 6/10) src/main/telemetry.ts:96 `pruneTelemetry` 的 `DELETE FROM events WHERE at < ?` 无 `at` 索引，每日一次全表扫描（上限 50 万行）。建议加 `CREATE INDEX IF NOT EXISTS idx_events_at ON events(at)` 或利用 ROW_CAP 路径已按 seq 有主键序。低优先。
- [P2] (confidence: 5/10) src/main/agent/loop.ts:246 交付物冚底用 `message.id.endsWith(evidenceId)` 做存在判断，后缀匹配偏宽。建议精确相等判断。极低风险（message id 为前缀+taskId 结构）。
- [P2] (confidence: 5/10) src/main/telemetry.ts:68 `installTelemetry` 之前 emit 的事件在缓冲满时静默丢弃（仅计数）。设计已声明"压下丢最旧"，符合约束，仅记录确认。

## 3. 测试覆盖审查

变更路径均有对应测试（60 个测试文件变更，含本分支新增的 coordinatorWritePath、taskActionApproval、workspaceRouting 等安全边界测试）。
关键缺口：telemetry 的 flush 失败路径无测试（代码以 catch 降级，风险低）；access.ts restore 的"部分非法"场景无测试（即 P1-1）。

COVERAGE: 核心安全/审批/协调路径测试覆盖充分；上述 2 个 GAP 均为低危。

## 4. 性能审查

- 遥测批量 flush（2s/400 条触发）+ WAL，热路径仅数组 push，符合"不导致性能问题"约束。
- 审批链新增 taskJudgmentScope 查询为 Map 查找，O(1)。
- budget.ts 语义摘要缓存以指纹命中，避免挤压区重复调模型。
- 无 N+1、无大对象拷贝、无未闭合资源的新增模式。

## 审查结论

- P0: 0 个 | P1: 1 个 | P2: 3 个
- 测试覆盖：核心路径充分；GAP 2 处（低危）
- 关键失败场景：1 个未覆盖（P1-1 关联）
- 门禁状态：✅ 通过（P1 < 3 不阻塞；P1-1 建议下轮修复）
- Workflow/CI：本分支无相关改动，推送报错与本分支内容无关
- 下一步：可推送/合流；P1-1 记入待办
