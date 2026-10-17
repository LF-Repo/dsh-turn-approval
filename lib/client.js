/**
 * dsh-turn-approval — 浏览器端（client half）
 *
 * 用官方扩展点替换审批卡片，不修改任何官方 bundle：
 *   `conversation.composer` 是 chain 槽位，其渲染器按 priority 升序遍历条目、
 *   取第一个 `select()` 匹配的组件渲染（官方实现：select 命中即 break，见
 *   dsh-client-ui-renderer/lib/client.js:1158-1176）。官方 ApprovalPanel 注册在
 *   priority 1，本插件以 priority -1 注册，因此由本卡片接管渲染、官方卡片被
 *   shadow（它的 PendingApproval 仍持有 waterfall，本卡片只调用它的 answer()）。
 *
 * 为什么不需要自己监听 approval/request：
 *   0.2.0-rc.2 的官方 answerApproval() 会 await 到用户回答为止，只有显式
 *   delegate() 才 next()（dsh-client-ui-approval/lib/client.js:284-310）。插件
 *   bundle 由 patch insert 追加（cordis-plugin-include 是 data.push，append-only），
 *   永远晚于官方 bundle 加载，客户端 $on 又没有 prepend 开关 —— 所以本插件
 *   不可能抢先拦截 waterfall。改为在渲染层接管是唯一稳定做法。
 *
 * approvalId 从哪来（防伪的关键）：
 *   dsh-user-approval 把 { id: randomUUID(), toolName, callId?, reason? } append 进
 *   session 日志（approval/asked）。approval/asked 属于客户端 Session Controller
 *   的 KNOWN_SESSION_EVENT_TYPES（dsh-api-session-controller/lib/client.js:140），
 *   durable 事件经 ClientAssistantStream 原样透传进会话事件窗口。因此本卡片
 *   通过 uiSession.provide() 注入一个 session 作用域标准源读取该窗口，取出
 *   与当前审批 (toolName, callId) 匹配、且其后没有同 id 的 approval/decided 的
 *   那条 asked 事件的宿主 id。它由宿主随机生成，模型读不到、猜不中。
 *
 * 样式：不复用官方 CSS module 哈希类名（哈希随官方构建变化），改为自带
 * `<style data-plugin-css>` 与自有类名，只借用官方主题 token（--dsw-* /
 * --dsh-*），与官方卡片视觉一致。
 */
window.__ModuleLoader__.load({
	id: "dsh-turn-approval",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Cordis 插件名（客户端）。 */
		const name = "dsh-turn-approval-client"

		/**
		 * 客户端服务依赖：uiSession 提供 pendingInteraction 席位与 provide()，
		 * slots 注册卡片，locale 提供文案，sessions 供 uiSession 解析绑定。
		 */
		const inject = ["sessions", "uiSession", "slots", "locale"]

		/** 本插件自己的 locale 命名空间。 */
		const NS = "turnApproval"
		const zh = {
			"waiting": "等待审批",
			"detail.aria": "审批详情",
			"escalation": "工具 {toolName} 请求越权执行",
			"reject": "拒绝",
			"allowOnce": "允许一次",
			"allowForTask": "允许本次任务",
			"grantFailed": "任务授权建立失败，本次未生效——可重试，或改用「允许一次」",
			"granting": "正在建立任务授权…"
		}
		const en = {
			"waiting": "Waiting for approval",
			"detail.aria": "Approval details",
			"escalation": "Tool {toolName} requests privileged execution",
			"reject": "Reject",
			"allowOnce": "Allow once",
			"allowForTask": "Allow for this task",
			"grantFailed": "Task grant could not be established — retry, or use Allow once",
			"granting": "Establishing task grant…"
		}

		//#region styles
		const css = [
			".ta_root{padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px;flex-direction:column;align-items:center;display:flex}",
			".ta_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);overflow:hidden}",
			".ta_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}",
			".ta_body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height);flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow-y:auto}",
			".ta_headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}",
			".ta_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);word-break:break-all;font-size:13px;line-height:20px}",
			".ta_error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:18px;padding:8px 16px 0}",
			".ta_actionRow{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex}",
			".ta_reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}",
			".ta_task[disabled]{cursor:progress}"
		].join("")
		const tagId = "dsh-turn-approval/TurnApprovalPanel.module.css"
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style")
			tag.dataset.plugin = "dsh-turn-approval"
			tag.dataset.pluginCss = tagId
			tag.textContent = css
			document.head.appendChild(tag)
		}
		//#endregion

		/** grant 端点：浏览器相对路径（与官方 present.host 同形，不带前导斜杠）。 */
		const GRANT_URL = "api/turn-approval/grant"

		/**
		 * 是否是官方 PendingApproval 交互。
		 *
		 * 官方类是未导出的（dsh-client-ui-approval/lib/client.js:152），无法
		 * `instanceof`；这里按结构判定，并对内部 `kind` 标签做二次收紧，避免
		 * 误选 user-questions / plan-review 的 pending 交互。
		 * @param interaction - pendingInteraction 席位上的候选值。
		 * @returns true 时该交互由本卡片接管。
		 */
		function isApprovalInteraction(interaction) {
			if (interaction === null || typeof interaction !== "object") return false
			if (typeof interaction.key !== "string") return false
			if (typeof interaction.toolName !== "string") return false
			if (typeof interaction.answer !== "function") return false
			if (typeof interaction.answerable !== "boolean") return false
			// kind 是内部约定标签；存在时必须是 approval，缺失时仅靠上面的结构判定。
			if ("kind" in interaction && interaction.kind !== "approval") return false
			return true
		}

		/**
		 * 从会话事件窗口里找出当前审批对应的宿主 approvalId。
		 *
		 * 匹配最近一条满足下列全部条件的 approval/asked：
		 *   toolName 相同、callId 相同、其后没有同 id 的 approval/decided。
		 *
		 * @param entries - 会话事件窗口条目。
		 * @param interaction - 当前 pending 审批交互。
		 * @returns 宿主 approvalId；找不到返回 undefined（此时「允许本次任务」不可用）。
		 */
		function approvalIdOf(entries, interaction) {
			const decided = new Set()
			let found
			// 由新到旧扫描：先收集 decided，再回退匹配 asked。
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index]
				if (entry === null || typeof entry !== "object" || entry.type === "transient") continue
				const event = entry.event
				if (event === null || typeof event !== "object") continue
				const data = event.data
				if (event.type === "approval/decided") {
					if (data !== null && typeof data === "object" && typeof data.id === "string") decided.add(data.id)
					continue
				}
				if (event.type !== "approval/asked") continue
				if (data === null || typeof data !== "object") continue
				const id = data.id
				if (typeof id !== "string" || decided.has(id)) continue
				if (data.toolName !== interaction.toolName) continue
				if (data.callId !== interaction.callId) continue
				if (found === undefined) found = id
			}
			return found
		}

		/**
		 * 请求宿主建立 turn-scoped grant。
		 * @param sessionId - 目标 session。
		 * @param approvalId - 宿主随机生成的审批 id。
		 * @returns Promise，失败即 reject（绝不伪装成功）。
		 */
		async function requestGrant(sessionId, approvalId) {
			const response = await fetch(GRANT_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ sessionId, approvalId })
			})
			if (!response.ok) throw new Error(`grant HTTP ${response.status}`)
			const body = await response.json()
			if (body === null || typeof body !== "object" || body.ok !== true) throw new Error("grant rejected")
			return body
		}

		/** 与官方 ApprovalCommand 同款的命令提取（依赖 dsh-client-ui-chat 的 Chat 快照结构）。 */
		function commandOf(call) {
			if (call === undefined || call === null) return undefined
			try {
				const args = JSON.parse(call.argsRaw)
				return typeof args.command === "string" ? args.command : undefined
			} catch {
				return undefined
			}
		}

		function ApprovalPanel(props) {
			const approval = props.matched
			// useChat 由 dsh-client-ui-chat 以 session 作用域标准源贡献；未加载时
			// 不可用，此时静默不显示命令行（绝不因缺依赖让整张卡片崩掉）。
			const command = typeof props.useChat === "function"
				? props.useChat((snapshot) => {
					if (approval.callId === undefined || snapshot === null || typeof snapshot !== "object") return undefined
					const nodes = snapshot.nodes
					if (nodes === null || typeof nodes !== "object" || typeof nodes.values !== "function") return undefined
					for (const node of nodes.values()) {
						const root = node !== null && typeof node === "object" && node.kind === "tool-call" ? node.data?.root : undefined
						if (root !== undefined && root.callId === approval.callId && !("kind" in root) && root.phase === "start") {
							return commandOf(root)
						}
					}
					return undefined
				})
				: undefined

			const approvalId = typeof props.useSessionEvents === "function"
				? props.useSessionEvents((snapshot) => {
					const entries = snapshot?.entries
					return Array.isArray(entries) ? approvalIdOf(entries, approval) : undefined
				})
				: undefined

			return react_jsx_runtime.jsx(ApprovalFlow, {
				pending: approval,
				sessionId: props.sessionId,
				approvalId,
				reason: approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason),
				command,
				t: props.t
			}, approval.key)
		}

		function ApprovalFlow({ pending, sessionId, approvalId, reason, command, t }) {
			const [answered, setAnswered] = react.useState(false)
			const [granting, setGranting] = react.useState(false)
			const [grantError, setGrantError] = react.useState(null)
			const answerable = pending.answerable

			const answer = (outcome) => {
				if (answered || !answerable) return
				setAnswered(true)
				pending.answer(outcome).catch(() => {
					setAnswered(false)
				})
			}

			/**
			 * 「允许本次任务」：先让宿主记录 turn-scoped grant，成功后才按
			 * allowed-once 结算当前请求。顺序不可颠倒——审批一旦 decided，
			 * 宿主侧 findPendingApproval 就不再认它，grant 会失败。
			 *
			 * grant 建立失败（非 2xx / 网络错误 / 非 ok）时绝不伪装成功：不消费
			 * 当前审批、显示明确错误、保持卡片可重试（也可改用「允许一次/拒绝」）。
			 */
			const allowForTask = () => {
				if (answered || !answerable || granting) return
				setGranting(true)
				setGrantError(null)
				requestGrant(sessionId, approvalId)
					.then(() => {
						// grant 已建立，现在才结算当前这条请求。
						setAnswered(true)
						return pending.answer("allowed-once")
					})
					.catch(() => {
						// grant 未建立：明确报错 + 卡片可重试。
						setGrantError(t("grantFailed"))
						setAnswered(false)
					})
					.finally(() => {
						setGranting(false)
					})
			}

			const disabled = answered || !answerable
			return react_jsx_runtime.jsx("div", {
				className: "ta_root",
				"data-approval-key": pending.key,
				"aria-busy": answered,
				children: react_jsx_runtime.jsxs("div", {
					className: "ta_card",
					children: [
						react_jsx_runtime.jsxs("div", {
							className: "ta_strip",
							children: [
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: answered ? "ongoing" : "warning" }),
								granting ? t("granting") : t("waiting")
							]
						}),
						react_jsx_runtime.jsxs("div", {
							className: "ta_body",
							"data-approval-scroll": "",
							tabIndex: 0,
							role: "group",
							"aria-label": t("detail.aria"),
							children: [
								react_jsx_runtime.jsx("div", { className: "ta_headline", children: reason ?? t("escalation", { toolName: pending.toolName }) }),
								command !== undefined && react_jsx_runtime.jsx("div", { className: "ta_command", children: command })
							]
						}),
						grantError !== null && react_jsx_runtime.jsx("div", { className: "ta_error", role: "alert", children: grantError }),
						react_jsx_runtime.jsxs("div", {
							className: "ta_actionRow",
							children: [
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									className: "ta_reject",
									disabled,
									onClick: () => {
										answer("rejected")
									},
									children: t("reject")
								}),
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled,
									onClick: () => {
										answer("allowed-once")
									},
									children: t("allowOnce")
								}),
								// ── 唯一新增：允许本次任务 ──
								// approvalId 缺失（事件窗口里还看不到这条 asked）时禁用，
								// 绝不发送无法通过宿主防伪校验的请求。
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									className: "ta_task",
									disabled: disabled || granting || approvalId === undefined,
									onClick: allowForTask,
									children: t("allowForTask")
								})
							]
						})
					]
				})
			})
		}

		/**
		 * 注册：
		 *   1. 一个 session 作用域标准源 `sessionEvents` → 渲染为 useSessionEvents，
		 *      供本卡片读取会话事件窗口里的 approval/asked.id；
		 *   2. conversation.composer 上 priority -1 的审批卡片（早于官方 1）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-turn-approval-client: dictionaries")

			// 把每个 session 绑定的 eventSource 作为标准 hook 暴露出去
			// （ClientSessions 的 binding 携带 eventSource，见
			// dsh-api-session-controller/lib/client.js:3478-3485）。
			ctx.effect(() => ctx.uiSession.provide({
				hooks: ["sessionEvents"],
				resolve: (binding) => ({ hooks: { sessionEvents: binding.eventSource } })
			}), "dsh-turn-approval-client: sessionEvents source")

			ctx.slots.inject("conversation.composer", () => ctx.slots.register({
				name: "conversation.composer",
				priority: -1,
				select: ({ pendingInteraction }) => isApprovalInteraction(pendingInteraction) ? pendingInteraction : null,
				locale: NS,
				inject: () => ({ resolveReason: (reason) => ctx.locale.resolveText(reason) })
			}, ApprovalPanel))
		}

		module.exports = { name, inject, apply }
		return module.exports
	}
})