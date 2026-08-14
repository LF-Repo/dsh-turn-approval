/**
 * dsh-turn-approval — 浏览器端（client half）
 *
 * 用官方扩展点替换审批卡片，不修改任何官方 bundle：
 *   `conversation.composer` 是 chain 槽位，其渲染器按 priority 升序遍历条目、
 *   取第一个 `select()` 匹配的组件渲染（官方实现：select 命中即 break）。
 *   官方 ApprovalPanel 注册在 priority 1，本插件以 priority 0 注册同名
 *   select 的审批卡片，从而在官方机制内 shadow 官方卡片。
 *
 * 组件树与样式：直接以官方 ApprovalPanel 为基线——相同的根容器/卡片/strip/
 * body/headline/command/actionRow 结构与官方 CSS 类名（官方 bundle 加载时
 * 已将对应 CSS 注入文档，同款类名即继承全部官方样式：响应式、滚动、暗色
 * 主题、键盘可访问性），仅在按钮行末尾新增「允许本次任务」按钮 + 最少状态
 * 逻辑。不注入任何自定义 CSS。
 *
 * 版本耦合说明：官方类名（bqrRRG_*）来自当前官方构建的 CSS module 哈希，
 * 若官方 bundle 重建导致哈希变化，需同步更新下方的 ApprovalPanelCss 映射。
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
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");

		/** Cordis 插件名（客户端）。 */
		const name = "dsh-turn-approval-client"

		/** 客户端服务依赖。 */
		const inject = ["slots", "locale"]

		/** 本插件自己的 locale 命名空间。 */
		const NS = "turnApproval"
		const zh = {
			"waiting": "等待审批",
			"detail.aria": "审批详情",
			"escalation": "工具 {toolName} 请求越权执行",
			"reject": "拒绝",
			"allowOnce": "允许一次",
			"allowForTask": "允许本次任务",
			"grantFailed": "任务授权建立失败，本次未生效——可重试，或改用「允许一次」"
		}
		const en = {
			"waiting": "Waiting for approval",
			"detail.aria": "Approval details",
			"escalation": "Tool {toolName} requests privileged execution",
			"reject": "Reject",
			"allowOnce": "Allow once",
			"allowForTask": "Allow for this task",
			"grantFailed": "Task grant could not be established — retry, or use Allow once"
		}

		/** 与官方 selectApproval 相同的选择器：匹配审批交互。 */
		const selectApproval = ({ interactions }) => interactions.find((i) => i.kind === "approval") ?? null

		/**
		 * 官方 ApprovalPanel.module.css 的类名映射（从官方 bundle 提取，
		 * 官方 bundle 已注入对应 CSS；同款类名即复用官方全部样式）。
		 */
		const ApprovalPanelCss = {
			root: "bqrRRG_root",
			card: "bqrRRG_card",
			strip: "bqrRRG_strip",
			dot: "bqrRRG_dot",
			body: "bqrRRG_body",
			headline: "bqrRRG_headline",
			command: "bqrRRG_command",
			actionRow: "bqrRRG_actionRow",
			reject: "bqrRRG_reject"
		}

		/** 从 tool/call 参数提取 shell 命令（官方 ApprovalPanel 同款）。 */
		function commandOf(call) {
			if (call === void 0) return void 0
			try {
				const args = JSON.parse(call.argsRaw)
				return typeof args.command === "string" ? args.command : void 0
			} catch {
				return
			}
		}
		function toolNode(node) {
			return node?.kind === "tool-call" ? node : void 0
		}
		function rootToolCall(snapshot, rootCallId) {
			return toolNode(snapshot.chat.nodes.get((0, _deepseek_ai_dsh_client_runtime_client.conversationContextKey)("tool-call", rootCallId)))?.data.root
		}

		/** 审批领域面（与官方 PendingApproval 等价）：转发载体 + 应答编码。 */
		function PendingApproval(wait) {
			this.wait = wait
		}
		Object.defineProperties(PendingApproval.prototype, {
			key: { get() { return this.wait.key } },
			toolName: { get() { return this.wait.payload.toolName } },
			reason: { get() { return this.wait.payload.reason } },
			callId: { get() { return this.wait.payload.callId } }
		})
		PendingApproval.prototype.answer = async function answer(outcome) {
			const receipt = await this.wait.respond({
				ok: true,
				value: {
					sessionId: this.wait.sessionId,
					approvalId: this.wait.payload.approvalId,
					outcome
				}
			})
			if (!receipt.accepted) throw new Error(`approval response rejected: ${receipt.reason}`)
		}

		/**
		 * 与官方 ApprovalPanel 完全一致的包装：mint 领域面 + 解析命令。
		 */
		function ApprovalPanel(props) {
			const approval = react.useMemo(() => new PendingApproval(props.matched), [props.matched])
			const command = props.useSession((snapshot) => {
				if (approval.callId === void 0) return void 0
				const root = rootToolCall(snapshot, approval.callId)
				if (root === void 0) return void 0
				return root.callId === approval.callId && !("kind" in root) ? commandOf(root) : void 0
			})
			return react_jsx_runtime.jsx(ApprovalFlow, {
				pending: approval,
				t: props.t,
				...(command === void 0 ? {} : { command })
			}, approval.key)
		}

		/**
		 * 与官方 ApprovalFlow 相同的卡片树（官方类名/结构/禁用态/可访问性），
		 * 仅新增「允许本次任务」按钮 + allowForTask 逻辑。
		 */
		function ApprovalFlow({ pending, command, t }) {
			const [answered, setAnswered] = react.useState(false)
			const [grantError, setGrantError] = react.useState(null)
			const answer = (outcome) => {
				setAnswered(true)
				pending.answer(outcome).catch(() => {
					setAnswered(false)
				})
			}
			// 「允许本次任务」：先请求宿主记录 turn-scoped grant，成功后才按
			// allowed-once 结算当前请求。grant 建立失败（非 2xx 或网络错误）
			// 时绝不伪装成功：不消费当前审批、显示明确错误、保持卡片可重试
			//（可重试或改用「允许一次/拒绝」）。「允许一次/拒绝」语义不变。
			const allowForTask = () => {
				setAnswered(true)
				setGrantError(null)
				let granted = false
				fetch("/api/turn-approval/grant", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ sessionId: pending.wait.sessionId, approvalId: pending.wait.payload.approvalId })
				})
					.then((response) => {
						if (!response.ok) throw new Error(`grant HTTP ${response.status}`)
						return response.json()
					})
					.then((body) => {
						if (body?.ok !== true) throw new Error("grant rejected")
						granted = true
						return pending.answer("allowed-once")
					})
					.catch(() => {
						if (!granted) {
							// 授权未建立：明确报错 + 卡片可重试。
							setAnswered(false)
							setGrantError(t("grantFailed"))
						} else {
							// grant 已建立但应答竞态失败：仅恢复按钮，不误报 grant 失败。
							setAnswered(false)
						}
					})
			}
			const css = ApprovalPanelCss
			return react_jsx_runtime.jsx("div", {
				className: css.root,
				"data-approval-key": pending.key,
				children: react_jsx_runtime.jsxs("div", {
					className: css.card,
					children: [
						react_jsx_runtime.jsxs("div", {
							className: css.strip,
							children: [react_jsx_runtime.jsx("span", { className: css.dot }), t("waiting")]
						}),
						react_jsx_runtime.jsxs("div", {
							className: css.body,
							"data-approval-scroll": "",
							tabIndex: 0,
							role: "group",
							"aria-label": t("detail.aria"),
							children: [
								react_jsx_runtime.jsx("div", {
									className: css.headline,
									children: pending.reason ?? t("escalation", { toolName: pending.toolName })
								}),
								command !== void 0 && react_jsx_runtime.jsx("div", {
									className: css.command,
									children: command
								})
							]
						}),
						grantError !== null && react_jsx_runtime.jsx("div", {
							style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, lineHeight: 18, padding: "0 16px 4px" },
							role: "alert",
							children: grantError
						}),
						react_jsx_runtime.jsxs("div", {
							className: css.actionRow,
							children: [
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									className: css.reject,
									disabled: answered,
									onClick: () => {
										answer("rejected")
									},
									children: t("reject")
								}),
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: answered,
									onClick: () => {
										answer("allowed-once")
									},
									children: t("allowOnce")
								}),
								// ── 唯一新增：允许本次任务 ──
								react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: answered,
									onClick: () => {
										allowForTask()
									},
									children: t("allowForTask")
								})
							]
						})
					]
				})
			})
		}

		/**
		 * 注册：priority 0（早于官方 ApprovalPanel 的 1）+ 相同 select →
		 * chain 选举先命中本卡片，官方卡片被 shadow；官方文件零改动。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-turn-approval-client: dictionaries")
			ctx.slots.inject("conversation.composer", () => ctx.slots.register({
				name: "conversation.composer",
				priority: 0,
				select: selectApproval,
				locale: NS
			}, ApprovalPanel))
		}

		module.exports = { name, inject, apply }
		return module.exports
	}
})
