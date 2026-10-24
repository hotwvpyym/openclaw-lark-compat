# OpenClaw Lark/Feishu Plugin — Community Compatibility Build（社区兼容版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.8.1-blue.svg)](https://openclaw.ai)

> **⚠️ 非官方版本声明 / NOT the official release**
>
> 本仓库是**社区维护的兼容适配版（Community Compatibility Build）**，基于飞书官方 `openclaw-lark` 插件源码（MIT 许可）二次开发，**并非飞书（Lark/Feishu）官方出品，也不享受任何官方支持**。
>
> 官方插件已于 **2026.7.16** 停止更新，无法在 OpenClaw 2026.9.x 及以上版本正常工作。本版本解决该问题，供社区自用与分享。
>
> *English: This is a community-maintained fork of the official Lark/Feishu plugin for OpenClaw (MIT licensed). It is NOT an official release and receives NO official support. The official plugin stopped at 2026.7.16 and is incompatible with OpenClaw 2026.9.x+; this build restores full functionality.*

---

## 一、这个插件解决什么问题（What this build fixes）

### 背景

| 事实 | 说明 |
|---|---|
| 官方插件停更 | `larksuite/openclaw-lark` 最后一个官方版本为 **2026.7.16**，之后官方不再维护 |
| 与新版 OpenClaw 不兼容 | 官方 2026.7.16 版无法安装/正常运行在 OpenClaw **2026.9.x 及以上**（插件 SDK API 已变化）；**2026.10.x 起官方移除了 `openclaw/plugin-sdk/command-auth` 子路径**，官方 7.16 的静态 import 会在插件注册前加载失败 |
| 官方新线门槛更高 | 官方替代插件 `@openclaw/feishu` 要求 OpenClaw **≥2026.9.8**，无法用于 9.7 及以下版本，且该插件**不提供卡片用量页脚（footer metrics）** |

### 本版本修复的核心问题（OpenClaw 2026.10.7 生产实测验证）

本社区版持续修复官方版在 OpenClaw 新版上的兼容性问题，**完整功能、完整配置、完整页脚指标**：

- **卡片页脚指标完整恢复**：`tokens / cache / context / model / 耗时 / 状态` 六项全部可用（官方版升级后仅剩状态与耗时）；
- **OpenClaw 10.x 全线兼容**：官方移除的 `command-auth` 子路径由内置双路径兼容层接管（9.x 走 legacy、10.x 走 `channel-ingress-runtime`），命令授权行为与 OpenClaw 10.x 主机其他渠道一致；
- **manifest 契约完整声明**：`contracts.tools` 等字段随 OpenClaw 校验演进同步补齐，agent 工具注册不再被 10.x 主机拒绝；
- **命令授权修复**：已配对主人未显式配置 `allowFrom` 时，系统命令不再被静默丢弃；
- **配置校验兼容**：`configSchema` 与源码同步，OpenClaw 10.x 严格校验下页脚六项等配置正常生效。

> 每个版本的详细变更（修复内容、根因、权威包 sha256）见 [GitHub Releases](https://github.com/hotwvpyym/openclaw-lark-compat/releases) 与仓库 [CHANGELOG](./CHANGELOG.md)。

### 保留的官方全部功能

本版本**完整保留官方插件全部功能**（40+ 飞书工具族），未删减任何能力：

| 类别 | 能力 |
|---|---|
| 💬 消息 | 读取消息（群聊/私聊历史、线程回复）、发送消息、回复消息、搜索消息、下载图片/文件 |
| 📄 文档 | 创建、更新、读取文档 |
| 📊 多维表格 Base | 管理 Base/数据表/字段/记录（增删改查、批量、高级筛选）、视图 |
| 📈 电子表格 | 创建、编辑、查看表格 |
| 📅 日历 | 管理日历与日程（增删改查、搜索）、参与人管理、忙闲查询 |
| ✅ 任务 | 任务（增删改查、完成）、任务清单、子任务、评论 |
| 📁 云盘/维基 | 云盘文件、知识库空间与节点 |
| 🔍 搜索 | 文档/消息搜索 |
| 🎴 交互卡片 | 实时状态更新（思考/生成/完成）+ 敏感操作确认按钮 |
| 🌊 流式输出 | 卡片内实时流式文本（私聊为流式、群聊为静态，设计如此） |
| 📊 卡片页脚六项 | 状态、耗时、Token 使用量、缓存命中、上下文占用、模型（全部可独立开关） |
| 🔒 权限策略 | 私聊/群聊灵活访问控制 |
| ⚙️ 群组高级配置 | 白名单、Skill 绑定、自定义系统提示词 |

---

## 二、兼容版本（Compatibility）

兼容 OpenClaw **2026.8.1 及以上所有稳定版**（当前最新验证版本：**2026.10.7**，生产实测；仅维护稳定版，beta 不在支持范围）。

已实测：`2026.8.1 / 2026.8.35 / 2026.9.6 / 2026.9.7（生产实测）/ 2026.9.8 / 2026.10.3 / 2026.10.5 / 2026.10.7（生产实测）`——typecheck 全 0 错误，生产服务器全功能实测通过（消息收发 / 插件加载 / 页脚六项 / 工具注册）。

架构说明：OpenClaw 8.x / 9.6 使用 `sessions.json` 会话存储，9.7+ 使用 per-agent SQLite；OpenClaw 10.4+ 将会话主表迁移为 `session_nodes`——插件对两种 schema 均兼容（直读 SQL 双路径探测表名，不可用时自动回退 SDK 读取）。

---

## 三、安装与使用（Installation & Usage）

### 前置要求

- **Node.js**：v22 或更高
- **OpenClaw**：2026.8.1 或更高（`openclaw -v` 查看）

### 安装方式

**方式 A：本地 tgz 安装（推荐，最可控）**

```bash
openclaw plugins install npm-pack:/path/to/hotwvpyym-openclaw-lark-2026.10.9.tgz --force --accept-capabilities
```

**方式 B：从 GitHub Release 下载**

在 [Releases](../../releases) 页面下载 `hotwvpyym-openclaw-lark-2026.10.9.tgz`，然后按方式 A 安装。

**方式 C：ClawHub / npm（发布后可用）**

```bash
openclaw plugins install @hotwvpyym/openclaw-lark      # ClawHub
openclaw plugins install npm:@hotwvpyym/openclaw-lark  # npm
```

安装完成后确认：

```bash
openclaw plugins list        # 应看到 openclaw-lark，版本 2026.10.9
openclaw gateway restart     # 若安装过程提示 drain 超时，用此命令兜底
```

### 启用与配置

```bash
# 启用飞书渠道（WebSocket 长连接 + 流式输出）
openclaw config set channels.feishu.enabled true
openclaw config set channels.feishu.websocket true
openclaw config set channels.feishu.streaming true

# 卡片页脚六项指标（默认即可全部打开）
openclaw config set channels.feishu.footer.status true    # 状态
openclaw config set channels.feishu.footer.elapsed true   # 耗时
openclaw config set channels.feishu.footer.tokens true    # Token 使用量
openclaw config set channels.feishu.footer.cache true     # 缓存命中
openclaw config set channels.feishu.footer.context true   # 上下文占用
openclaw config set channels.feishu.footer.model true     # 模型
```

### 行为说明

- **私聊**：流式输出（文字在卡片内实时滚动）；
- **群聊**：静态卡片（设计如此，避免刷屏）；
- **页脚指标**：`tokens/cache/context/model` 在每次回复完成后随卡片展示；
- **敏感操作**（如删除、批量操作）：卡片弹出确认按钮，需人工确认后执行。

---

## 四、风险与免责声明（Risk & Disclaimer）

**请在使用前完整阅读本节。**

1. **非官方声明**：本插件是社区适配版，**与飞书（Lark/Feishu）官方无关**，官方不提供任何支持、不承担任何责任；请勿将本插件相关问题提交给官方渠道。
2. **按现状提供（AS-IS）**：本插件按「现状」提供，**不提供任何明示或默示担保**，包括但不限于适销性、特定用途适用性、不侵权的默示担保。使用产生的任何后果由使用者自行承担。
3. **AI 自动化固有风险**：插件对接 OpenClaw AI 自动化能力，存在模型幻觉、不可预测执行、提示词注入等固有风险。授权飞书权限后，OpenClaw 将在授权范围内以你的用户身份执行操作，可能造成敏感数据泄露或未授权操作等高风险后果。
4. **使用建议**：强烈建议仅将机器人作为**私聊助手**使用，不要加入公开群聊或允许陌生人交互，避免权限滥用与数据泄露；生产环境使用前请充分评估。
5. **第三方条款**：插件运行时调用飞书开放平台 API，使用即视为同意遵守：
   - [飞书隐私政策](https://www.feishu.cn/en/privacy)
   - [飞书用户服务协议](https://www.feishu.cn/en/terms)
   - [Lark Privacy Policy](https://www.larksuite.com/privacy-policy)
   - [Lark User Terms of Service](https://www.larksuite.com/user-terms-of-service)
6. **兼容性边界**：虽已对 2026.8.1+ 全线做兼容验证，但 OpenClaw 与飞书 API 持续演进，未来版本可能出现新的不兼容；升级 OpenClaw 前请先验证本插件。
7. **授权与许可**：本插件基于官方 MIT 源码改造，保留官方版权声明，MIT 许可允许修改与再分发（详见 [LICENSE](./LICENSE)）；请勿以本插件名义冒充官方版本。

---

## 五、反馈与更新（Feedback & Updates）

**欢迎任何问题反馈！**

- 🐛 **Bug 报告**：请提交 [Issue](../../issues)，附上：OpenClaw 版本（`openclaw -v`）、插件版本（`openclaw plugins list`）、复现步骤、相关日志。
- 💡 **功能建议**：同样通过 Issue 提出。
- 🔄 **持续更新**：本仓库将跟随 OpenClaw 版本演进持续维护。升级方式三选一：
  - **热更新（推荐，无需重启 Gateway）**：`openclaw plugins update <id>` 或安装新版后执行 `openclaw plugins reload <id>`——OpenClaw 10.x 原生支持插件级热重载（60 秒 drain 窗口，失败自动回滚保留旧版本继续服务）；本插件已通过资源生命周期审计，兼容 reload；
  - **本地 tgz**：`openclaw plugins install npm-pack:/path/to/<新版.tgz> --force --accept-capabilities`（同名升级直接覆盖）；
  - **兜底**：`openclaw gateway restart`。

---

## 六、版本历史（Changelog）

每个版本的详细更新说明（修复内容、发布原因、权威包 sha256）请查看 [GitHub Releases](https://github.com/hotwvpyym/openclaw-lark-compat/releases)。

当前版本：**2026.10.9**（兼容 OpenClaw 2026.8.1 – 2026.10.7 stable；三渠道同源发布：npm / GitHub Release / ClawHub，包内容逐字节一致）。

> **2026.10.9 主要变更**：manifest 补齐 `contracts.tools` 声明（39 个 `feishu_*` 工具，与代码注册逐一对应，10.x 主机工具注册不再被拒）；修复 10.x 命令授权——已配对主人未显式配置 `allowFrom` 时，系统命令不再静默失败（`delivered=false`）。完整变更见 Releases。

---

## 七、许可证（License）

本项目基于 **MIT License** 分发，保留官方版权声明：

- Copyright (c) 2026 Lark Technologies Pte. Ltd.（官方原始版权）
- 本适配版在原作基础上修改，见 [LICENSE](./LICENSE) 全文。

---

## 致谢（Acknowledgements）

- [飞书官方 openclaw-lark 插件](https://github.com/larksuite/openclaw-lark)（MIT）—— 本仓库的源码基底
- OpenClaw 社区 —— 测试与反馈
