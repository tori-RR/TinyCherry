---
description: 将上游正式版集成到 TinyCherry 时必须执行的验证与推进流程
---

# 同步上游正式版

[English](upstream-sync.md) | 中文

上游集成必须先对最终候选提交完成完整验证，再推进目标分支。正式版同步均使用此流程，包括保留 TinyCherry 功能精简或原生适配的更新。

## 准备候选提交

使用 `.node-version` 指定的 Node 版本和 `package.json` 指定的 pnpm 版本，按冻结的锁文件安装依赖。本地原生打包门禁需要 Windows x64，以及 [EvoStack](../../../native/evostack/README.md) 中记录的工具链。通过 `PATH` 或 `.cache/upstream-validation/tools/actionlint.exe` 提供与 CI 版本一致的 actionlint。安装并认证 `gh`，用于核对 origin 仓库及实际 GitHub 推送目标。

在每个用于同步的工作副本中安装验证 hook：

```shell
pnpm upstream:hooks
```

它会安装独立的 pre-push hook，并保留现有的 prek 提交和检出 hooks。若已有无法识别的 pre-push hook，必须先处理冲突，安装才能继续。

获取目标分支和选定的官方正式版 tag，再从目标分支创建同步分支。候选分支使用 `codex/upstream-vX.Y.Z` 这类名称，`main`、`evostack` 和 `release/*` 是受保护的推进目标。记录解析后的目标提交和上游提交 ID，不使用持续变化的分支作为审查基线。以下命令中的 `TARGET_SHA`、`UPSTREAM_SHA` 和 `CANDIDATE_BRANCH`，分别替换为记录的提交值和同步分支名。

在同步分支上完成适配，提交前核对以下边界：

- 保留的功能与明确移除的功能，以及对应的测试和依赖。
- TinyCherry 品牌、应用路径、首次启动、导航与现有交互。
- 共享类型、IPC 注册、运行时适配层、数据库迁移和生成的注册表。
- 上游专用发布与通知任务、fork 配置和必要的 secrets。
- 文档、翻译目录、打包内容，以及上游正式版改变的行为。

修复仍支持的行为，更新已移除功能的过期预期，保留有效功能的检查。完成生成与格式化，结束所有并行修改，提交最终候选版本后再验证。

## 验证固定的提交

```shell
pnpm upstream:verify --base TARGET_SHA --upstream UPSTREAM_SHA
```

门禁要求工作树干净，且没有未完成的 merge 或 rebase。它设置 `CI=true`，清除继承的 `VALIDATION_PLAN` 和 `VALIDATION_WORKSPACE_PREPARED`。核对固定的 Node 和 pnpm 环境后，先将已有的 `node_modules` 备份到被忽略的 `.cache/` 下，再按 `--frozen-lockfile` 创建新的依赖安装。安装失败时恢复原依赖树；成功的备份会保留并报告，不会静默删除。`--all` 的优先级高于继承的增量计划。

本地门禁沿用 CI 的平台分工，检查工作流语法与 fork 边界、目录与发布策略、生成的迁移/服务商/翻译漂移、全部静态检查、Windows 平台测试清单、门禁与计划器回归测试，以及完整的原生打包。静态与平台阶段使用以下命令：

```shell
pnpm check --all --group checks
pnpm check --all --group platform --max-workers 2
```

本地 actionlint 关闭 ShellCheck 和 Pyflakes 集成，ShellCheck 在完整的 Linux CI 容器中执行。所有本地测试和生成结束后，门禁再执行最终 i18n 检查。原生包必须报告候选提交的身份，并通过启动和契约检查。

Linux 测试项目继续由完整的 Linux CI 套件执行，Windows/macOS runner 保留各自的平台契约。不得为了在 Windows 上运行归属 Linux 的套件而改变产品行为或重写无关的 POSIX fixtures。真实缺陷应在测试归属的平台上修复。

每一步都核对同一 HEAD、Git tree、暂存区与工作树。源码变化、暂存修改或非忽略的未跟踪文件都会终止验证。发现生成漂移后，先审查并提交修正结果，再重新执行门禁。验证期间不得修改候选版本。

只有完整成功的执行才会将本地结果写入 `.cache/upstream-validation/receipts/`，将提交和 tree 绑定到检查集合、Node 版本及原生产物哈希。执行失败会使该提交的结果失效。结果与诊断日志保持忽略，根 README 继续负责产品介绍。

验证、`pnpm upstream:check` 和 `git push` 必须在使用 `.node-version` 的同一环境中执行。若系统默认 Node 版本不同，先切换到项目指定版本再继续，保留验证结果和验证 hook。

发布候选提交前，立即核验结果：

```shell
pnpm upstream:check
git push origin HEAD
```

已安装的 pre-push hook 读取 Git 实际更新的 refs，逐一检查每个非删除 ref。当前工作副本的有效结果不能授权另一个未经验证的提交。被忽略的缓存与日志变化不会使源码检查失效。

## 完成平台 CI

首次推送候选版本使用本地门禁。在该分支上手动触发完整 CI：

```shell
gh workflow run ci.yml --ref CANDIDATE_BRANCH
```

确认该运行对应准确的候选 SHA，并使用完整计划：全部已配置的 Linux 测试项目，包括 main/package/renderer 测试，以及 Windows/macOS 平台契约。等待全部必需 jobs 及聚合检查通过。推进候选提交要求 origin 仓库中该 SHA 最近一次的 `workflow_dispatch` CI 已完成且成功。向 `main`、`evostack` 或 `release/*` 推送，则要求实际推送 remote URL 对应的仓库中存在该结果。增量运行或其他 SHA 的结果不能满足此要求。本地 Windows 验证只能证明在 Windows 上实际执行的行为，其他平台由对应 runner 提供验证证据。

若 CI 需要修正，提交修改并重新执行本地验证后，再发布新的候选版本。先前的定向测试或旧候选版本的绿色运行，不能验证已改变的最终提交。

## 推进已验证的提交

刷新远端目标，确认本地目标与远端一致。若目标已在候选版本的基线上继续推进，先更新同步分支，对新的候选版本重新执行验证与完整 CI。

切换到目标分支后，使用推进封装命令：

```shell
pnpm upstream:check --ref CANDIDATE_BRANCH
pnpm upstream:merge --ref CANDIDATE_BRANCH
pnpm upstream:check
git push origin main
```

封装命令要求候选结果有效、产物未变、工作副本干净、候选提交是当前目标的后代，并且该候选提交的完整 CI 已通过。它执行 `git merge --ff-only`，保留已验证的候选 SHA 和对应的打包身份。需要解决冲突的合并必须返回候选准备阶段。

上游推进必须使用该封装：Git 的 `pre-merge-commit` hook 不覆盖 fast-forward 合并。本地 pre-push hook 仍会核对实际推送的提交。这些本地工具不会配置 GitHub 分支保护，也不替代平台 CI 要求。

推送目标后，核对远端 SHA 和 CI 结果。新提交、rebase、merge commit、产物变化或提交后的格式化修改，都要求重新获得有效结果，并为最终 SHA 构建产物。
