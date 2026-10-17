# dsh-turn-approval · Task-Scoped Approval

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[中文](README.md) | English

Some high-risk actions deserve your explicit approval. Repeating that approval for the same task should not be necessary.

`dsh-turn-approval` adds an **Allow for this task** action to the DeepSeek Harness (DSH) Web approval card. When an agent requests `danger-full-access`, you can allow matching escalations for the rest of the current task only. The grant disappears when the task ends.

![DSH approval card with an Allow for this task button](assets/approval-card.png)

## What it does

The default DSH permission remains `workspace-write + ask`; this plugin never changes it into a global high-permission mode.

For a `danger-full-access` request, the approval card offers:

```text
[Reject] [Allow once] [Allow for this task]
```

- **Reject** declines the current action.
- **Allow once** permits only the current action.
- **Allow for this task** automatically permits later matching `danger-full-access` requests in the current turn, then expires immediately at `turn/end`.

## Install

### Install from GitHub

Pin a commit SHA so later repository updates cannot silently change the code running on your machine:

```sh
dsh plugin --profile web add github:arrow949/dsh-turn-approval#<commit-sha>
```

The repository ships built, pure ESM JavaScript. A GitHub install needs neither a `prepare` script nor pnpm `allowBuilds` permission.

### Install from a local directory

```sh
dsh plugin --profile web add ./dsh-turn-approval
```

Restart DSH Web and hard-refresh the browser (`Ctrl+Shift+R`). The third button confirms that the plugin has loaded.

## Use

1. Use DSH normally; the default remains `workspace-write + ask`.
2. When the agent requests `danger-full-access`, review the approval reason and command.
3. To allow matching escalations for the remainder of the **current task**, select **Allow for this task**.
4. The next user message starts a new task and prompts again as usual.

## Verify and uninstall

Verify that the profile contains the bundle layer:

```sh
dsh --profile web --dump-config
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-turn-approval
```

Uninstalling removes both the Node and client halves. The approval card automatically returns to the two-button DSH default, with no changes left in official DSH files.

## Security boundaries

- **Memory only**: grants are never written to disk. They expire when the DSH process restarts, the plugin unloads, or the session/agent is disposed (fail closed).
- **Task scoped**: a grant is bound to `session + turn`; it never turns an entire session into full access.
- **No cross-session grants**: a grant in one session cannot affect another. Subagents use distinct sessions and do not inherit it.
- **Type isolated**: only matching `danger-full-access` escalations are automatically allowed. `workspace-write` and other approvals still prompt individually.
- **User initiated**: only the approval-card action can create a grant; the model has no self-service task-grant route. The grant binds to a host-minted `randomUUID()` approval id that the model cannot read or forge, and one approval can open at most one grant.
- **Endpoint authenticated**: `/api/turn-approval/grant` first passes the official `connection` auth fence (trusted local origin, same-origin, and a cookie signed by this process's secret) or it is rejected.
- **Auditable**: automatically allowed requests retain their approval event records.

After **Allow for this task** is selected, the plugin first asks the host to create the task grant. If that endpoint returns a non-2xx response or the request fails, the card clearly reports the failure and remains retryable. It does not pretend the grant succeeded or silently downgrade to **Allow once**.

## Implementation and compatibility

This is an official DSH bundle: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` adds the plugin to a profile. Its client half takes over rendering of the approval card through the official `conversation.composer` chain slot at priority `-1` (ahead of the official card's `1`); it **does not modify any official DSH bundle file**, and uninstalling restores the standard UI.

The card ships its own styles (its own class names plus its own `<style>` element) and borrows only official theme tokens, so official restyling or class renames do not affect this plugin.

⚠️ **Compatibility boundary** (check this when upgrading DSH): this plugin relies on several **non-exported** internal shapes — structural detection of the pending approval interaction, reading the `id` of `approval/asked` from the session event window, and a tool-call node walk for the command line. These are stable behavior but not public API. If they break on upgrade the symptom is a **silent fall back to the official card** (this plugin stops taking over) without any broken approvals; a render fault instead shows that slot's error placeholder. Update the plugin in that case.

Web only: headless profiles have no UI entry point, so the task-grant endpoint is not registered there. The Node half still activates safely there — only the entry point is absent.

## Instructions for AI agents

After the user explicitly asks to install this plugin, run:

```sh
dsh plugin --profile web add github:arrow949/dsh-turn-approval#<commit-sha>
dsh --profile web --dump-config
```

Then ask the user to restart DSH Web and hard-refresh the browser. Do not modify official DSH bundle files. To uninstall:

```sh
dsh plugin --profile web remove dsh-turn-approval
```

## Development and tests

```sh
pnpm install
pnpm test
```

The current suite covers turn and session isolation, type isolation, endpoint anti-forgery, restart fail-closed behavior, and the Cordis integration path.

## License

MIT
