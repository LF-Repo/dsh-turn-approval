/**
 * dsh-turn-approval — Codex 风格的「允许本次任务」turn-scoped 临时授权。
 *
 * 语义：
 *   用户在某个 user message 触发的 Agent turn 内第一次批准「允许本次任务」
 *   时，本插件记录一个【仅内存】的 grant：{ sessionId, turn, mode }。
 *   同一 session + 同一 turn 内，后续同类 sandbox escalation
 *   （danger-full-access）由 approval/request waterfall 的 prepend 监听器
 *   自动返回 'allowed-once'（不再弹 UI）；turn/end、session dispose、
 *   agent dispose、进程重启 都使 grant 立即失效。不写入任何持久化状态，
 *   默认权限（workspace-write + ask）永不改变，也绝不把整个 session
 *   切成 danger-full-access。
 *
 * 沙箱升级分类（为什么用前缀正则而非结构化字段）：
 *   当前 Harness 的 ApprovalRequest（@deepseek-ai/dsh-user-approval）没有
 *   结构化的“升级目标”字段；唯一实际调用 approval.request() 的请求方是
 *   @deepseek-ai/dsh-sandbox 的 approveEscalation（tool-bash / tool-pwsh /
 *   tool-fs 家族共用），其 reason 是固定协议前缀：
 *       `escalate sandbox to <mode>: <justification>`
 *   因此这里用锚定词首的正则提取 mode（可区分 workspace-write 与
 *   danger-full-access），而不是对任意文本做脆弱的自由 includes 匹配。
 *   未来若 ApprovalRequest 增加结构化字段，可平滑替换此函数。
 *
 * 授权来源约束：
 *   grant 只能通过 web UI 按钮 → POST /api/turn-approval/grant 建立；
 *   端点校验 (a) session 存在且当前有 open turn，(b) 该 approvalId 在
 *   session 日志里确实处于 pending（approval/asked 未被 approval/decided
 *   闭合）。模型没有任何自启 task grant 的路径（无 /allow-this-task 之类
 *   的模型面命令；工具也无法伪造一个 pending approvalId）。
 */

/** 「允许本次任务」的授权端点（exact 路由）。 */
export const GRANT_PATH = '/api/turn-approval/grant'

/** 沙箱升级 reason 的固定协议前缀（dsh-sandbox approveEscalation 产生）。 */
const ESCALATION_RE = /^escalate sandbox to (workspace-write|danger-full-access): /

/**
 * 从 approval reason 提取结构化的升级目标 mode。
 * @param reason - ApprovalRequest.reason（未提供时视为非升级请求）。
 * @returns 'workspace-write' | 'danger-full-access'，非升级请求返回 undefined。
 */
export function escalationMode(reason) {
  const match = ESCALATION_RE.exec(typeof reason === 'string' ? reason : '')
  return match === null ? undefined : match[1]
}

/**
 * 当前 open turn：从事件日志尾部往回扫，最近一个 turn 边界。
 * @param events - session 事件日志（Session.events）。
 * @returns { turn, seq } 当最近边界是 turn/start；null 当最近边界是
 *   turn/end 或日志为空（无 open turn）。
 */
export function currentOpenTurn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start') return { turn: event.data.turn, seq: event.seq }
    if (event.type === 'turn/end') return null
  }
  return null
}

/**
 * 查找日志中尚未闭合的 approval（approval/asked 且其后无同 id 的
 * approval/decided）。这是 grant 端点的防伪造校验：只允许对真实 pending
 * 的审批建立 task grant。
 * @param events - session 事件日志。
 * @param approvalId - 审批卡片携带的 approval id。
 * @returns 匹配的 asked 事件；已决/不存在返回 null。
 */
export function findPendingApproval(events, approvalId) {
  let decidedAfter = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/decided' && event.data.id === approvalId) decidedAfter = true
    if (event.type === 'approval/asked' && event.data.id === approvalId) {
      return decidedAfter ? null : event
    }
  }
  return null
}

/**
 * 创建 turn-scoped grant 状态机。纯内存、可注入、可测试。
 * @returns 一个持有 grants Map 的控制器（decide/handleSessionEvent/
 *   grantForSession/clearSession/clearAll）。
 */
export function createTurnApproval() {
  /** @type {Map<string, { sessionId: string, turn: number, turnStartSeq: number, mode: 'danger-full-access', approvalId: string, createdAt: number }>} */
  const grants = new Map()

  return {
    /** 内部存储（测试/诊断用）。 */
    grants,

    /**
     * 由 web UI 按钮调用：校验并记录当前 turn 的 danger-full-access grant。
     * @param sessionId - 目标 session。
     * @param approvalId - 用户正在审批的 approval（必须 pending）。
     * @param sessionEvents - 该 session 的事件日志（校验用）。
     * @returns { ok: true, turn } | { ok: false, reason: 'no-open-turn' | 'not-pending' }。
     */
    grantForSession(sessionId, approvalId, sessionEvents) {
      const open = currentOpenTurn(sessionEvents)
      if (open === null) return { ok: false, reason: 'no-open-turn' }
      if (findPendingApproval(sessionEvents, approvalId) === null) return { ok: false, reason: 'not-pending' }
      grants.set(sessionId, {
        sessionId,
        turn: open.turn,
        turnStartSeq: open.seq,
        mode: 'danger-full-access',
        approvalId,
        createdAt: Date.now()
      })
      return { ok: true, turn: open.turn }
    },

    /** 删除一个 session 的全部 grant（session dispose / agent dispose 用）。 */
    clearSession(sessionId) {
      grants.delete(sessionId)
    },

    /** 清空全部 grant（插件卸载时）。 */
    clearAll() {
      grants.clear()
    },

    /**
     * 处理 session 事件：turn/end 立即失效；turn/start 出现新 turn 号也失效
     * （防御：崩溃修复等场景可能跳过 turn/end 直接开新 turn）。
     */
    handleSessionEvent(sessionId, event) {
      if (sessionId === undefined || event === undefined) return
      const grant = grants.get(sessionId)
      if (grant === undefined) return
      if (event.type === 'turn/end') {
        grants.delete(sessionId)
      } else if (event.type === 'turn/start' && event.data.turn !== grant.turn) {
        grants.delete(sessionId)
      }
    },

    /**
     * approval/request waterfall 拦截（必须在 UI answerer 之前注册，
     * 见 apply 中的 prepend）。命中 grant 时直接返回 'allowed-once'
     * （claim，不再询问）；否则调用 next() 交还官方 answerer 链。
     * @param req - ApprovalRequest（agent.session 提供 session 与日志）。
     * @param next - waterfall 的下一段。
     * @returns ApprovalOutcome 或 next() 的结果。
     */
    decide(req, next) {
      if (req?.signal?.aborted === true) return Promise.resolve('cancelled')
      const session = req?.agent?.session
      if (session === undefined) return next()
      const grant = grants.get(session.id)
      if (grant === undefined) return next()
      const open = currentOpenTurn(session.events)
      if (open === null || open.turn !== grant.turn) {
        // grant 已过期（无 open turn / 已进入新 turn）——清理并正常询问。
        grants.delete(session.id)
        return next()
      }
      // 只自动批准用户明确批准的同一类别：danger-full-access。
      if (escalationMode(req.reason) !== grant.mode) return next()
      return Promise.resolve('allowed-once')
    }
  }
}

/**
 * 读取请求体并解析 JSON（失败返回 null）。
 * @param request - node IncomingMessage。
 */
async function readJson(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  if (body === '') return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * POST /api/turn-approval/grant 处理器：校验并记录 task grant。
 * @param sessions - ctx.sessions（get(id) 取 live session）。
 * @param turnApproval - createTurnApproval() 的控制器。
 */
async function handleGrant(sessions, turnApproval, request, response) {
  const respond = (status, body) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  }
  let payload
  try {
    payload = await readJson(request)
  } catch {
    return respond(400, { ok: false, error: 'bad-request' })
  }
  const sessionId = payload?.sessionId
  const approvalId = payload?.approvalId
  if (typeof sessionId !== 'string' || sessionId === '' || typeof approvalId !== 'string' || approvalId === '') {
    return respond(400, { ok: false, error: 'bad-request' })
  }
  const session = sessions.get(sessionId)
  if (session === undefined) return respond(404, { ok: false, error: 'session-not-found' })
  const result = turnApproval.grantForSession(sessionId, approvalId, session.events)
  if (!result.ok) return respond(409, { ok: false, error: result.reason })
  return respond(200, { ok: true, sessionId, turn: result.turn })
}

/** Cordis 插件名。 */
export const name = 'dsh-turn-approval'

/**
 * 顶层不声明 inject：webServer/sessions 仅在 web 组合存在，声明为必选会让
 * headless profile（如官方 `dsh --profile demo`）启动时因等不到 webServer
 * 而失败。这里保持插件处处可激活，grant 端点改用 `ctx.inject()` 延迟注册
 * ——web 组合里 webServer 出现后自动挂载，headless 里静默跳过。
 */
export const inject = []

/**
 * 插件入口：
 *   1. approval/request prepend 拦截（先于 apiproxy 的 UI answerer）；
 *   2. session/event 监听 turn/end 清理；
 *   3. session/disposed、agent/disposed 清理；
 *   4. 注册 grant 端点（仅 web 组合，经 ctx.inject 延迟）。
 */
export function apply(ctx) {
  const turnApproval = createTurnApproval()

  ctx.effect(() => ctx.on('approval/request', (req, next) => turnApproval.decide(req, next), { prepend: true }),
    'turn-approval: approval/request intercept')
  ctx.effect(() => ctx.on('session/event', (session, event) => turnApproval.handleSessionEvent(session?.id, event)),
    'turn-approval: session/event cleanup')
  ctx.effect(() => ctx.on('session/disposed', (session) => turnApproval.clearSession(session?.id)),
    'turn-approval: session/disposed cleanup')
  ctx.effect(() => ctx.on('agent/disposed', (payload) => turnApproval.clearSession(payload?.agent?.session?.id)),
    'turn-approval: agent/disposed cleanup')
  // webServer + sessions 可用时（web 组合）注册 grant 端点；headless 下永不
  // 触发，属预期（没有 UI 就没有「允许本次任务」入口）。
  ctx.inject(['webServer', 'sessions'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: GRANT_PATH,
      handler: (request, response) => handleGrant(scope.sessions, turnApproval, request, response)
    }), 'turn-approval: grant route')
  })
  ctx.effect(() => () => turnApproval.clearAll(), 'turn-approval: clear grants on unload')
}
