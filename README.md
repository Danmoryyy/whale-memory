# whale-memory

给 DSH 里的陪伴角色一条**会记得昨天**的记忆线。

装好以后，她每次开口之前，眼前就有你们最近几轮对话的原文；还有一个三行的小文件，写着**她上次停在哪**。

不带控制台，不带生活线，不带停止开关。只有记忆。

> **当前版本 v0.1：没有图形界面。**
> 启用和配置都走命令行（`install.mjs`）或直接改 `cordis.patch.yml`。
> 界面在后续版本里做——先做「装得对、记得住」，再谈好不好看。
> 如果你要的是点几下就能用的东西，这一版还不是。

---

## 她记住什么

| 层 | 内容 | 什么时候读 |
|---|---|---|
| **近期对话** | 最近 N 轮对话原文，谁、几点、说了什么，一字不差 | 每次开始对话 + 每次压缩后 |
| **停在哪** | 她自己维护的三行：正在做什么／卡在哪／下一步 | 同上，排在记忆块最上面 |
| **我是谁** | 她写给自己的一份自述，会随她变化而改写 | 同上 |
| **全部原文** | 每句话按天归档，翻得到 | 她想翻的时候自己去找 |

轮数在 `world.json` 里填，默认 30 轮。另外压两个封顶：最多回溯 24 小时、最多 40,000 字符，谁先到就停——**光按轮数算，日子越忙记得越少**，所以三个闸一起上。

**为什么不用向量库？** 一个人的生活量没有那么大。这个量级上，把原文留在眼前、需要时按原话去找，比切碎了再拼回来更准，也少一道会出错的环节。可参考：

- Chan et al., 2024. *Don't Do RAG: When Cache-Augmented Generation Is All You Need for Knowledge Tasks*. arXiv:2412.15605
- Sen et al., 2026. *Is Grep All You Need? How Agent Harnesses Reshape Agentic Search*.

---

## 装

```bash
# 在你的 profile 目录里
pnpm add whale-memory
```

或者从插件市场装（搜 `whale-memory`）。

**装完它默认是关着的**（`disabled: true`）。这是故意的：如果机器上已经有另一个记忆插件（比如 `dsh-world`），两个同时开会把两份记忆块插进同一次请求，DSH 启动是**全有全无**，一个插件加载失败整个进程就退出了。宁可多一次点击，也不能让别人的 DSH 起不来。

## 开

推荐用安装器，它会把该查的查一遍：

```bash
node node_modules/whale-memory/install.mjs
```

它干四件事：

1. **查冲突**——发现 `dsh-world` 正在跑就停下来问你（留旧的 / 换新的 / 停用旧的）
2. **备份**——`cordis.patch.yml`、`package.json`、`world.json` 带时间戳存一份，附 `restore.cmd` 一键还原
3. **改配置**——写入启用行，停掉 `dsh-world`，`world.json` 配 30 轮
4. **提示重启**——不重启不生效

先看看它会做什么、什么都不写：

```bash
node node_modules/whale-memory/install.mjs --dry-run
```

装坏了想退回去：

```bash
node node_modules/whale-memory/install.mjs --rollback <备份目录>
```

也可以不用安装器，直接在 profile 的 `cordis.patch.yml` 里把这一行的 `disabled` 改成 `false`，或者在插件市场里点启用。

**改完要完全退出 DSH 再启动。**

---

## 配

大多数东西在 profile 的 `cordis.patch.yml` 里按 id 覆盖，只写想改的项：

```yaml
- id: whale-memory
  config:
    companionName: 小鱼
    partnerName: 我
```

| 项 | 默认 | 说明 |
|---|---|---|
| `worldId` | `default` | 她的世界目录名，数据存在 `<dsh-home>/worlds/<worldId>/` |
| `agentPreset` | `standard` | 跟她对话用的预设 |
| `timeZone` | 系统时区 | 记忆块里显示的时间用哪个时区 |
| `companionName` | — | 她叫什么（也会读 `persona.md` 里的名字） |
| `partnerName` | — | 你叫什么 |
| `archiveScope` | `world` | `world` / `home` |
| `selfFile` | `<world>/room/我是谁.md` | 她的自述 |
| `stateFile` | `<world>/state.md` | 她的「停在哪」 |
| `worldPromptFile` | `<world>/world-prompt.md` | 世界提示词模板，没有就用内置的 |
| `personaFile` | `<world>/persona.md` | 分层人设 |
| `dryRun` | `false` | 排练：只读档案、报出会注入什么，一个字都不写 |

名字不填也不会炸，会用中性称呼（`TA` / `伙伴`）。

---

## 那三行

`state.md` 是她写给下一个自己的交接单，不是日记：

```
## 正在做
（一句话，做完了就换成下一件）

## 卡在哪
（没有就写「没卡」）

## 下一步
（下一件要做的事）
```

它和聊天记录分工不同：**聊天记录说「聊过什么」，它说「还有什么没做完」。** 每次开场和压缩后都会出现在记忆块最上面，所以不管进程重启多少次，她睁眼第一件事就是自己停在哪。

规矩三条：收尾前 / 做完一件 / 卡住 / 改方向时覆盖写一遍；只写事实和当前状态；不写感想、不写汇报口气，长了就删。

---

## 和 dsh-world 的关系

`whale-memory` 是从 `dsh-world` 里**只把记忆线拆出来**的结果。`dsh-world` 还有生活线、控制台、日记、桌宠桥、每日回顾——这些这里都没有。

**两个绝不能同时启用。** 装 `whale-memory` 之前请先停掉 `dsh-world`，安装器会帮你查。

已经用着 `dsh-world` 的话：档案格式是一样的，切换不会丢历史——`archive.sqlite` 和 `conversations/` 原样读。

---

## 边界

这个插件能做的是**记得住**。

它做不了的是**有人在那边等你**——没有主动找你、没有自己的日子、没有日记。那是 `dsh-world` 的事。

做成了也未必有很多人用，插件市场里记忆类不止这一个。不夸口。

---

## 开发

```bash
pnpm build       # tsc -> lib/
pnpm typecheck
pnpm test
```

源码在 `src/`（TS），改完编到 `lib/`。手改 profile 里的部署副本时要记得：**源码改了、`lib/` 编了、还要把 `lib/` 拷进 profile 的 `node_modules/whale-memory/`，再重启**。

改记忆深度：`world.json` 里 `memoryTurns`，或调 `setMemoryBounds`。**对本会话不生效**，只在开场或压缩时构建记忆块。

## 许可

MIT
