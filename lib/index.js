// Host half of dsh-transparent.
//
// THIS HALF IS THE ONE THAT CAN REACH THE WINDOW.
//
// The browser half rules the page: it strips the background and gives the
// composer its glass. But window transparency is a Win32/DWM property of the OS
// window, and it lives outside the page entirely — CSS cannot touch it.
//
// The host half runs as Node inside the desktop application, so it can spawn a
// process. That is the bridge: on activation it runs a small PowerShell helper
// which locates the DSH window and applies the transparency. The user no longer
// has to run anything after each restart.
//
// Why a helper script rather than native calls from Node: Node has no
// EnumWindows / SetLayeredWindowAttributes bindings. Shelling out to PowerShell
// with Add-Type is the shortest path that works on a stock Windows install.
//
// ORDERING: the host starts before the window exists, so the helper polls for
// the window instead of failing outright. The effect therefore lands a moment
// after launch rather than instantly.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'transparent'

const here = dirname(fileURLToPath(import.meta.url))

/** Run the window helper once. */
const applyWindowGlass = (alpha, watchSeconds) => new Promise((resolve) => {
  const script = join(here, '..', 'assets', 'window-glass.ps1')
  if (!existsSync(script)) {
    resolve({ ok: false, reason: 'helper script missing: ' + script })
    return
  }

  // Windows PowerShell is present on every supported Windows install; pwsh is
  // not. Prefer the guaranteed one.
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Alpha', String(alpha),
    // The app resets the window style during late startup, so the helper keeps
    // watching and re-applies. Verified against a real reset: same hwnd, the
    // LAYERED bit went back to 0 a moment after the first apply.
    '-Watch', String(watchSeconds),
  ]

  let out = ''
  let err = ''
  let child
  try {
    child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    resolve({ ok: false, reason: error.message })
    return
  }

  const timer = setTimeout(() => {
    try { child.kill() } catch { /* ignore */ }
    resolve({ ok: false, reason: 'timeout', out, err })
  }, (watchSeconds + 60) * 1000)

  if (child.stdout) child.stdout.on('data', (b) => { out += String(b) })
  if (child.stderr) child.stderr.on('data', (b) => { err += String(b) })
  child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, reason: error.message }) })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() })
  })
})

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  // 255 = do not fade the whole window (content stays crisp). Lower values make
  // the wallpaper more visible at the cost of fading images and text too.
  const alpha = Number.isFinite(cfg.alpha) ? cfg.alpha : 215

  /* Everything this half does happens in a child process whose output goes
     nowhere the user can see. When it silently failed after a restart there was
     no way to tell whether the spawn was refused, the helper could not find the
     window, or the apply was rejected. So the outcome is also appended to a log
     file that can simply be opened. */
  const logPath = join(tmpdir(), 'dsh-transparent.log')
  const log = (line) => {
    try {
      appendFileSync(logPath, new Date().toISOString() + '  ' + line + '\n')
    } catch { /* logging must never break activation */ }
  }

  const report = (res) => {
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log('[transparent] window helper: ' + (res.out || 'applied'))
      log('OK   ' + (res.out || 'applied'))
    } else {
      // eslint-disable-next-line no-console
      console.warn('[transparent] window helper failed: ' + res.reason + (res.err ? ' | ' + res.err : ''))
      log('FAIL ' + res.reason + (res.err ? ' | ' + res.err : '') + (res.out ? ' | out=' + res.out : ''))
    }
  }

  /* Window transparency is a Windows-only capability here: it is built on Win32
     (SetLayeredWindowAttributes) and DWM (DwmSetWindowAttribute), driven through
     powershell.exe. Elsewhere the browser half still runs — the background is
     still cleared, the glass still applies — so this degrades to a log line
     rather than an error. */
  if (process.platform !== 'win32') {
    // eslint-disable-next-line no-console
    console.log('[transparent] window transparency is Windows-only; skipping on ' + process.platform)
    log('SKIP unsupported platform ' + process.platform)
    ctx.effect(() => () => {}, 'dsh-transparent: window helper')
    return
  }

  // Fire and forget: a slow helper must not delay plugin activation.
  // Keep watching long enough for the app to finish starting up and settle.
  const watchSeconds = Number.isFinite(cfg.watch) ? cfg.watch : 3600
  applyWindowGlass(alpha, watchSeconds).then(report)

  ctx.effect(() => () => {
    // Nothing to tear down here. Reverting the window on unload would fight with
    // the next activation and would also undo a user's manual adjustment.
  }, 'dsh-transparent: window helper')
}

export default { name, apply }


