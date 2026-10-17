/**
 * dsh-turn-approval 测试：node:test + 真实 @deepseek-ai/cordis Context。
 * 覆盖用户要求的 8 个行为测试 + 端点防伪造校验 + 认证栅栏 + waterfall 集成顺序。
 *
 * 0.2.0-rc.2 适配要点：
 *   - fake session 实现 `seq` + `eventAt(SessionSeq)`（`events` 全量数组读取已
 *     被官方标记 @deprecated 且禁止新调用）；
 *   - grant 绑定从客户端签发的 nonce 回到宿主随机生成的 approvalId，且要求它
 *     当下仍 pending、一条审批只能消费一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  GRANT_PATH,
  apply,
  createTurnApproval,
  currentOpenTurn,
  escalationMode,
  findPendingApproval,
  inject,
  name
} from '../lib/index.js'

/* ---------------- 事件/会话构造助手 ---------------- */
/**
 * 造一个 0.2.0 形状的假 session：只暴露 `seq` 与 `eventAt()`，不提供已弃用的
 * `events` 数组（真实 Session 也正是这样被官方代码读取的）。
 */
function session(id, events) {
  const log = new Map(events.map((event) => [event.seq, event]))
  let seq = events.reduce((max, event) => Math.max(max, event.seq), 0)
  return {
    id,
    get seq() {
      return seq + 1
    },
    /** 追加一条事件：真实 Session 是活的，grant 过期检测依赖 seq 增长。 */
    append(event) {
      seq = event.seq
      log.set(event.seq, event)
      return event
    },
    eventAt(at) {
      return log.get(Number(at))
    }
  }
}
const turnStart = (turn, seq) => ({ type: 'turn/start', seq, time: seq, data: { turn } })
const turnEnd = (turn, seq) => ({ type: 'turn/end', seq, time: seq, data: { turn, reason: { kind: 'success' } } })
const asked = (id, toolName, seq, extra) => ({ type: 'approval/asked', seq, time: seq, data: { id, toolName, ...extra } })
const decided = (id, seq, outcome) => ({ type: 'approval/decided', seq, time: seq, data: { id, outcome } })

/** 造一个 sandbox 升级请求。 */
function escalation(sessionObj, mode, justification) {
  return {
    agent: { session: sessionObj },
    reason: `escalate sandbox to ${mode}: ${justification}`
  }
}

/** 记录 next() 是否被调用，并返回固定 fallback。 */
function spyNext(calls) {
  return () => {
    calls.push('next')
    return 'unavailable'
  }
}

/** 造一个 sessions 服务（dsh-session 的 get(id) 形状）。 */
function services(map) {
  return { get: (id) => map.get(id) }
}

/* ---------------- 纯函数 ---------------- */
test('escalationMode 解析固定协议前缀（锚定词首，非自由匹配）', () => {
  assert.equal(escalationMode('escalate sandbox to danger-full-access: install deps'), 'danger-full-access')
  assert.equal(escalationMode('escalate sandbox to workspace-write: temp writes'), 'workspace-write')
  assert.equal(escalationMode('escalate sandbox to danger-full-access'), undefined) // 缺 ": " 分隔符
  assert.equal(escalationMode('escalate sandbox to danger-full-accessX: x'), undefined) // 非合法 mode
  assert.equal(escalationMode('some unrelated approval reason'), undefined)
  assert.equal(escalationMode(undefined), undefined)
  assert.equal(escalationMode(''), undefined)
})

test('currentOpenTurn：最近边界决定 open turn', () => {
  assert.deepEqual(currentOpenTurn(session('s', [turnStart(1, 1)])), { turn: 1, seq: 1 })
  assert.deepEqual(currentOpenTurn(session('s', [turnStart(1, 1), turnEnd(1, 2)])), null)
  assert.deepEqual(currentOpenTurn(session('s', [turnStart(1, 1), turnEnd(1, 2), turnStart(2, 3)])), { turn: 2, seq: 3 })
  assert.equal(currentOpenTurn(session('s', [])), null)
})

test('findPendingApproval：只认未被 decided 闭合的 ask', () => {
  const s = session('s', [asked('a1', 'bash', 1), asked('a2', 'bash', 2, { reason: 'y' }), decided('a2', 3, 'allowed-once')])
  assert.notEqual(findPendingApproval(s, 'a1'), null)
  assert.equal(findPendingApproval(s, 'a2'), null)
  assert.equal(findPendingApproval(s, 'missing'), null)
})

/* ---------------- 用户要求 Test 1-8 ---------------- */
test('Test 1: 无 grant 时每个请求都交给 answerer（允许一次只批一个）', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1, 1)])
  const calls = []
  // 同一 turn 两次升级，无 grant → 每次都走 next()（弹 UI）
  const r1 = ta.decide(escalation(s, 'danger-full-access', 'a'), spyNext(calls))
  assert.equal(r1, 'unavailable')
  const r2 = await ta.decide(escalation(s, 'danger-full-access', 'b'), spyNext(calls))
  assert.equal(r2, 'unavailable')
  assert.equal(calls.length, 2)
})

test('Test 2: 允许本次任务 — 同 turn 后续同类升级自动批准', async () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  const granted = ta.grantForApproval('s1', 'a1')
  assert.deepEqual(granted, { ok: true, turn: 1 })
  // 第二次、第三次 → 自动 allowed-once，不弹 UI
  const calls = []
  const r2 = await ta.decide(escalation(s, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(r2, 'allowed-once')
  const r3 = await ta.decide(escalation(s, 'danger-full-access', 'z'), spyNext(calls))
  assert.equal(r3, 'allowed-once')
  assert.equal(calls.length, 0)
})

test('Test 3: turn/end 后 grant 立即清除', async () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  ta.grantForApproval('s1', 'a1')
  assert.ok(ta.grants.has('s1'))
  ta.handleSessionEvent('s1', turnEnd(1, 3))
  assert.ok(!ta.grants.has('s1'))
  const calls = []
  await ta.decide(escalation(s, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(calls.length, 1) // 重新询问
})

test('Test 4: 下一 turn 再次请求必须重新询问', async () => {
  // 会话在 turn 1 内被授权，随后 turn 1 结束、turn 2 开始。
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  ta.grantForApproval('s1', 'a1')
  assert.ok(ta.grants.has('s1'))

  // 模拟极端情况：turn/end 监听未生效，但会话确实进入了 turn 2。
  s.append(turnEnd(1, 3))
  s.append(turnStart(2, 4))
  const calls = []
  const r = await ta.decide(escalation(s, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(r, 'unavailable')
  assert.equal(calls.length, 1)
  assert.ok(!ta.grants.has('s1')) // 过期 grant 被清理
})

test('Test 5: session 隔离 — A 的 grant 不影响 B', async () => {
  const sA = session('A', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const sB = session('B', [turnStart(1, 1)])
  const ta = createTurnApproval(services(new Map([['A', sA], ['B', sB]])))
  ta.grantForApproval('A', 'a1')
  const calls = []
  await ta.decide(escalation(sB, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(calls.length, 1) // B 正常询问
  const r = await ta.decide(escalation(sA, 'danger-full-access', 'z'), spyNext(calls))
  assert.equal(r, 'allowed-once') // A 自动批准
  assert.equal(calls.length, 1)
})

test('Test 6: 异常结束（session/agent dispose）后 grant 被清理', () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  ta.grantForApproval('s1', 'a1')
  assert.ok(ta.grants.has('s1'))
  ta.clearSession('s1') // 等价于 session/disposed、agent/disposed
  assert.ok(!ta.grants.has('s1'))
})

test('Test 7: 重启/恢复 = 无持久化，默认 fail closed', () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta1 = createTurnApproval(services(new Map([['s1', s]])))
  ta1.grantForApproval('s1', 'a1')
  const ta2 = createTurnApproval() // 模拟进程重启后的新实例
  assert.equal(ta2.grants.size, 0)
})

test('Test 8: 权限类型隔离 — 只自动批准被授权的 danger-full-access', async () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  ta.grantForApproval('s1', 'a1')
  const calls = []
  // workspace-write 升级：仍询问
  await ta.decide(escalation(s, 'workspace-write', 'y'), spyNext(calls))
  assert.equal(calls.length, 1)
  // 非升级 reason：仍询问
  await ta.decide({ agent: { session: s }, reason: 'some other tool needs approval' }, spyNext(calls))
  assert.equal(calls.length, 2)
  // 无 reason：仍询问
  await ta.decide({ agent: { session: s } }, spyNext(calls))
  assert.equal(calls.length, 3)
  // danger-full-access：自动批准
  const r = await ta.decide(escalation(s, 'danger-full-access', 'z'), spyNext(calls))
  assert.equal(r, 'allowed-once')
  assert.equal(calls.length, 3)
})

/* ---------------- 授权端点防伪造 ---------------- */
test('grantForApproval：无 open turn / 审批非 pending 时拒绝（fail closed）', () => {
  const closed = session('s1', [turnStart(1, 1), turnEnd(1, 2), asked('a1', 'bash', 3)])
  const closedApproval = session('s2', [turnStart(1, 1), asked('a2', 'bash', 2), decided('a2', 3, 'allowed-once')])
  const ta = createTurnApproval(services(new Map([['s1', closed], ['s2', closedApproval]])))
  assert.deepEqual(ta.grantForApproval('s1', 'a1'), { ok: false, reason: 'no-open-turn' })
  assert.deepEqual(ta.grantForApproval('s2', 'a2'), { ok: false, reason: 'approval-not-pending' })
  assert.equal(ta.grants.size, 0)
})

test('grantForApproval：一条审批只能消费一次（防重放）', () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  assert.deepEqual(ta.grantForApproval('s1', 'a1'), { ok: true, turn: 1 })
  // 第二次用同一条审批再签：必须拒绝
  assert.deepEqual(ta.grantForApproval('s1', 'a1'), { ok: false, reason: 'approval-already-used' })
})

test('grantForApproval：未知 / 跨 session 的 approvalId 一律拒绝', () => {
  const sA = session('A', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const sB = session('B', [turnStart(1, 1)])
  const ta = createTurnApproval(services(new Map([['A', sA], ['B', sB]])))
  assert.deepEqual(ta.grantForApproval('A', 'forged-id'), { ok: false, reason: 'approval-not-pending' })
  // A 的审批不能给 B 签发（B 的日志里根本没有这条 asked）
  assert.deepEqual(ta.grantForApproval('B', 'a1'), { ok: false, reason: 'approval-not-pending' })
  assert.equal(ta.grants.size, 0)
})

test('grantForApproval：session 不存在 / 参数非法时拒绝', () => {
  const ta = createTurnApproval(services(new Map()))
  assert.deepEqual(ta.grantForApproval('nope', 'a1'), { ok: false, reason: 'session-not-found' })
  assert.deepEqual(ta.grantForApproval('', 'a1'), { ok: false, reason: 'bad-request' })
  assert.deepEqual(ta.grantForApproval('s1', ''), { ok: false, reason: 'bad-request' })
  assert.deepEqual(ta.grantForApproval(undefined, undefined), { ok: false, reason: 'bad-request' })
})

test('aborted 请求：命中 grant 时也返回 cancelled，不吞请求', async () => {
  const s = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const ta = createTurnApproval(services(new Map([['s1', s]])))
  ta.grantForApproval('s1', 'a1')
  const ac = new AbortController()
  ac.abort()
  const r = await ta.decide({ agent: { session: s }, reason: 'escalate sandbox to danger-full-access: y', signal: ac.signal }, () => 'unavailable')
  assert.equal(r, 'cancelled')
})

/* ---------------- cordis 集成：prepend 拦截顺序 + 端点全链路 ---------------- */

/** 收集 webServer 注册的路由。 */
function router() {
  const routes = new Map()
  return {
    routes,
    register: ({ kind, path, handler }) => {
      routes.set(path, { kind, handler })
      return () => routes.delete(path)
    }
  }
}

/** 造一个最小可用的请求/响应对。 */
function exchange(body, { method = 'POST' } = {}) {
  const request = {
    method,
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield body
    }
  }
  const result = { status: 0, payload: null }
  const response = {
    statusCode: 200,
    setHeader() {},
    end(payload) {
      result.status = this.statusCode
      result.payload = payload
    }
  }
  return { request, response, result }
}

/** 在给定组合下激活插件并等待延迟注入完成。 */
async function activate(ctx, sessionMap, rejection = () => undefined) {
  const web = router()
  ctx.provide('webServer', web)
  ctx.provide('sessions', services(sessionMap))
  ctx.provide('connection', { requestRejection: rejection })
  ctx.plugin({ name, inject, apply })
  await new Promise((resolve) => setImmediate(resolve))
  return web.routes.get(GRANT_PATH)
}

test('集成：grant 端点到 waterfall 拦截全链路（UI 行为等价）', async () => {
  const ctx = new Context()
  const s1 = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const route = await activate(ctx, new Map([['s1', s1]]))
  assert.ok(route !== undefined)
  assert.equal(route.kind, 'exact')

  // 模拟官方 answerer（apiproxy 等）：注册在插件之后
  let answererReached = 0
  ctx.on('approval/request', (req, next) => {
    answererReached += 1
    return next()
  })

  // 1) 无 grant：请求到达 answerer（弹 UI）
  const before = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'first'), () => 'unavailable')
  assert.equal(before, 'unavailable')
  assert.equal(answererReached, 1)

  // 2) UI 点击「允许本次任务」→ POST grant 端点
  const ok = exchange(JSON.stringify({ sessionId: 's1', approvalId: 'a1' }))
  await route.handler(ok.request, ok.response)
  assert.equal(ok.result.status, 200)
  assert.ok(JSON.parse(ok.result.payload).ok === true)

  // 3) 同 turn 后续升级：自动批准，answerer 不再被触碰
  const mid = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'second'), () => 'unavailable')
  assert.equal(mid, 'allowed-once')
  assert.equal(answererReached, 1)

  // 4) turn/end 经 session/event 分发 → grant 清除
  ctx.emit('session/event', s1, turnEnd(1, 3))
  const after = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'third'), () => 'unavailable')
  assert.equal(after, 'unavailable')
  assert.equal(answererReached, 2) // 重新询问

  // 5) 伪造 approvalId → 端点拒绝
  const forged = exchange(JSON.stringify({ sessionId: 's1', approvalId: 'not-real' }))
  await route.handler(forged.request, forged.response)
  assert.equal(forged.result.status, 409)

  // 6) 不存在的 session → 404
  const missing = exchange(JSON.stringify({ sessionId: 'nope', approvalId: 'a1' }))
  await route.handler(missing.request, missing.response)
  assert.equal(missing.result.status, 404)
})

test('安全：端点必须先过 connection.requestRejection 认证栅栏', async () => {
  const ctx = new Context()
  const s1 = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  const route = await activate(ctx, new Map([['s1', s1]]), () => 401)
  const rejected = exchange(JSON.stringify({ sessionId: 's1', approvalId: 'a1' }))
  await route.handler(rejected.request, rejected.response)
  assert.equal(rejected.result.status, 401)
  assert.equal(rejected.result.payload, undefined) // 未建立任何 grant 响应体
})

test('安全：非 POST 方法被拒绝', async () => {
  const ctx = new Context()
  const route = await activate(ctx, new Map())
  const get = exchange(undefined, { method: 'GET' })
  await route.handler(get.request, get.response)
  assert.equal(get.result.status, 405)
})

test('集成：无 grant 时 answerer 照常工作（不破坏原审批）', async () => {
  const ctx = new Context()
  const s1 = session('s1', [turnStart(1, 1), asked('a1', 'bash', 2)])
  await activate(ctx, new Map([['s1', s1]]))
  let answererReached = 0
  ctx.on('approval/request', (req, next) => { answererReached += 1; return 'allowed-once' })
  const outcome = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'x'), () => 'unavailable')
  assert.equal(outcome, 'allowed-once')
  assert.equal(answererReached, 1) // 官方 answerer 的 'allowed-once' 原样通过
})

test('集成：headless 组合（无 webServer/connection）也能安全激活', async () => {
  const ctx = new Context()
  ctx.plugin({ name, inject, apply })
  await new Promise((resolve) => setImmediate(resolve))
  // 没有 webServer 时 ctx.inject 不触发，插件静默存活（无 grant 端点）。
  const s1 = session('s1', [turnStart(1, 1)])
  const calls = []
  const r = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'x'), spyNext(calls))
  assert.equal(r, 'unavailable')
  assert.equal(calls.length, 1)
})