# Desktop Notifications (`@local/dsh-desktop-notify`)

A Host-only profile bundle that pops a **Windows system notification** (a WinRT
toast attributed to *DeepSeek Harness*) when the Agent needs the user's
attention:

| Trigger | Toast |
| --- | --- |
| A turn finishes (`agent/status` running → idle) | 会话完成 / 会话出错 |
| The Agent asks a question (`user-questions/request`) | 需要你的回答 + the question |
| A tool call waits for approval (`approval/request`) | 等待你的批准 + tool and reason |
| A background job settles (`jobs.events` `settled`) | 后台任务完成 / 已取消 / 失败 |

A turn the user cancelled stays silent: `turn/end` records `reason.kind =
'aborted'`, and the user who pressed Stop does not need a toast about their own
action. Every other close reason — including `error` — still announces.

A job settlement announces only when it is background work: the event stream also
reports foreground tool calls (`awaited: true`), teardown cancellations
(`cause: 'teardown'`), and non-settled lifecycle events, and none of those toast.

Clicking a toast brings the Desktop window to the front (`dsh://open`, the only
URI the shell handles).

`suppressWhenFocused` (`false` by default) keeps the plugin quiet while the
Desktop window owns the foreground. It is decided **at delivery time**, not from
a live focus signal: the notifier process calls `GetForegroundWindow` and
compares the owning process name with `focusProcessName`, so the Host needs no
window state. The check fails open — an `Add-Type` or lookup failure still shows
the toast — and costs one PowerShell `Add-Type` compile (roughly half a second)
per delivery while it is enabled.

The plugin only observes. It returns `next()` unchanged from both waterfalls, so
the Web UI still owns the answer and the approval. Child (subagent) sessions are
skipped unless `childSessions` is set.

## Install

Installed as a profile bundle; the profile links this directory instead of
copying it:

```
plugin_manager install_bundle  ->  target: <absolute path to this directory>
```

Or from a published repository:

```
plugin_manager install_bundle  ->  target: https://github.com/<owner>/<repo>
```

## Editing needs a restart

The Host process keeps an imported plugin module for its lifetime, so a changed
`index.js` is **not** picked up by disabling and re-enabling the row, by
reinstalling the bundle, or by a profile config reload. Restart DeepSeek Harness
after editing. Everything lives in one file for this reason: a separate sender
module would keep stale code even when the entry is re-read.

## Configuration

Set these under the `desktop-notify` row in the profile's `cordis.patch.yml`
(`~/.dsh/profiles/<profile>/cordis.patch.yml`). A patch replaces the row's whole
`config`, so restate every key you want to keep.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the whole plugin off without removing the row |
| `language` | `zh` | `zh` or `en` toast text |
| `appId` | `com.deepseek.dsh` | Windows AppUserModelID owning the toast |
| `activationUrl` | `dsh://open` | URI a click activates; `''` makes toasts unclickable |
| `suppressWhenFocused` | `false` | Skip a toast while the configured window owns the foreground |
| `focusProcessName` | `DeepSeek Harness` | Process name (no `.exe`) whose foreground window counts as "the App" |
| `sound` | `true` | Play the notification sound |
| `turnEnd` | `true` | Announce finished and failed turns (cancelled ones stay silent) |
| `questions` | `true` | Announce `ask_user_question` requests |
| `approval` | `true` | Announce tool approvals |
| `jobs` | `true` | Announce settled background jobs |
| `childSessions` | `false` | Include subagent sessions and their jobs |
| `quietMs` | `1200` | Delay before a finished turn is announced; a follow-up turn cancels it |
| `dedupeMs` | `4000` | Window in which an identical message is delivered once |

## Notes and troubleshooting

- The toast is delivered by `powershell.exe -EncodedCommand`: notification text
  travels as base64 JSON and every value is escaped before it enters the XML, so
  no message text is ever interpolated into PowerShell source.
- The sender must **not** be spawned detached. A `DETACHED_PROCESS` console
  makes `Show()` return success while Windows drops the toast silently.
- The click target is a protocol activation, not a COM toast activator. Windows
  hands `dsh://open` to the registered `dsh` handler — the Desktop install
  registers `"DeepSeek Harness.exe" "%1"` — and the running instance takes focus
  through its single-instance handoff. An empty `activationUrl` leaves the toast
  unclickable.
- A click cannot select the session named in the toast. The shell only acts on
  `dsh://open` (it does not parse other `dsh://` URLs on Windows), the renderer
  has no session routing, and a plugin cannot drive the shell's argv handling.
  Selecting a session from a toast would need a change in the Desktop shell or a
  browser deep link served by a Client-half plugin.
- If no banner appears, the toast may still be in the notification center
  (Win+N). Check Settings → System → Notifications for banners and
  Do-not-disturb.
- If `appId` has no registered Start Menu shortcut, the toast falls back to
  PowerShell's own AppUserModelID and is attributed to *Windows PowerShell*.
- A profile whose permission preset maps to `approval: never` never asks, so the
  approval toast cannot fire there; that preset rejects before the answerer
  chain runs.
- The job trigger subscribes to `jobs.events` with `{ owners: 'all' }` at
  activation, so it sees every session's jobs; a profile that composes no job
  registry simply has no job toasts. This runtime has no `jobs.onJobDone` — an
  earlier version of this plugin called it and the job toast silently never
  fired, because the throw was contained inside `ctx.effect`.
- The API surface here was read from the **running** Host
  (`cordis_inspect_query` `Service`/`Event`), not from a source checkout: a
  checkout can be a different release than the installed Desktop app.
- macOS (`osascript`) and Linux (`notify-send`) fallbacks exist for source
  checkouts; only Windows was exercised.
