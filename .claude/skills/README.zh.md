# Claude Skills 镜像说明

本目录是面向 Claude 的 skill 文件镜像目录。

- 不要直接在 `.claude/skills` 下创建新 skill。
- 所有 skill 仅在 `.agents/skills` 中创建和维护。
- 更新 `.agents/skills/public-skills.txt` 后，先执行 `pnpm exec tsx scripts/skills-sync.ts` 预览，再显式加 `--apply`。普通文件、目录和非预期链接会作为冲突保留。Windows 缺少链接权限时，不删除原目标，也不修改全局设置。
- `pnpm exec tsx scripts/skills-check.ts` 会校验 `.claude/skills/<skill>` 是指向 `.agents/skills/<skill>` 的有效符号链接。
