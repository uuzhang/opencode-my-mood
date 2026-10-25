# mood

OpenCode 插件：在每条 AI 回复之后显示心情表情。有两个独立功能，各有开关。

## 启用

无需装依赖、无需改配置。插件在 `.opencode/plugins/mood/` 下，OpenCode 会自动加载——
把 `H:\AI\my-mood` 当项目打开即生效。

## 两个功能

| 功能 | 开关 | 输出 | 谁决定 |
|---|---|---|---|
| 一、AI 心情 | `AI_MOOD` | AI 回复末尾一个 emoji | 模型自己 |
| 二、插件侧心情 | `PLUGIN_MOOD` | 回复之后独立一行 `🔹` + emoji | 插件按会话事件计算 |

两个都开时，效果是这样：

```
user:       say ok
assistant:  ok 😌        ← 功能一：AI 心情，跟在助手消息末尾
synthetic:  🔹😰        ← 功能二：插件侧心情，独立气泡，位置在更后面
```

开关在 `.opencode/plugins/mood/index.ts` 顶部，默认都为 `true`：

```ts
const AI_MOOD = true
const PLUGIN_MOOD = true
```

只想保留一个就把另一个改成 `false`。改完保存，OpenCode 热重载插件，不用重启。

## 功能二：事件 → 心情映射

一个回合内每命中一次就记一个，回合结束时按发生顺序拼起来，所以 `🔹` 后面可以跟任意个表情：

| 事件 | 表情 |
|---|---|
| `session.retry.scheduled` | 😰 |
| `session.tool.failed` | 😫 |
| `session.step.failed` | 😵 |
| `session.compaction.started` | 🥴 |
| `session.execution.interrupted` | 😑 |
| `session.execution.failed` | 😭 |
| 一个回合无上述事件 | 😌 |

映射表就是 `index.ts` 里的 `EVENT_MOOD`，想加就加一条。回合结束以
`session.execution.succeeded` / `failed` / `interrupted` 为准。

## token 开销

| 项 | 大小 |
|---|---|
| 注入的指令（常驻 system prompt，命中 prompt cache） | ~10 token |
| 每次回复新增输出 | 1 个表情 ≈ 1–2 token |
| 功能二的 synthetic 消息 | **0 token**（请求前被剔掉，见下节） |

### 为什么 synthetic 消息是 0 token

`synthetic` 消息落库时是独立类型，但 opencode 组装请求时会把**所有历史条目**统一转成模型消息
（`PU` → `FW`），其中 `case "synthetic"` 是：

```js
return [dH.make({ id: H.id, role: "user", content: H.text })]
```

也就是被当成一条**普通 user 消息**塞进上下文——`resume: false` 只阻止「唤醒模型」，
不阻止它进入后续每一轮的请求。所以不加处理的话，🔹 行会和下一条用户消息一起发到服务器。

本插件在 `context` 和 `compaction` 两个 hook 里把它剔掉：

```ts
await ctx.session.hook("context", (event) => stripMood(event.messages))
await ctx.session.hook("compaction", (event) => stripMood(event.messages))
```

`context` hook 收到的 `event.messages` 就是最终要发出去的模型消息数组
（`SessionModelRequest.prepare` 里 `T = yield*P({ ... messages ... })` 之后直接用 `T.messages`），
原地 `splice` 即可生效。内置的 Plan 模式插件也是这么改 `messages` 的。
压缩走的是独立的 `compaction` hook，所以两个都要挂。

识别方式是**整条匹配** `^🔹<emoji>+$`（`MOOD_TEXT`），不是「含有 🔹」——
用户自己打的带 🔹 的正文不会被误删。用文本形状而不是记 id，是因为进程重启后 id 集合就没了，
但历史里的旧心情行还在；且 `FW` 的 synthetic 分支会丢弃 metadata，没法用 metadata 打标记。

调试：`MOOD_DEBUG=1` + `opencode run --standalone --print-logs` 时会打印
`[mood] stripped N mood message(s)`。注意普通 `--print-logs` 下这个 `console.log` 不一定可见，
需要确凿证据时以「问模型历史里有没有 🔹 开头的消息」为准（实测回答「没有」）。

## 已验证事实

在 opencode v2.1.4 / Windows 上实测：

- `ctx.session.hook("context", ...)` + `event.system.push({ type: "text", text })` 确实能把指令注入给模型。
- 模型会遵守指令：回复末尾输出表情（实测 `ok 😌`，`finish=stop`）。
- 指令文案越短越好：从「列 28 个 emoji 的英文长句」换成「用emoji符号输出你现在的心情在末尾」（14 字）后，注入开销从 ~140 token 降到 ~10 token，输出行为不变。
- `ctx.event.subscribe()` 能收到全部会话事件；回合结束事件只在回合真正结束时发出，实测要等模型跑完才会到。
- `ctx.session.synthetic({ sessionID, text, description, resume: false })` 会写入一条 synthetic 消息并显示，且**不触发 LLM 调用、不花 token**。不加 `resume: false` 则会拉起模型再回一次（已实测 15→19 条消息）。
- **synthetic 消息必须带非空 `description`，否则桌面端不显示**。桌面端时间线有个过滤函数：
  ```js
  function uf(e){return e.type===`user`||e.type===`assistant`||e.type===`shell`||e.type===`idle`?!1:e.type!==`synthetic`||!!e.description?.trim()||_e(e)}
  ```
  对 synthetic 而言 `description` 为空就判定「不是 notice」，随后在 `constructSessionMessageRows` 里落到 `if(e.type!==`assistant`)return` 被整条丢弃——API 里查得到，界面上看不见。而 Notice 的 label 取 `e.description ?? e.text`，优先用 description，所以要把同一串 emoji 同时放进 text 和 description。
- 端到端实测两个功能同时生效：`assistant: ok 🔹😐` + `synthetic: 🔹😵😑`。

## 已知边界

- **心情是模型按指令扮演的**（功能一），不是对模型内部状态的真实读取。
- **靠 prompt 约束，遵从度是概率性的**。实测同一个插件在不同模型上表现不同：qoder/auto 稳定输出，另一些模型会漏。这是功能一的固有软肋，插件无法强制。功能二不受影响，它是事件驱动的。
- 功能二的 `🔹` 行是**独立的 synthetic 消息**，不是追加进 AI 那条回复气泡里。OpenCode 没有编辑已生成助手消息的 API（message 路由只有 GET），这一点绕不过去。
- 功能二只统计本插件已订阅的事件，跨进程/重启后计数清零。
- 剔除只挂在 `context` 和 `compaction` 两个 hook 上（对话与压缩）。`title` / `generate`
  这类辅助请求不挂，理论上仍会带上历史里的 🔹 行——它们不进对话上下文，影响可忽略。
- 本插件不做识别、不做窗口联动。如果以后要接窗口，从 `session.text.ended` 拿最终文本、匹配末尾表情即可。
