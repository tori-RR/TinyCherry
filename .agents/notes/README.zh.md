# Agent Notes

[English](README.md) | 中文

Agent Note 记录维护者可能合理重新讨论的决策：问题、选定行为、落选方案、接受的代价，以及证明结果完整的证据。它是仓库中的决策理由，不凌驾于当前代码。

## 布局与分类

Note 位于 `{lifecycle}/{class}/yyyy-mm-dd-topic.md`。

生命周期：

- `proposed/` — 正在讨论或实现的决策。
- `implemented/` — 已发布事实，并持续保持事实准确。
- `rejected/` — 被明确否决的提案；只有理由仍能防止可信的重复错误时才保留。

类别：

| Class | Use |
|---|---|
| `feature` | 用户或模型可见能力。 |
| `bug-fix` | 值得长期保留的根因与修复决策。 |
| `simplification` | 删除或合并已有行为与结构。 |
| `architecture` | 已发布源码的所有权与依赖决策。 |
| `process` | 仓库工具、政策与工作流。 |
| `testing` | 测试基础设施与策略。 |

不存在 `refactor` 类别。包含持久删除决策的 refactor 属于 simplification；机械 refactor 不需要 note。

### 选择初始状态

仍在讨论或实现的决策放入 `proposed/`。决策已交付且有验证证据时，放入 `implemented/`。只有明确否决已有提案时，才使用 `rejected/`。

### 状态转换

```mermaid
stateDiagram-v2
    [*] --> Proposed: planning record
    [*] --> Implemented: decision already delivered
    Proposed --> Proposed: update the proposal
    Proposed --> Implemented: implementation is verified
    Proposed --> Rejected: explicit human rejection
    Implemented --> Implemented: keep shipped facts current
    Implemented --> Successor: decision is reversed or superseded
    Rejected --> Successor: new evidence reopens the question
```

`Successor` 表示新建一条相互链接的 note，并保留已有决策记录。

## 何时使用 note

TinyCherry 按需使用 Agent Note。架构、兼容性、持久数据等长期决策，或维护者日后可能重新讨论修复理由时，可以写一条。优先更新已有的决策记录。

## 可选的规划与评审

可以在 Issue、实现 PR 中讨论方案，也可以单独讨论。Spec PR 和堆叠 PR 都是可选的。如果工作分散在多个 PR 中，等各 PR 的验证合起来覆盖了该决策，再将 note 标为 implemented。

## 文件格式

每条 note 以以下精确 header block 开头，随后是语言切换器：

```markdown
# Agent Note: <title>

Status: <lifecycle>

English | Chinese counterpart: yyyy-mm-dd-topic.zh.md
```

Proposed note 包含：

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

Acceptance criteria 描述可观察结果，而不是实现任务：

```markdown
- AC1 — <observable result> (verification: unit | renderer | Electron | packaged artifact | docs gate)
```

验收标准条目是机器可读的单行顶层列表项。必须使用上面的精确 `-` 形式；使用其他列表标记、缩进、引用块或跨行内容的条目都会被拒绝。代码块和原始 HTML 不会被视为条目。补充上下文可以写在段落中，或写在不引入其他 AC ID 的列表项中。

Implemented note 包含：

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
## Verification
```

由 Spec 转换的 note 把每个 AC 映射到实际证据。直接创建的 bug-fix note 可以使用 `Regression`：

```markdown
- AC1 — `<command or test>`: <what regression it catches>
- Regression — `<command or test>`: <what regression it catches>
```

Verification 条目遵循相同的单行顶层列表规则。

Rejected note 保留 `Problem`、`Proposal` 和 `Alternatives considered`，增加 `Rejection rationale`，并使用：

```markdown
Status: rejected — <one-line decisive reason>
```

## 否决与删除

只有明确的人类决策能把 `proposed` 移到 `rejected`。部分否决时，更新 proposed note 以反映决策。讨论中的落选方案保留在 `Alternatives considered`。

如果否决理由有助于避免重复错误，就保留一条 rejected note。如果探索没有持久价值，直接关闭未合并 PR，不向仓库增加噪音。Implemented decision 永远不会改标 rejected；应由新 note 取代它。

## 取代关系

新增 note 前，按领域术语、机制名、路径和 rejected alternative 搜索 active note。

- 新决策：创建 note。
- 同一决策：更新当前 owner。
- 部分取代：保持两条 note 当前有效，并双向链接。
- 完全取代：把每个独有理由、替代方案、后果和验证事实移入新 owner。删除旧 note 需要明确人类批准。

不要把 note 改写成不同决策，也不要让 Git history 成为唯一残留理由。

## Archived note（延后）

Cherry Studio 当前没有 `archived/` 生命周期、目录或合法状态。Note 不会因为时间久、PR 已合并、代码已移动或文字已过时而自动归档。仍归属当前决策的 implemented note 保持 active，并就地更新。

只有在以下仓库级条件全部成立时，才引入 archive：

1. 完全被取代或归属领域已删除的 note 累积到可测量地削弱 active tree 搜索。
2. 已为 agent 定义优先搜索 active、再回退搜索历史的行为。
3. Archive 索引或等价的 owner 映射能保持 successor 可发现。
4. Pairing、格式、supersession 和入链门禁理解新生命周期。
5. 该变更作为仓库 process 决策获得批准，而不是根据 note 年龄自行推断。

该生命周期实现后，只有 implemented 或 rejected note 才有资格，并且必须同时满足：

- note 已被完全取代，或其归属系统已整体删除；
- 当前 owner 已吸收每个独有理由、替代方案、后果和验证事实；
- successor 和入链链接指向 active owner；并且
- 人类明确确认 supersession 与 archive 移动。

Proposed note 永远不进入 archived。被明确否决的 proposal 在其理由有持久价值时转为 rejected；没有持久价值的未合并探索直接关闭，不增加仓库记录。Archive 支持实现前，完全被取代的 note 仍保持 active 并互相链接；删除旧 note 仍需要明确人类批准。

## 生命周期转换

`proposed → implemented` 会重写为已发布的现在时事实：`Proposal` 变为 `Decision`；计划与 checklist 变为实际 `Consequences` 和 `Verification`。英文、中文和 sidecar 一起移动。

`proposed → rejected` 保留被考虑的内容，增加明确 verdict 与证据，并停止所有 implementation layer。未来带新证据的 proposal 应链接 rejected 记录，而不是擦除它。

Implemented note 持续同步路径、名称、默认值、所有权、失败和验证。实现与 note 不一致时，应判断代码错误还是事实实现发生变化；不要为了满足过时 prose 而保留更差的实现。

发布生命周期移动前，运行 `pnpm agent-notes:check-transition --base <verified-spec-ref> [--head <ref>]`。检查器要求英文、中文和 sidecar 完整移动，只允许 `proposed → implemented|rejected`，在 implemented 转换中逐一映射全部已批准 AC，并要求明确的 rejection reason。它只校验声明的转换；绝不自行决定 proposal 已被拒绝或 stack 已完成。

## Pairing 与门禁

每条 note 和本 README 都遵循[双语 pairing 契约](../../docs/dev/i18n/README.md)。Agent instruction 文件保持仅英文。

运行：

- `pnpm docs:check-notes` 检查格式与生命周期结构。
- 生命周期移动时运行 `pnpm agent-notes:check-transition --base <verified-spec-ref>`。
- 编辑 pair 时运行 `pnpm docs:check-pairing <pair>`。
- 发布文档变更前运行 `pnpm docs:check`。

[已实现的文档治理决策](implemented/process/2026-08-18-docs-governance-and-spec-workflow.md)归属此工作流。
