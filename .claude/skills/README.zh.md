# Claude 兼容链接

正文和活动清单位于 [`.agents/skills`](../../.agents/skills/README.zh.md)。它们是开发辅助材料，与应用资源技能分开。同步可选：先运行 `pnpm exec tsx scripts/skills-sync.ts` 预览，再显式加 `--apply` 创建缺少的链接、更新忽略清单，最后运行 `pnpm exec tsx scripts/skills-check.ts`。

普通文件、目录和异常链接会作为冲突保留；创建失败会回滚本次新增链接。不修改全局策略，不递归删除冲突内容。私有设置和清单之外的技能仍留在本地。
