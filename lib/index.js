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

/* =========================================================================
   Config schema.

   Declaring one is what puts these options into the settings UI with real
   controls instead of leaving them to hand-edited YAML.

   It has to be a REAL schemastery schema, and 1.3.0 is the reason this comment
   is emphatic. That release hand-wrote an equivalent-looking schema: a plain
   object carrying the fields the settings service reads (type, dict,
   meta.volatile, toJSON), verified field by field against a genuine
   z.object(...volatile()) schema. Every one of those checks passed -- and the
   plugin still failed to start, because loading uses one more thing that no
   amount of reading the settings service would reveal:

     function resolveConfig(runtime, config) {
       if (!runtime.Config) return config
       const result = runtime.Config['~standard'].validate(config)   // Standard Schema
       ...
     }

   Config is validated through the Standard Schema interface, which schemastery
   provides and a hand-written object does not. Missing it throws during load,
   and the plugin is reported as 启动失败. So: use the real thing.

   The schema comes from a VENDORED copy of schemastery (lib/vendor/), not from
   the application. That is not a preference -- it is the only thing that works.
   A plugin installed under <profile>/node_modules cannot import
   '@deepseek-ai/schemastery' at all, measured inside the running application
   rather than only in plain Node:

     --- activated v1.3.2 (options: 0)

   The application rewrites module resolution for a plugin's ENTRY specifier, so
   bundled plugins load by package name, but that rewrite does not extend to the
   imports inside a profile plugin. Vendoring keeps the plugin dependency-free
   for the same reason the stylesheet and sprites ship inline. Both vendored
   packages are MIT, their licences sit beside them, and NOTICE.md records it.

   The import stays guarded. If the vendored module is ever missing, the plugin
   still runs and simply has no settings form: an outage is never the right
   failure mode for a preference. */
let Config
try {
  const schemastery = await import('./vendor/schemastery.mjs')
  const z = schemastery.default
  Config = z.object({
    alpha: z.number().default(215).volatile(),
    darkTheme: z.boolean().default(true).volatile(),
    updateCheck: z.boolean().default(true).volatile(),
    updateSource: z.string().default('').volatile(),
  })
} catch {
  Config = undefined
}

export { Config }

/* Read a config field.

   This exists because `meta.volatile` is not only a UI marker: a volatile field
   is delivered to apply() as an accessor object with a get(), while an ordinary
   field arrives as the bare value. Reading cfg.alpha directly would therefore
   yield the accessor object, fail every isFinite check, and silently revert
   every option to its default -- a failure with no error attached to it. The
   type check afterwards makes an unexpected shape fall back rather than leak
   through. */
const readValue = (raw) => {
  if (raw && typeof raw.get === 'function') {
    try { return raw.get() } catch { return undefined }
  }
  return raw
}
const readNumber = (raw, dflt) => {
  const v = readValue(raw)
  return Number.isFinite(v) ? v : dflt
}
const readFlag = (raw, dflt) => {
  const v = readValue(raw)
  return typeof v === 'boolean' ? v : dflt
}
const readString = (raw, dflt) => {
  const v = readValue(raw)
  return typeof v === 'string' ? v : dflt
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  // 255 = do not fade the whole window (content stays crisp). Lower values make
  // the wallpaper more visible at the cost of fading images and text too.
  const alpha = readNumber(cfg.alpha, 215)
  // Translucency over a light interface looks washed out, so the theme is
  // pinned to dark by default. Set false to leave the user's choice alone.
  const darkTheme = readFlag(cfg.darkTheme, true)
  // Ask the registry once per activation whether a newer version exists.
  const updateCheck = readFlag(cfg.updateCheck, true)

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

  /* Say which build is running and how many options it declares.

     Twice now the question "is the running plugin the code on disk?" could not
     be answered from the application: the host half is imported once at startup
     and re-enabling the plugin re-runs apply() from the CACHED module, so
     toggling it off and on does not pick up an edit. The option count is part
     of the line because it differs between the build that had no Config schema
     and the one that has it. */
  log('--- activated v' + (readOwnVersion() || '?')
    + ' (options: ' + (Config && Config.dict ? Object.keys(Config.dict).length : 0) + ')')

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

     The plugin manager has no update affordance and no version check — there is
     no `outdated`, `upgrade` or `checkForUpdate` anywhere in it. So nothing in
     the application will ever tell a user that a newer version exists, and
     without this they stay on whatever they happened to install. That gap is the
     entire reason this code exists.

     What it deliberately does NOT do is install anything. An earlier draft
     fetched the update on request and was removed: it rewrote the profile to buy
     nothing, because a new version only starts running after a restart either
     way, and a failure part way through leaves the plugin removed. The user
     already has the two things that work — reinstall through the GUI, or
     install_bundle <name>, which re-runs pnpm and takes the newest version in
     range.

     The registry comes from registries() rather than a hard-coded host, so a
     user on the China mirror is checked against the mirror instead of being sent
     somewhere they may not be able to reach. */
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
        if (!pm || typeof pm.registries !== 'function') {
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

          const base = readString(cfg.updateSource, '').replace(/\/+$/, '') || (registry + '/' + PACKAGE_NAME)
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

          /* Say so, and stop there.

             An earlier draft also fetched the update on request. It was removed:
             it rewrote the profile to gain nothing, since the new version only
             starts running after a restart either way — and a failure part way
             through leaves the plugin removed. Updating is one command the user
             already has (`install_bundle <name>` re-runs pnpm and takes the
             newest version in range) or one remove-and-reinstall in the GUI.

             What nothing else provides is knowing a new version exists at all:
             the plugin manager has no update affordance and no version check, so
             without this line a user simply stays on whatever they installed. */
          // eslint-disable-next-line no-console
          console.log('[transparent] v' + latest + ' is available (running ' + own
            + ') — reinstall the plugin to update')
          log('NEW  ' + own + ' -> ' + latest)
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

export default { name, Config, apply }




