import { Plugin } from "@opencode/plugin"

/* ------------------------------------------------------------------ *
 * 开关
 * ------------------------------------------------------------------ */

/** 功能一：让 AI 自己在回复末尾输出一个心情表情（模型自选，不限定集合）。 */
const AI_MOOD = true

/** 功能二：插件侧根据会话事件计算心情，以若干 emoji 追加在回复之后。 */
const PLUGIN_MOOD = true

/** 调试：把每次请求前剔除掉的条数打到 server log（`MOOD_DEBUG=1` + `--print-logs`）。 */
const DEBUG = (() => {
  try {
    return process.env.MOOD_DEBUG === "1"
  } catch {
    return false
  }
})()

// AI 心情指令。故意不限定表情集合：把 28 个 emoji 列进指令本身就要几十个 token，
// 而这里没有识别/映射需求，让模型自己选更省。
// 代价是模型可能选出多码位 emoji（如 👨‍💻），token 略高、个别终端渲染不出。
const INSTRUCTION = "用emoji符号输出你现在的心情在末尾"

/* ------------------------------------------------------------------ *
 * 功能二：插件侧心情计算
 * ------------------------------------------------------------------ */

/**
 * 会话事件 → 心情表情。
 *
 * 一个回合内每命中一次就记一个，回合结束时按发生顺序拼成 `😰😫` 这样的行，
 * 所以一行里可以跟任意个表情。事件名均已在本机 opencode v2.1.4 二进制里核实存在。
 */
const EVENT_MOOD: Record<string, string> = {
  "session.retry.scheduled": "😰", // 请求失败，正在重试（限流等）
  "session.tool.failed": "😫", // 工具执行报错
  "session.step.failed": "😵", // 整个 step 失败
  "session.compaction.started": "🥴", // 上下文吃紧，正在压缩
  "session.execution.interrupted": "😑", // 被用户打断
  "session.execution.failed": "😭", // 回合以失败告终
}

/** 一个回合顺顺利利时的心情。 */
const CALM_MOOD = "😌"

/**
 * 判断一条模型消息是不是功能二写出的心情行。
 *
 * 心情行落库时是 synthetic 消息，但 opencode 组装请求时（FW 的 `case"synthetic"`）
 * 会把它当成普通 user 消息塞进上下文：`dH.make({role:"user",content:H.text})`。
 * 实测在 context hook 里看到的是 `role: "user"` + content 为 part 数组
 * （`[{type:"text",text:"🔹😌"}]`），不是裸字符串，所以两种形状都要认。
 *
 * 按「整条消息就是 🔹 加一串 emoji」来认，而不是「含有 🔹」——
 * 用户自己打的带 🔹 的正文不会被误删。
 *
 * 用文本形状而不是记 id：重启后进程内的 id 集合就没了，但历史里的旧心情行还在。
 */
const MOOD_TEXT = /^🔹(?:[\p{Extended_Pictographic}\uFE0F\u200D])+$/u

const isMoodMessage = (message: any) => {
  if (!message || message.role !== "user") return false

  const content = message.content
  if (typeof content === "string") return MOOD_TEXT.test(content)

  // user 消息正常是 part 数组（实测心情行在这里也是数组），字符串分支只是兜底。
  if (!Array.isArray(content)) return false
  const texts = content.map((part: any) => (part?.type === "text" ? part.text : undefined))
  if (texts.some((text) => typeof text !== "string")) return false
  return texts.length > 0 && MOOD_TEXT.test(texts.join(""))
}

/**
 * 把心情行从待发消息里剔掉。
 *
 * 这是功能二真正的「不花 token」保证：`resume: false` 只保证不唤醒模型，
 * 但消息一旦落库，后续每一轮都会被当成 user 消息发给服务器。
 * context / compaction hook 拿到的 `event.messages` 就是最终要发出去的模型消息数组
 * （SessionModelRequest.prepare 里 `T = yield*P({... messages ...})` 之后直接用 `T.messages`），
 * 原地 splice 即可。内置 Plan 模式插件也是这么改 messages 的。
 */
const stripMood = (messages: any) => {
  if (!Array.isArray(messages)) return
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isMoodMessage(messages[i])) continue
    messages.splice(i, 1)
    removed++
  }
  if (DEBUG && removed > 0) console.log(`[mood] stripped ${removed} mood message(s)`)
}

/** 回合结束的事件；命中就结算这一轮累积的心情。 */
const TERMINAL = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/** sessionID → 本回合已累积的心情表情。 */
const buckets = new Map<string, string[]>()

/** sessionID → 该 session 的结算是否正在进行。防止同一回合重复写消息。 */
const settling = new Set<string>()

/** 只取用得上的两个字段，其余不关心。 */
interface MoodEvent {
  type?: string
  data?: { sessionID?: string }
}

export default Plugin.define({
  id: "mood",
  async setup(ctx) {
    /* ---- 功能一：AI 自己输出心情 --------------------------------- *
     * 只注册 context：agent loop 的每一步都会走这里。
     * title / compaction / generate 是各自独立的 hook，不注册就不触发，不浪费 token。
     *
     * 这是「追加」而非「拦截」：OpenCode 没有改写助手输出的 hook，
     * 所以表情会原样留在回复里。
     * ----------------------------------------------------------------- */
    if (AI_MOOD) {
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: INSTRUCTION })
      })
    }

    /* ---- 功能二（一半）：把历史里的心情行从请求里剔掉 -------------- *
     * 与 PLUGIN_MOOD 开关无关：即使关掉功能二，历史里已经落库的 🔹 行
     * 也不该继续喂给模型。
     * ----------------------------------------------------------------- */
    await ctx.session.hook("context", (event) => stripMood(event.messages))
    await ctx.session.hook("compaction", (event) => stripMood(event.messages))

    if (!PLUGIN_MOOD) return

    /* ---- 功能二：插件侧计算心情 ---------------------------------- *
     * 订阅事件流，累积一个回合内的异常信号；回合结束时用 synthetic
     * 写一条 emoji 的消息。
     *
     * `resume: false` 是关键：消息照常落库并显示，但不会把会话拉起来，
     * 因此不触发任何 LLM 调用、不花 token（已实测确认）。
     *
     * `description` 也必须给，否则消息落库了但桌面端不显示，见 settle() 内注释。
     * ----------------------------------------------------------------- */
    const controller = new AbortController()

    const settle = async (sessionID: string) => {
      // 同一 session 的结算并发保护：回合结束事件可能连着来两次，
      // 而 ctx.session.synthetic 是异步的，await 之前另一个 settle 已经跑掉了。
      // 没有这个闸门就会出现「一条 desc 为空、一条 desc 非空」的重复消息。
      if (settling.has(sessionID)) return
      settling.add(sessionID)

      try {
        const bucket = buckets.get(sessionID) ?? []
        buckets.delete(sessionID)
        const text = "🔹" + (bucket.length > 0 ? bucket.join("") : CALM_MOOD)

        // 写失败（session 已删等）不该影响插件本身，静默吞掉。
        //
        // description 必须给非空值，否则桌面端时间线会把消息丢掉。桌面端的过滤函数是：
        //   uf(e) = e.type===`user` || `assistant` || `shell` || `idle` ? false
        //          : e.type!==`synthetic` || !!e.description?.trim() || _e(e)
        // 对 synthetic 而言 description 为空 → uf 返回 false → 在
        // constructSessionMessageRows 里落到 `if(e.type!==`assistant`)return` 被整条丢弃，
        // 消息落库了但界面上看不见。
        //
        // 而 Notice 的 label 取 `e.description ?? e.text`，优先用 description。
        // 所以这里给 description 塞同一个字符串：既过渲染门槛，显示出来的也是这串 emoji。
        try {
          await ctx.session.synthetic({
            sessionID,
            text,
            description: text || "mood",
            resume: false,
          })
        } catch {}
      } finally {
        settling.delete(sessionID)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const { type, data } = event as MoodEvent
          const sessionID = data?.sessionID
          if (!type || !sessionID) continue

          // 先记账再结算：session.execution.failed 同时是「异常」和「回合结束」，
          // 顺序反了会把 😭 漏掉。
          const mood = EVENT_MOOD[type]
          if (mood) {
            const bucket = buckets.get(sessionID)
            if (bucket) bucket.push(mood)
            else buckets.set(sessionID, [mood])
          }

          if (TERMINAL.has(type)) {
            await settle(sessionID)
          }
        }
      } catch {}
    })()

    return () => {
      controller.abort()
      buckets.clear()
      settling.clear()
    }
  },
})
