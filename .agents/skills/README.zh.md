# 项目开发技能

`.agents/skills` 保存正文，`.claude/skills` 只提供可选兼容链接。它们与应用打包使用的 `resources/skills`、`resources/code-cli-skills` 分开。

保留 `gh-pr-review`（当前架构审查）、`find-simplifications`（精简提案）、`docs-governance`（文档、决策和指定翻译）、`gh-create-pr`（已授权的 PR 发布），以及 `vercel-react-best-practices` 的 React 客户端参考。

清单位于 `public-skills.txt`。同步工具可选，不进入安装或构建流程：

```powershell
pnpm exec tsx scripts/skills-sync.ts
pnpm exec tsx scripts/skills-sync.ts --apply
pnpm exec tsx scripts/skills-check.ts
```

第一条只预览。显式应用仅创建缺少的链接、更新受管忽略清单；普通文件、目录和异常链接会在写入前报冲突。链接失败会回滚本次新增链接。先自行保存冲突内容，不递归删除、不修改全局 Git/Windows 策略来强行同步。没有链接权限时直接读取正文，或明确选择并维护本地副本。

根规则正文为 `CLAUDE.md`。Claude 直接读取；Codex 使用本地标准 `AGENTS.md` 明确要求读取正文，或显式配置 fallback。保留已有本地规则。`AGENTS-og.md` 只是历史别名；fresh checkout 后需在实际客户端确认规则被发现。

精简前完整技能和笔记树可从 `3b84a66575dcb132f7c832957de67a2cffbd05fa` 恢复。旧指南退出活动索引，应用技能资源和待迁移功能决定保留。
