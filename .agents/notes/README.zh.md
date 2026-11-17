# 决策笔记

笔记用于保留理由、备选方案和验证证据，可按需记录。当前行为写在[桌面架构](../../docs/desktop.md)或模块 README；引用旧结论前先核对源码。

新增记录前，按业务领域、机制和已否决方案检索，优先更新已有归属。一份新笔记记录日期、背景、决定或提案、代价和实际验证即可。区分提案与已实现行为，交叉链接后继记录，保留独特理由。只有用户的明确决定才能否决待迁移功能；目录名称本身不证明产品批准，也不授予执行权限。

历史 `proposed/`、`implemented/`、`rejected/` 目录保留。旧双语文件、AC 和 sidecar 反映当时流程，新工作不要求沿用。取消强制双语三件套、生命周期检查器、Spec PR 和堆叠审批流程，使用当前[文档技能](../skills/docs-governance/SKILL.md)与[桌面检查](../../scripts/desktop/README.md)。

本次没有删除历史功能提案。Agent/MCP、语音、附件和文件编辑提案仍可提供需求依据，当前迁移状态以 `docs/desktop.md` 为准。旧开发指南及路径可从 `3b84a66575dcb132f7c832957de67a2cffbd05fa` 恢复；应用迁移前参考基线仍为 `7d7a171fe7d164a7fb9dd6625a2868004bb7897c`。

退出的开发入口：`agent-notes` 并入 `docs-governance`；`create-skill`、`gh-create-issue`、`gh-stack`、`translate-docs` 退出活动集，指定翻译交给文档技能。旧 Electron E2E 指南/配置及未使用的 setup-validation action 保留在上述 Git 历史。安全与所有权决定、应用资源技能保留。
