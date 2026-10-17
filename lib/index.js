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
 * 授权来源约束（0.2.0-rc.2 的防伪机制）：
 *   grant 只能通过 web UI 按钮 → POST /api/turn-approval/grant 建立。
 *   0.1.x 让客户端回传宿主生成的 approvalId 来证明「请求对应一张真实的
 *   pending 审批卡片」。0.2.0-rc.2 里 approval/request 的**载荷**不再过线，
 *   但 approvalId 本身仍然可达客户端：dsh-user-approval 把它 append 进
 *   session 日志（approval/asked），而 approval/asked 属于客户端
 *   Session Controller 的 KNOWN_SESSION_EVENT_TYPES
 *   （dsh-api-session-controller/lib/client.js:140），其 durable 事件经
 *   ClientAssistantStream.replace() 原样透传进会话事件窗口
 *   （同文件 :1392-1426），所以客户端能读到**宿主随机生成的 id**。
 *   本版本据此把防伪绑定回到 approvalId，并要求它当下仍处于 pending：
 *     1. prepend 监听器在官方 answerer 之前看到每一条 approval/request，
 *        按 (callId, toolName) 把它与日志中最近的未决 approval/asked 配对；
 *     2. grant 端点只接受「仍 pending 的 approvalId + 同 session + 当前有
 *        open turn」，且一条 approvalId 只能消费一次（防重放）。
 *   模型仍然没有自签 task grant 的路径：approvalId 由宿主 randomUUID()
 *   生成，只存在于 session 日志与宿主内存；模型既读不到客户端会话事件
 *   窗口，也无法自行调用 grant 端点，更猜不中 128-bit 随机值。
 */

/**
 * SessionSeq 品牌构造器。
 *
 * `@deepseek-ai/dsh-session` 是宿主运行时内部包，不在公共 registry 上，直接
 * import 会让本插件在独立测试环境里无法解析。这里用可选的动态 import：宿主里
 * 模块一定可解析（届时与官方 hasOpenTurn 完全一致），解析不到时退化为同值数字
 * ——这是安全的，因为品牌在运行时被完全擦除（brandNumber 原样返回入参，见
 * @deepseek-ai/dsh-brand），而 Session.eventAt 的实现就是一次数组下标
 * （dsh-session/lib/index.js:1363-1365），不做任何品牌校验。
 */
let sessionSeq = (value) => value
const loadSessionSeq = import('@deepseek-ai/dsh-session')
  .then((mod) => {
    if (typeof mod?.SessionSeq === 'function') sessionSeq = mod.SessionSeq
  })
  .catch(() => {
    // 独立测试/工具环境没有宿主包：品牌擦除使同值数字等价，忽略即可。
  })

/** 暴露给测试：品牌解析完成后才为真（await loadSessionSeq 即可等待）。 */
export const sessionSeqReady = loadSessionSeq

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
 * 当前 open turn：从 `session.seq` 往回逐条扫描（eventAt），最近一个 turn
 * 边界即答案。
 *
 * 0.2.0-rc.2 禁止新的同步事件读取：`events` 全量数组、`eventAt()`、
 * `snapshotEvents()`、`ownEvents()` 都被标记为
 * “@deprecated … new calls are prohibited”（dsh-session/lib/index.js:1358,
 * 1370, 1385）。目前 Session 未提供非弃用的替代读取面，官方自身仍沿用旧调用：
 * `hasOpenTurn` 就是同一段 `seq` + `eventAt()` 往回扫描
 * （dsh-user-approval/lib/index.js:49-56）。本函数与官方逐行同构，跟随该惯例；
 * 若未来 Session 开放新的读取 API，两处应一并迁移。
 *
 * @param session - live Session（dsh-session 服务 get(id) 的返回值）。
 * @returns { turn, seq } 当最近边界是 turn/start；null 当最近边界是 turn/end
 *   或日志中没有 turn 边界（无 open turn）。
 */
export function currentOpenTurn(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(sessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') return { turn: event.data.turn, seq }
    if (event.type === 'turn/end') return null
  }
  return null
}

/**
 * 查找日志中尚未闭合的 approval（approval/asked 且其后无同 id 的
 * approval/decided）。宿主侧的事实来源，用于确认某条审批确实 pending。
 *
 * 0.2.0-rc.2 的 `id` 字段仍留在 session 日志里（dsh-user-approval 仍 append
 * `{ id, toolName, callId?, reason? }`），并且 `approval/asked` 属于客户端
 * Session Controller 的已知事件类型，会原样进入客户端会话事件窗口，因此本函数
 * 是客户端拿到的 approvalId 的权威校验方（防伪的唯一事实来源）。
 *
 * @param session - live Session。
 * @param approvalId - 审批 id。
 * @returns 匹配的 asked 事件；已决/不存在返回 null。
 */
export function findPendingApproval(session, approvalId) {
  let decidedAfter = false
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(sessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'approval/decided' && event.data.id === approvalId) decidedAfter = true
    if (event.type === 'approval/asked' && event.data.id === approvalId) {
      return decidedAfter ? null : event
    }
  }
  return null
}

/**
 * 创建 turn-scoped grant 状态机。纯内存、可注入、可测试。
 * @param sessions - 可选的 sessions 服务（dsh-session `get(id)`），端点注入。
 * @returns 一个持有 grants 的控制器。
 */
export function createTurnApproval(sessions) {
  /** @type {Map<string, { sessionId: string, turn: number, turnStartSeq: number, mode: 'danger-full-access', approvalId: string, createdAt: number }>} */
  const grants = new Map()
  /** 已经开过 grant 的审批 id（一条审批只能消费一次，防重放）。 */
  const consumedApprovals = new Set()

  const self = {
    /** 内部存储（测试/诊断用）。 */
    grants,
    /**
     * sessions 服务（grantForApproval 解析 live session 用）。端点是在
     * `ctx.inject(['webServer','sessions','connection'])` 里挂载的，晚于本控制
     * 器创建，因此必须经对象自身属性读取，不能闭包捕获创建时的实参。
     */
    sessions,

    /**
     * 由 web UI 按钮调用：把一条**当下仍 pending** 的审批升级为本 turn 的
     * danger-full-access grant。
     *
     * 防伪校验（三条全过才建立 grant，模型无法自签）：
     *   (a) approvalId 必须是本 session 日志里未决的 approval/asked.id
     *       —— 它由宿主 randomUUID() 生成，模型读不到、猜不中；
     *   (b) 该审批从未被消费过（一条审批只能开一次 grant，防重放）；
     *   (c) session 必须存在且当前有 open turn。
     *
     * @param sessionId - 目标 session。
     * @param approvalId - 卡片所属审批的宿主 id。
     * @returns { ok: true, turn } | { ok: false, reason }。
     */
    grantForApproval(sessionId, approvalId) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: 'bad-request' }
      if (typeof approvalId !== 'string' || approvalId === '') return { ok: false, reason: 'bad-request' }

      const session = self.sessions?.get(sessionId)
      if (session === undefined) return { ok: false, reason: 'session-not-found' }

      // (a) 审批必须当下仍然 pending（asked 之后没有同 id 的 decided）。
      if (findPendingApproval(session, approvalId) === null) return { ok: false, reason: 'approval-not-pending' }

      // (b) 一条审批只能开一次 grant。
      if (consumedApprovals.has(approvalId)) return { ok: false, reason: 'approval-already-used' }

      // (c) session 必须当前有 open turn。
      const open = currentOpenTurn(session)
      if (open === null) return { ok: false, reason: 'no-open-turn' }

      // 全部校验通过，此时才消费该审批 id：失败路径绝不消耗 id，
      // 否则一次 no-open-turn 会永久作废这条本可重试的审批。
      consumedApprovals.add(approvalId)

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

    /**
     * approval/request waterfall 拦截（必须在官方 UI answerer 之前注册，见
     * apply 中的 prepend）。命中 grant 时直接返回 'allowed-once'；否则把
     * request 交给下游官方 answerer 正常弹窗。
     *
     * 这里不再往 request 上挂任何东西：客户端卡片自己从会话事件窗口读
     * approval/asked 拿到宿主 id，无需在请求载荷里传递任何东西。
     *
     * @param req - ApprovalRequest（req.agent 提供 scope 与 session）。
     * @param next - waterfall 的下一段。
     * @returns ApprovalOutcome 或 next() 的结果。
     */
    decide(req, next) {
      if (req?.signal?.aborted === true) return Promise.resolve('cancelled')
      const agent = req?.agent
      if (agent === undefined || agent === null) return next()
      const session = agent.session
      if (session === undefined || session === null || typeof session.id !== 'string') return next()

      const grant = grants.get(session.id)
      if (grant === undefined) return next()

      const open = currentOpenTurn(session)
      if (open === null || open.turn !== grant.turn) {
        // grant 已过期（无 open turn / 已进入新 turn）——清理并正常询问。
        grants.delete(session.id)
        return next()
      }
      // 只自动批准用户明确批准的同一类别：danger-full-access。
      if (escalationMode(req.reason) !== grant.mode) return next()
      return Promise.resolve('allowed-once')
    },

    /** 删除一个 session 的全部 grant。 */
    clearSession(sessionId) {
      grants.delete(sessionId)
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

    /** 清空全部 grant（插件卸载时）。 */
    clearAll() {
      grants.clear()
      consumedApprovals.clear()
    }
  }
  return self
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
 *
 * 认证（重要）：这是权限提升端点，必须与官方 `/api/*` 路由一样先过
 * connection 服务的认证栅栏（loopback/trusted host + 同源 + 由本进程
 * secret 签名的浏览器 cookie，见 dsh-client-connection requestRejection）。
 * 官方实现（dsh-host-open-in-app）在每个 handler 开头调用 rejected()，
 * 不这样做会让**本机任意进程**都能给自己签发 turn 授权。
 *
 * @param turnApproval - createTurnApproval() 的控制器（持有 sessions 服务）。
 * @param request - node IncomingMessage。
 * @param response - node ServerResponse。
 * @returns undefined。
 */
async function handleGrant(turnApproval, connection, request, response) {
  const rejection = connection?.requestRejection?.(request)
  if (typeof rejection === 'number') {
    response.statusCode = rejection
    response.end()
    return
  }
  const respond = (status, body) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(body))
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return respond(405, { ok: false, error: 'method-not-allowed' })
  }
  let payload
  try {
    payload = await readJson(request)
  } catch {
    return respond(400, { ok: false, error: 'bad-request' })
  }
  const result = turnApproval.grantForApproval(payload?.sessionId, payload?.approvalId)
  if (!result.ok) {
    const status = result.reason === 'session-not-found' ? 404
      : result.reason === 'bad-request' ? 400
      : 409
    return respond(status, { ok: false, error: result.reason })
  }
  return respond(200, { ok: true, sessionId: payload.sessionId, turn: result.turn })
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
 *   1. approval/request prepend 拦截（先于官方 UI answerer，命中 grant 即自动放行）；
 *   2. session/event 监听 turn/end 清理；
 *   3. session/disposed、agent/disposed 清理；
 *   4. 注册 grant 端点（仅 web 组合，经 ctx.inject 延迟；端点自带认证栅栏）。
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
  // webServer + sessions + connection 可用时（web 组合）注册 grant 端点；
  // headless 下永不触发，属预期（没有 UI 就没有「允许本次任务」入口）。
  ctx.inject(['webServer', 'sessions', 'connection'], (scope) => {
    // sessions 在该 scope 上可用，端点用它解析 live session；connection 提供
    // requestRejection() 认证栅栏（该服务类型定义在浏览器侧包内，故本地取值）。
    turnApproval.sessions = scope.sessions
    const connection = Reflect.get(scope, 'connection')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: GRANT_PATH,
      handler: (request, response) => handleGrant(turnApproval, connection, request, response)
    }), 'turn-approval: grant route')
  })
  ctx.effect(() => () => turnApproval.clearAll(), 'turn-approval: clear grants on unload')
}