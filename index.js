/**
 * Desktop notifications for the Harness profile: one system toast when a turn
 * finishes, when the Agent asks the user a question, when a tool waits for the
 * user's approval, and when a background job settles. The plugin only observes;
 * it never answers, approves, or blocks the request it reports on.
 *
 * One file on purpose: the Loader re-reads this entry on every activation but
 * keeps its dependency modules cached, so a split sender module would keep
 * running stale code until the Host process restarts.
 * @module @local/dsh-desktop-notify
 */

import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

/** Loader identity of this plugin. */
export const name = 'desktop-notify'

/**
 * Windows AppUserModelID that owns the toast. It is the Desktop install's own
 * `dshDesktopAppId`, so every install of that build names itself the same way.
 */
const APP_ID = 'com.deepseek.dsh'

/**
 * PowerShell's own AppUserModelID. Windows refuses a toast whose AppUserModelID
 * has no registered Start Menu shortcut, and this one exists on every install,
 * so it backs up a profile that cannot resolve `APP_ID`.
 */
const POWERSHELL_APP_ID
  = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** The only URI the Desktop shell acts on; a click hands it to the `dsh` handler. */
const ACTIVATION_URL = 'dsh://open'

/** Process name whose foreground window means the user is already looking at the app. */
const FOCUS_PROCESS_NAME = 'DeepSeek Harness'

/** Delay before a finished turn is announced, so a follow-up turn cancels it. */
const QUIET_MS = 1200

/** Window in which an identical message is delivered once. */
const DEDUPE_MS = 4000

/** Toast text per language. */
const MESSAGES = {
  zh: {
    turnEndTitle: '会话完成',
    turnEndBody: title => title === undefined
      ? '回合已结束，等待你的下一步指令'
      : `「${title}」回合已结束，等待你的下一步指令`,
    turnErrorTitle: '会话出错',
    turnErrorBody: (title, detail) => title === undefined ? detail : `「${title}」${detail}`,
    questionTitle: '需要你的回答',
    questionBody: (text, remaining) => remaining > 0 ? `${text}（另有 ${remaining} 个问题）` : text,
    approvalTitle: '等待你的批准',
    approvalBody: (toolName, reason) => reason === undefined
      ? `工具 ${toolName} 需要你的授权`
      : `工具 ${toolName} 需要你的授权：${reason}`,
    jobTitle: {
      completed: '后台任务完成',
      killed: '后台任务已取消',
      failed: '后台任务失败',
    },
    jobBody: (label, detail) => detail === undefined ? label : `${label} · ${detail}`,
  },
  en: {
    turnEndTitle: 'Turn finished',
    turnEndBody: title => title === undefined
      ? 'The turn ended and waits for your next instruction'
      : `“${title}” ended and waits for your next instruction`,
    turnErrorTitle: 'Turn failed',
    turnErrorBody: (title, detail) => title === undefined ? detail : `“${title}” ${detail}`,
    questionTitle: 'Your answer is needed',
    questionBody: (text, remaining) => remaining > 0 ? `${text} (+${remaining} more questions)` : text,
    approvalTitle: 'Approval needed',
    approvalBody: (toolName, reason) => reason === undefined
      ? `Tool ${toolName} needs your approval`
      : `Tool ${toolName} needs your approval: ${reason}`,
    jobTitle: {
      completed: 'Background job finished',
      killed: 'Background job cancelled',
      failed: 'Background job failed',
    },
    jobBody: (label, detail) => detail === undefined ? label : `${label} · ${detail}`,
  },
}

/** Longest toast headline; Windows truncates long titles mid-word. */
const MAX_TITLE = 80
/** Longest toast body line. */
const MAX_BODY = 240
/** Longest job label quoted in a body; a label is a whole command line. */
const MAX_LABEL = 90

/**
 * Plugin settings, rendered by the plugin's settings page and validated at
 * activation. Everything else is fixed behavior: focus suppression, the click
 * URI, the owning AppUserModelID, the turn-end delay, and deduplication are
 * design decisions, not options.
 */
export const Config = z.object({
  /** Toast text language. */
  language: z.union(['zh', 'en']).default('zh'),
  /** Play the Windows notification sound. */
  sound: z.boolean().default(true),
  /** Announce finished and failed turns; a turn the user cancelled stays silent. */
  turnEnd: z.boolean().default(true),
  /** Announce `ask_user_question` requests. */
  questions: z.boolean().default(true),
  /** Announce tool calls that wait for the user's approval. */
  approval: z.boolean().default(true),
  /** Announce settled background jobs. */
  jobs: z.boolean().default(true),
  /** Also announce child (subagent) sessions and their jobs. */
  childSessions: z.boolean().default(false),
})

/**
 * Windows toast script, run through `-EncodedCommand`. The payload arrives as
 * base64 JSON so no notification text is ever interpolated into PowerShell
 * source; the title and body are escaped before they enter the XML.
 */
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
  $title = [System.Security.SecurityElement]::Escape([string]$payload.title)
  $body = [System.Security.SecurityElement]::Escape([string]$payload.body)
  $silent = ''
  if (-not $payload.sound) { $silent = '<audio silent="true"/>' }
  $focused = $false
  try {
    Add-Type -Namespace DshNotifyFocus -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);'
    $handle = [DshNotifyFocus.Win32]::GetForegroundWindow()
    if ($handle -ne [System.IntPtr]::Zero) {
      $foregroundId = 0
      [void][DshNotifyFocus.Win32]::GetWindowThreadProcessId($handle, [ref]$foregroundId)
      $foreground = Get-Process -Id $foregroundId -ErrorAction SilentlyContinue
      if ($null -ne $foreground -and $foreground.ProcessName -eq '${FOCUS_PROCESS_NAME}') { $focused = $true }
    }
  } catch { $focused = $false }
  if (-not $focused) {
    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml("<toast activationType='protocol' launch='${ACTIVATION_URL}' duration='short'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual>$silent</toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $document
    foreach ($appId in @(__APP_IDS__)) {
      try {
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
        break
      } catch { }
    }
  }
} catch { }
`

/**
 * Quote one string as a PowerShell single-quoted literal.
 * @param value - literal text, possibly containing quotes.
 * @returns the quoted literal.
 */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

/**
 * Build the complete PowerShell command for one toast.
 * @param payload - base64-encoded UTF-8 JSON payload.
 * @param appIds - AppUserModelIDs to try in order.
 * @returns the script source for `-EncodedCommand`.
 */
function toastCommand(payload, appIds) {
  return TOAST_SCRIPT
    .replace('__PAYLOAD__', payload)
    .replace('__APP_IDS__', appIds.map(quotePowerShell).join(', '))
}

/**
 * Create the notifier the plugin keeps for its whole lifetime.
 * @param settings - validated plugin settings; only `sound` affects delivery.
 * @returns `{ send, dispose }`; `send` is synchronous and never throws.
 */
function createNotifier(settings) {
  const children = new Set()
  /** Most recent delivery time per dedupe key, so a repeated message stays quiet. */
  const recent = new Map()

  const launch = (command, args) => {
    try {
      // Not detached: a DETACHED_PROCESS console keeps PowerShell alive but
      // makes its WinRT toast silently vanish, and a notifier that outlives the
      // Host has nothing left to report on.
      const child = spawn(command, args, {
        stdio: 'ignore',
        windowsHide: true,
      })
      children.add(child)
      child.once('exit', () => children.delete(child))
      // A missing notifier binary reports here; the notification is simply lost.
      child.once('error', () => children.delete(child))
    } catch {
      // The sender process could not even be spawned; nothing else can observe it.
    }
  }

  const deliver = ({ title, body }) => {
    if (process.platform === 'win32') {
      const payload = Buffer.from(JSON.stringify({ title, body, sound: settings.sound }), 'utf8').toString('base64')
      const command = toastCommand(payload, [APP_ID, POWERSHELL_APP_ID])
      launch('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ])
      return
    }
    if (process.platform === 'darwin') {
      launch('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])
      return
    }
    launch('notify-send', ['--app-name=DeepSeek Harness', title, body])
  }

  return {
    /**
     * Deliver one notification unless an identical one was sent within
     * `DEDUPE_MS`.
     * @param message - `key` groups repeats, plus the toast title and body.
     */
    send(message) {
      const now = Date.now()
      const dedupeKey = `${message.key}\u0000${message.title}\u0000${message.body}`
      const previous = recent.get(dedupeKey)
      if (previous !== undefined && now - previous < DEDUPE_MS) return
      recent.set(dedupeKey, now)
      if (recent.size > 64) {
        for (const [key, time] of recent) {
          if (now - time >= DEDUPE_MS) recent.delete(key)
        }
      }
      deliver({ title: message.title, body: message.body })
    },
    /** Kill notifier processes still starting, so profile teardown leaves none behind. */
    dispose() {
      for (const child of children) {
        try {
          child.kill()
        } catch {
          // Already exited between the spawn and this teardown.
        }
      }
      children.clear()
      recent.clear()
    },
  }
}

/**
 * Flatten arbitrary text into one clipped toast line.
 * @param value - text from a session title, a question, or an error.
 * @param limit - maximum character count.
 * @returns the flattened text, at most `limit` characters.
 */
function clip(value, limit) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * Register the notification listeners on the profile's Host context.
 * @param ctx - owning Host context; disposing it removes every listener.
 * @param settings - validated plugin settings; omitted values fall back to the schema defaults.
 */
export function apply(ctx, settings) {
  const options = settings ?? {}
  const messages = MESSAGES[options.language] ?? MESSAGES.zh
  const notifier = createNotifier({ sound: options.sound ?? true })
  /** Last observed status per session, so only a running → idle edge notifies. */
  const observed = new Map()
  /** Pending announcements, keyed by session, so a follow-up turn cancels one. */
  const pending = new Map()

  const cancel = (id) => {
    const timer = pending.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    pending.delete(id)
  }

  ctx.effect(() => () => {
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    observed.clear()
    notifier.dispose()
  })

  /** The live session title, when the profile composes the title service. */
  const titleOf = (agent) => {
    try {
      return ctx.get('sessionTitle')?.get(agent.session)?.title
    } catch {
      // A disposed or detached session has no readable projection; the toast
      // keeps its untitled wording instead of failing the notification.
      return undefined
    }
  }

  const isChild = agent => agent.session?.header?.parentSession !== undefined
  const includeChildren = options.childSessions ?? false

  /**
   * Read the reason the turn just closed with. Every finished turn appends one
   * `turn/end`, so the last one describes the idle state being announced.
   * @param agent - the agent that went idle.
   * @returns the close reason, or undefined for a session without a turn end.
   */
  const turnOutcome = (agent) => {
    const events = agent.session?.events
    if (!Array.isArray(events)) return undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/end') return event.data?.reason
    }
    return undefined
  }

  /** Announce one finished turn, including how it ended. */
  const announceTurnEnd = (agent) => {
    const title = clip(titleOf(agent), MAX_TITLE) || undefined
    const reason = turnOutcome(agent)
    // The user cancelled this turn themselves: they are already looking at the
    // result, so a toast would only report an action they took.
    if (reason?.kind === 'aborted') return
    if (reason?.kind === 'error') {
      const detail = clip(reason.error?.message ?? 'error', MAX_BODY)
      notifier.send({
        key: 'turn',
        title: messages.turnErrorTitle,
        body: clip(messages.turnErrorBody(title, detail), MAX_BODY),
      })
      return
    }
    notifier.send({
      key: 'turn',
      title: messages.turnEndTitle,
      body: clip(messages.turnEndBody(title), MAX_BODY),
    })
  }

  if (options.turnEnd ?? true) {
    ctx.on('agent/status', ({ agent, status }) => {
      const id = String(agent.id)
      const previous = observed.get(id)
      observed.set(id, status)
      if (status === 'running') {
        cancel(id)
        return
      }
      if (status !== 'idle' || previous !== 'running') return
      if (!includeChildren && isChild(agent)) return
      const announce = () => {
        pending.delete(id)
        try {
          announceTurnEnd(agent)
        } catch {
          // Notification text assembly failed on an unusual session; the turn
          // itself is already finished and must not report an error.
        }
      }
      cancel(id)
      const timer = setTimeout(announce, QUIET_MS)
      timer.unref?.()
      pending.set(id, timer)
    })
  }

  if (options.questions ?? true) {
    // Waterfall: returning `next()` delegates to the profile's own answerer
    // (the Web UI), which is the only party allowed to claim the request.
    ctx.on('user-questions/request', (request, next) => {
      try {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const first = questions[0]
        if (first !== undefined) {
          const text = first.header === undefined
            ? first.question
            : `${first.header}：${first.question}`
          notifier.send({
            key: 'question',
            title: messages.questionTitle,
            body: clip(messages.questionBody(clip(text, MAX_BODY), questions.length - 1), MAX_BODY),
          })
        }
      } catch {
        // A malformed request is the answerer's problem, not a reason to break
        // the waterfall that delivers the question.
      }
      return next()
    })
  }

  if (options.approval ?? true) {
    ctx.on('approval/request', (request, next) => {
      try {
        const reporting = includeChildren || request.agent === undefined || !isChild(request.agent)
        if (reporting) {
          const displayed = request.displayReason?.[options.language] ?? request.displayReason?.en
          const reason = displayed ?? request.reason
          notifier.send({
            key: 'approval',
            title: messages.approvalTitle,
            body: clip(messages.approvalBody(request.toolName, reason === undefined ? undefined : clip(reason, MAX_BODY)), MAX_BODY),
          })
        }
      } catch {
        // Same containment: the approval prompt must still reach the user.
      }
      return next()
    })
  }

  if (options.jobs ?? true) {
    // The runtime exposes job completions as a filtered event stream, not
    // per-listener callbacks: `jobs.events.subscribe({ owners: 'all' }, ...)` is
    // what a profile-level plugin needs to see every session's jobs.
    const jobs = ctx.get('jobs')
    if (jobs !== undefined && typeof jobs.events?.subscribe === 'function') {
      ctx.effect(() => jobs.events.subscribe({ owners: 'all' }, (event) => {
        try {
          // Foreground tool calls are jobs too. `awaited` marks a settlement
          // whose waiting caller already collected the result, and a teardown is
          // not work the user is waiting on.
          if (event?.type !== 'settled' || event.awaited || event.cause === 'teardown') return
          const job = event.job
          const title = messages.jobTitle[job.status]
          if (title === undefined) return
          if (!includeChildren && job.owner !== undefined) {
            const parent = ctx.get('agents')?.get(job.owner)?.session?.header?.parentSession
            if (parent !== undefined) return
          }
          notifier.send({
            key: `job:${String(job.id)}`,
            title,
            body: clip(messages.jobBody(clip(job.label, MAX_LABEL), job.detail), MAX_BODY),
          })
        } catch {
          // Event delivery is fire-and-forget; a failed toast must not become a
          // job-registry error.
        }
      }))
    }
  }
}
