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
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'transparent'

const here = dirname(fileURLToPath(import.meta.url))

/* Our own installed version, read from the manifest next to this file.

   Deliberately not a hard-coded constant: a constant is exactly the thing that
   goes stale, and the whole point of an update check is to notice when what is
   on disk differs from what is published. */
const readOwnVersion = () => {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch { return '' }
}

const PACKAGE_NAME = 'dsh-transparent'

/* Compare dotted numeric versions. Returns >0 when a is newer than b.

   Not a full semver implementation on purpose: the only question asked here is
   "is the published one newer than mine", and a wrong answer costs a log line.
   A prerelease suffix is ignored rather than ordered, which is honest about not
   having implemented the rules. */
const compareVersions = (a, b) => {
  const part = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const x = part(a)
  const y = part(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

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
  // Translucency over a light interface looks washed out, so the theme is
  // pinned to dark by default. Set false to leave the user's choice alone.
  const darkTheme = cfg.darkTheme !== false
  // Ask the registry once per activation whether a newer version exists.
  const updateCheck = cfg.updateCheck !== false
  // Actually update, rather than just say so. Off by default: this rewrites the
  // user's profile, and a failure part-way through leaves the plugin removed.
  const autoUpdate = cfg.autoUpdate === true

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

  /* ---------------------------------------------------------------------
     Pin the interface to the dark theme.

     Why this is done through the settings service rather than by setting an
     attribute on <body>: the theme is a durable user preference owned by the
     host, stored in the user-settings document as `ui-theme.preference`, with
     the values light | dark | system. Writing the setting is the official route
     — it survives a restart, it is visible in the settings UI, and it does not
     fight the app's own rendering, which would re-impose its own value on the
     next render anyway.

     Not done when `darkTheme` is false, and a failure here is reported rather
     than fatal: a plugin has no business breaking startup over a preference.

     This changes a durable setting belonging to the user. Uninstalling the
     plugin does not put it back — the README says so. */
  if (darkTheme) {
    ctx.inject(['settings'], (child) => {
      const svc = child.settings
      if (!svc || typeof svc.update !== 'function') {
        log('SKIP settings service exposes no update(); theme left as-is')
        return
      }

      /* Read before writing.

         `describe()` is synchronous and hands back the live value plus the
         revision it was read at. Two things follow from that, both worth having:

           - if the preference is already dark there is nothing to do, so the
             plugin does not rewrite the user's settings document on every start;
           - the revision goes back into `update` as a compare-and-set, so a
             change the user made in the settings UI in the meantime is not
             silently clobbered. */
      let entry = null
      try {
        const all = svc.describe()
        if (Array.isArray(all)) entry = all.find((d) => d && d.ns === 'ui-theme') || null
      } catch (error) {
        log('WARN could not read settings: ' + (error && error.message ? error.message : error))
      }

      const current = entry && entry.value && typeof entry.value === 'object'
        ? entry.value.preference
        : undefined

      if (current === 'dark') {
        // eslint-disable-next-line no-console
        console.log('[transparent] theme is already dark')
        log('OK   ui-theme.preference already dark')
        return
      }

      const revision = entry && Number.isFinite(entry.revision) ? entry.revision : undefined
      Promise.resolve(svc.update('ui-theme', { preference: 'dark' }, revision)).then(
        () => {
          // eslint-disable-next-line no-console
          console.log('[transparent] theme preference set to dark'
            + (current ? ' (was ' + current + ')' : ''))
          log('OK   ui-theme.preference ' + (current || '(unset)') + ' -> dark')
        },
        (error) => {
          const msg = error && error.message ? error.message : String(error)
          // eslint-disable-next-line no-console
          console.warn('[transparent] could not set the theme to dark: ' + msg)
          log('FAIL ui-theme.preference: ' + msg)
        },
      )
    })
  }

  /* ---------------------------------------------------------------------
     Update check.

     The plugin manager has no update action — an installed bundle cannot be
     re-installed over itself through the GUI, so keeping current means noticing
     a newer version and then replacing the bundle. Both halves of that are
     available to a host plugin through the `pluginManager` service:

       installBundle(spec)   downloads and activates; rewritten files land on
                             disk immediately, the running code changes on the
                             next start
       registries()          what this profile actually asks, so a user on the
                             China mirror is checked against the mirror rather
                             than being sent to a host they cannot reach

     The check is on by default and costs one small request. The update is NOT:
     it rewrites the user's profile, and a failure part way through leaves the
     plugin removed. That is not a risk to take on someone's behalf by default.

     A local or linked install is skipped entirely — `node_modules/<name>` is
     then a symlink into a working copy, and "updating" it would replace the
     developer's own checkout with a published tarball. */
  if (updateCheck) {
    const own = readOwnVersion()

    /* Only a package that really lives under node_modules is updatable.

       The obvious test — "is my own directory a symlink?" — does not work: Node
       resolves symlinks by default, so a linked install reports the real path of
       the working copy and the link is invisible from inside. What is visible is
       the path itself: a published install sits at
       `<profile>/node_modules/<name>/lib`, a working copy does not. Checking for
       that segment is both simpler and correct, and it keeps the update logic
       away from anyone running the plugin from a checkout — where "updating"
       would overwrite their source tree with a published tarball. */
    const installedUnderNodeModules = /[\\/]node_modules[\\/]/.test(here + '/')

    if (!installedUnderNodeModules) {
      log('SKIP update check: not installed under node_modules (working copy)')
    } else {
      ctx.inject(['pluginManager'], (child) => {
        const pm = child.pluginManager
        if (!pm || typeof pm.installBundle !== 'function') {
          log('SKIP update check: pluginManager service is unavailable')
          return
        }

        const run = async () => {
          let registry = 'https://registry.npmjs.org'
          try {
            const regs = await pm.registries()
            // `registry` is null when pnpm's own configuration decides; then
            // `resolved` says what pnpm actually reads.
            const chosen = (regs && regs.registry) || (regs && regs.resolved)
            if (typeof chosen === 'string' && chosen) registry = chosen.replace(/\/+$/, '')
          } catch { /* keep the default */ }

          const base = String(cfg.updateSource || '').replace(/\/+$/, '') || (registry + '/' + PACKAGE_NAME)
          const url = base + '/latest'
          let latest = ''
          try {
            const res = await fetch(url, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const body = await res.json()
            if (body && typeof body.version === 'string') latest = body.version
            else if (body && body['dist-tags'] && typeof body['dist-tags'].latest === 'string') latest = body['dist-tags'].latest
          } catch (error) {
            // A failed check is not a problem worth telling the user about: no
            // network, a private registry, an offline machine. Recorded only.
            log('SKIP update check failed: ' + (error && error.message ? error.message : error))
            return
          }

          if (!latest || !own) return
          if (compareVersions(latest, own) <= 0) {
            log('OK   up to date (' + own + ')')
            return
          }

          // eslint-disable-next-line no-console
          console.log('[transparent] v' + latest + ' is available (running ' + own + ')'
            + (autoUpdate ? ' — updating' : ' — set autoUpdate: true to fetch it automatically'))
          log('NEW  ' + own + ' -> ' + latest)

          if (!autoUpdate) return

          try {
            const result = await pm.installBundle(PACKAGE_NAME, { registry })
            const applied = result && result.application ? result.application : 'unknown'
            // eslint-disable-next-line no-console
            console.log('[transparent] update ' + applied + '; restart the client to run v' + latest)
            log('OK   update ' + applied + ' -> ' + latest + ' (restart required)')
          } catch (error) {
            const msg = error && error.message ? error.message : String(error)
            // eslint-disable-next-line no-console
            console.warn('[transparent] update failed: ' + msg)
            log('FAIL update: ' + msg)
          }
        }

        // Never on the activation path: a slow or dead registry must not hold up
        // the window transparency that this plugin exists to provide.
        run().catch(() => {})
      })
    }
  }

  const report = (res) => {
    /* `reason` is only set by the paths that fail before the child runs. A
       helper that exits non-zero comes back with a code and stderr instead, so
       logging `res.reason` alone printed "FAIL undefined" and threw away the
       only diagnostic there was. */
    const why = res.reason
      || (res.code !== undefined ? 'exit ' + res.code + (res.err ? ' | ' + res.err : '') : 'unknown')
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log('[transparent] window helper: ' + (res.out || 'applied'))
      log('OK   ' + (res.out || 'applied'))
    } else {
      // eslint-disable-next-line no-console
      console.warn('[transparent] window helper failed: ' + why)
      log('FAIL ' + why + (res.out ? ' | out=' + res.out : ''))
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



