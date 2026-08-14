/**
 * dsh-turn-approval 测试：node:test + 真实 @deepseek-ai/cordis Context。
 * 覆盖用户要求的 8 个行为测试 + 端点防伪造校验 + waterfall 集成顺序。
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
let seqCounter = 0
/** 造一个带自增 seq 的 session 事件。 */
function ev(type, data) {
  return { type, seq: ++seqCounter, time: Date.now(), data }
}
const turnStart = (turn) => ev('turn/start', { turn })
const turnEnd = (turn) => ev('turn/end', { turn, reason: { kind: 'success' } })
const asked = (id, toolName, reason) => ev('approval/asked', { id, toolName, reason })
const decided = (id, outcome) => ev('approval/decided', { id, outcome })
/** 造一个假 session（events 必须是按序数组）。 */
function session(id, events) {
  return { id, events }
}
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
  const start1 = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
  const end1 = { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'success' } } }
  const start2 = { type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } }
  assert.deepEqual(currentOpenTurn([start1]), { turn: 1, seq: 1 })
  assert.deepEqual(currentOpenTurn([start1, end1]), null)
  assert.deepEqual(currentOpenTurn([start1, end1, start2]), { turn: 2, seq: 3 })
  assert.equal(currentOpenTurn([]), null)
})

test('findPendingApproval：只认未被 decided 闭合的 ask', () => {
  const logs = [asked('a1', 'bash', 'x'), asked('a2', 'bash', 'y'), decided('a2', 'allowed-once')]
  assert.notEqual(findPendingApproval(logs, 'a1'), null)
  assert.equal(findPendingApproval(logs, 'a2'), null)
  assert.equal(findPendingApproval(logs, 'missing'), null)
})

/* ---------------- 用户要求 Test 1-8 ---------------- */
test('Test 1: 无 grant 时每个请求都交给 answerer（允许一次只批一个）', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1)])
  const calls = []
  // 同一 turn 两次升级，无 grant → 每次都走 next()（弹 UI）
  const r1 = ta.decide(escalation(s, 'danger-full-access', 'a'), spyNext(calls))
  assert.equal(r1, 'unavailable')
  const r2 = await ta.decide(escalation(s, 'danger-full-access', 'b'), spyNext(calls))
  assert.equal(r2, 'unavailable')
  assert.equal(calls.length, 2)
})

test('Test 2: 允许本次任务 — 同 turn 后续同类升级自动批准', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  const granted = ta.grantForSession('s1', 'a1', s.events)
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
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ta.grantForSession('s1', 'a1', s.events)
  assert.ok(ta.grants.has('s1'))
  ta.handleSessionEvent('s1', turnEnd(1))
  assert.ok(!ta.grants.has('s1'))
  const calls = []
  await ta.decide(escalation(s, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(calls.length, 1) // 重新询问
})

test('Test 4: 下一 turn 再次请求必须重新询问', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x'), turnEnd(1), turnStart(2)])
  ta.grantForSession('s1', 'a1', [turnStart(1), asked('a1', 'bash', 'x')])
  // 模拟极端情况：grant 未被 turn/end 监听清理，但会话已进入 turn 2
  const calls = []
  const r = await ta.decide(escalation(s, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(r, 'unavailable')
  assert.equal(calls.length, 1)
  assert.ok(!ta.grants.has('s1')) // 过期 grant 被清理
})

test('Test 5: session 隔离 — A 的 grant 不影响 B', async () => {
  const ta = createTurnApproval()
  const sA = session('A', [turnStart(1), asked('a1', 'bash', 'x')])
  const sB = session('B', [turnStart(1)])
  ta.grantForSession('A', 'a1', sA.events)
  const calls = []
  await ta.decide(escalation(sB, 'danger-full-access', 'y'), spyNext(calls))
  assert.equal(calls.length, 1) // B 正常询问
  const r = await ta.decide(escalation(sA, 'danger-full-access', 'z'), spyNext(calls))
  assert.equal(r, 'allowed-once') // A 自动批准
  assert.equal(calls.length, 1)
})

test('Test 6: 异常结束（session/agent dispose）后 grant 被清理', () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ta.grantForSession('s1', 'a1', s.events)
  assert.ok(ta.grants.has('s1'))
  ta.clearSession('s1') // 等价于 session/disposed、agent/disposed
  assert.ok(!ta.grants.has('s1'))
})

test('Test 7: 重启/恢复 = 无持久化，默认 fail closed', () => {
  const ta1 = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ta1.grantForSession('s1', 'a1', s.events)
  const ta2 = createTurnApproval() // 模拟进程重启后的新实例
  assert.equal(ta2.grants.size, 0)
})

test('Test 8: 权限类型隔离 — 只自动批准被授权的 danger-full-access', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ta.grantForSession('s1', 'a1', s.events)
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
test('grantForSession：无 open turn / approval 非 pending 时拒绝（fail closed）', () => {
  const ta = createTurnApproval()
  const closed = session('s1', [turnStart(1), turnEnd(1), asked('a1', 'bash', 'x')])
  assert.deepEqual(ta.grantForSession('s1', 'a1', closed.events), { ok: false, reason: 'no-open-turn' })
  const decidedLog = session('s2', [turnStart(1), asked('a2', 'bash', 'x'), decided('a2', 'allowed-once')])
  assert.deepEqual(ta.grantForSession('s2', 'a2', decidedLog.events), { ok: false, reason: 'not-pending' })
  assert.equal(ta.grants.size, 0)
})

test('aborted 请求：命中 grant 时也返回 cancelled，不吞请求', async () => {
  const ta = createTurnApproval()
  const s = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ta.grantForSession('s1', 'a1', s.events)
  const ac = new AbortController()
  ac.abort()
  const r = await ta.decide({ agent: { session: s }, reason: 'escalate sandbox to danger-full-access: y', signal: ac.signal }, () => 'unavailable')
  assert.equal(r, 'cancelled')
})

/* ---------------- cordis 集成：prepend 拦截顺序 + 端点全链路 ---------------- */
test('集成：grant 端点到 waterfall 拦截全链路（UI 行为等价）', async () => {
  const ctx = new Context()
  const routes = new Map()
  const s1 = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  const fakeSessions = { get: (id) => (id === 's1' ? s1 : undefined) }
  const fakeWebServer = {
    register: ({ kind, path, handler }) => {
      routes.set(path, { kind, handler })
      return () => routes.delete(path)
    }
  }
  ctx.provide('webServer', fakeWebServer)
  ctx.provide('sessions', fakeSessions)
  ctx.plugin({ name, inject, apply })
  await new Promise((resolve) => setImmediate(resolve)) // 让插件激活完成

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
  assert.ok(routes.has(GRANT_PATH))
  const requestBody = JSON.stringify({ sessionId: 's1', approvalId: 'a1' })
  const fakeReq = { [Symbol.asyncIterator]: async function* () { yield requestBody } }
  let status = 0
  let payload = null
  const fakeRes = {
    statusCode: 0,
    setHeader() {},
    end(body) {
      status = this.statusCode
      payload = body
    }
  }
  await routes.get(GRANT_PATH).handler(fakeReq, fakeRes)
  assert.equal(status, 200)
  assert.ok(JSON.parse(payload).ok === true)

  // 3) 同 turn 后续升级：自动批准，answerer 不再被触碰
  const mid = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'second'), () => 'unavailable')
  assert.equal(mid, 'allowed-once')
  assert.equal(answererReached, 1)

  // 4) turn/end 经 session/event 分发 → grant 清除
  ctx.emit('session/event', s1, turnEnd(1))
  const after = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'third'), () => 'unavailable')
  assert.equal(after, 'unavailable')
  assert.equal(answererReached, 2) // 重新询问

  // 5) 伪造/过期 approvalId → 端点拒绝
  const badBody = JSON.stringify({ sessionId: 's1', approvalId: 'not-real' })
  const badReq = { [Symbol.asyncIterator]: async function* () { yield badBody } }
  status = 0
  await routes.get(GRANT_PATH).handler(badReq, fakeRes)
  assert.equal(status, 409)

  // 6) 不存在的 session → 404
  const missingBody = JSON.stringify({ sessionId: 'nope', approvalId: 'a1' })
  const missingReq = { [Symbol.asyncIterator]: async function* () { yield missingBody } }
  status = 0
  await routes.get(GRANT_PATH).handler(missingReq, fakeRes)
  assert.equal(status, 404)
})

test('集成：无 grant 时 answerer 照常工作（不破坏原审批）', async () => {
  const ctx = new Context()
  const routes = new Map()
  const s1 = session('s1', [turnStart(1), asked('a1', 'bash', 'x')])
  ctx.provide('webServer', { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } })
  ctx.provide('sessions', { get: (id) => (id === 's1' ? s1 : undefined) })
  ctx.plugin({ name, inject, apply })
  await new Promise((resolve) => setImmediate(resolve))
  let answererReached = 0
  ctx.on('approval/request', (req, next) => { answererReached += 1; return 'allowed-once' })
  const outcome = await ctx.waterfall('approval/request', escalation(s1, 'danger-full-access', 'x'), () => 'unavailable')
  assert.equal(outcome, 'allowed-once')
  assert.equal(answererReached, 1) // 官方 answerer 的 'allowed-once' 原样通过
})
