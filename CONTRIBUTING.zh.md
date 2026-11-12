# Cherry Studio 贡献指南

[English](CONTRIBUTING.md) | 中文

欢迎加入 Cherry Studio 贡献者社区！我们致力于让 Cherry Studio 成为一个能够长期创造价值的项目，并期待更多开发者参与。无论你经验丰富还是刚刚入门，你的贡献都会帮助我们更好地服务用户并提升软件质量。

## 参与方式

你可以通过以下方式参与：

1.  **贡献代码**：帮助开发新功能或优化现有代码。请遵守仓库规则，并验证受影响的行为。

2.  **修复缺陷**：发现 bug 后欢迎提交修复。提交前请确认问题已经解决，并包含相关测试。

3.  **维护 Issue**：协助标记、分类和解决 GitHub Issue。

4.  **产品设计**：参与产品设计讨论，帮助改进用户体验和界面设计。

5.  **编写文档**：帮助改进用户手册、API 文档和开发者指南。

6.  **社区维护**：参与社区讨论、回答用户问题并推动社区活动。

7.  **推广使用**：通过博客、社交媒体等渠道推广 Cherry Studio，吸引更多用户和开发者。

## 开始之前

请先阅读[行为准则](CODE_OF_CONDUCT.md)和[许可证](LICENSE)。

## 配置开发环境

请参阅[开发者指南](docs/dev/contrib/development.md)，了解配置本地开发环境所需的前置条件、安装步骤和可用命令。

关于项目架构、技术栈、约定和可用命令的完整概览，请参阅 [`CLAUDE.md`](CLAUDE.md)。

## 开始贡献

为了帮助你熟悉代码库，建议优先处理带有以下一个或多个标签的 Issue：[good-first-issue](https://github.com/CherryHQ/cherry-studio/labels/good%20first%20issue)、[help-wanted](https://github.com/CherryHQ/cherry-studio/labels/help%20wanted)或 [bug](https://github.com/CherryHQ/cherry-studio/labels/bug)。欢迎任何形式的帮助。

### 测试

按改动范围选择检查。文档检查文字和链接，素材直接校验变更文件，代码则运行覆盖变更及受影响调用方的测试。详情见[开发者指南](docs/dev/contrib/development.md)中的“Testing”部分。

### Pull Request 自动测试

有 CI 时，确认当前 PR 版本实际运行了哪些检查，并说明结果和仍未覆盖的范围。

### 考虑使用 Draft Pull Request

变更尚未完成或希望尽早获得反馈时，可创建 [draft pull request](https://github.blog/2019-02-14-introducing-draft-pull-requests/)。

### 代码评审与合并

维护者会尽力在合理时间内帮助你实现用例，并及时提供建设性反馈。如果在评审中遇到阻碍，或 PR 长时间没有得到处理，请在相关 Issue 中留言，或通过[社区](README.md#-community)联系我们。

### 参与 Test Plan

Test Plan 旨在为用户提供更稳定的应用体验和更快的迭代速度。详情请参阅 [Test Plan](docs/dev/contrib/test-plan.md)。

### 其他建议

- **联系开发者**：提交 PR 前，可以先联系开发者进行讨论或寻求帮助。

## 重要贡献规范与关注领域

提交 Pull Request 前，请阅读以下重要信息：

### 分支策略

`main` 是所有活跃开发的默认分支——feature、refactor、optimization 和 fix 都应提交到这里。


## 联系我们

如果有任何问题或建议，可以通过以下方式联系我们：

- WeChat：kangfenmao
- [GitHub Issues](https://github.com/CherryHQ/cherry-studio/issues)

感谢你的支持与贡献！期待与你一起让 Cherry Studio 变得更好。
