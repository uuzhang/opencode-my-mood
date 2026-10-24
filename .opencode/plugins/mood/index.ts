import { Plugin } from "@opencode/plugin"

/* ------------------------------------------------------------------ *
 * 开关
 * ------------------------------------------------------------------ */

/** 功能一：让 AI 自己在回复末尾输出一个心情表情（模型自选，不限定集合）。 */
const AI_MOOD = true

/** 功能二：插件侧根据会话事件计算心情，以若干 emoji 追加在回复之后。 */
const PLUGIN_MOOD = true

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
