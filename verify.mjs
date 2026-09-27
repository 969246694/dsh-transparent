/* ============================================================================
   verify.mjs — pre-flight checks for dsh-transparent.

   The theme is CSS-only, so "it works" reduces to four questions:
     1. is the host half a valid ES module (the loader imports it)?
     2. is the browser half a valid classic script that registers itself?
     3. does apply() actually inject the stylesheet?
     4. does the bundle patch point at the host half?

   RUN
     node verify.mjs
   EXIT CODE 0 = ready to install.
   ========================================================================== */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

let failures = 0
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? '  — ' + d : ''}`)
const bad = (l, d = '') => { failures++; console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`) }
const head = (t) => console.log(`\n=== ${t} ===`)

/* ------------------------------------------------------- 1. the host half -- */

head('1. host half must be an importable ES module')

const hostPath = resolve(here, pkg.main ?? 'lib/index.js')
if (!existsSync(hostPath)) {
  bad('host half exists', pkg.main)
} else {
  const src = readFileSync(hostPath, 'utf8')
  if (/^\s*(import|export)\s/m.test(src)) ok('uses ES module syntax')
  else bad('uses ES module syntax')
  try {
    const mod = await import(pathToFileURL(hostPath).href + '?probe=1')
    ok('host module imports cleanly')
    if (typeof mod.apply === 'function') ok('exports apply()')
    else bad('exports apply()')
  } catch (error) {
    bad('host module imports cleanly', `${error.constructor.name}: ${error.message}`)
  }
}

/* ---------------------------------------------------- 2. the browser half -- */

head('2. browser half must register itself and inject the theme')

const clientRel = pkg.exports?.['./client']?.default
const clientPath = clientRel ? resolve(here, clientRel) : null

if (!clientPath || !existsSync(clientPath)) {
  bad('exports["./client"] resolves', String(clientRel))
} else {
  const src = readFileSync(clientPath, 'utf8')

  if (/^\s*(import|export)\s/m.test(src)) bad('no import/export statements', 'classic script, not a module')
  else ok('no import/export statements')

  /* REGRESSION GUARD. Inside a dynamically evaluated client half, setTimeout /
     setInterval / clearTimeout / clearInterval / fetch / require are shadowed by
     THROWING TRAPS. Reaching one aborts the pass with
     "<name> is not available in a dynamic client half". This nearly shipped
     again when a debounce was written with setTimeout; all timing must stay on
     requestAnimationFrame. Comments are stripped first so prose may mention
     these names. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const trapped = code.match(/(?<![.\w])(?:setTimeout|setInterval|clearTimeout|clearInterval|fetch)\s*\(/g)
  if (trapped) bad('no trapped globals are called', `found ${[...new Set(trapped)].join(', ')}`)
  else ok('no trapped globals are called')

  if (/window\.__ModuleLoader__\.load\(\s*\{/.test(src)) ok('calls window.__ModuleLoader__.load({…})')
  else bad('calls window.__ModuleLoader__.load({…})')

  const idMatch = src.match(/\bid:\s*['"]([^'"]+)['"]/)
  if (idMatch && idMatch[1] === `${pkg.name}/client`) ok('registers under the right id', idMatch[1])
  else bad('registers under the right id', `expected ${pkg.name}/client, got ${idMatch ? idMatch[1] : '(none)'}`)

  if (/factory:\s*\(require\)\s*=>/.test(src)) ok('factory takes `require`')
  else bad('factory takes `require`')

  if (/return\s+module\.exports/.test(src)) ok('factory returns module.exports')
  else bad('factory returns module.exports')

  if (/<\/script/i.test(src)) bad('no literal </script>')
  else ok('no literal </script>')

  const cssMatch = src.match(/const CSS = `([\s\S]*?)`\n/)
  if (cssMatch && cssMatch[1].length > 1000) ok('embeds a stylesheet', `${cssMatch[1].length} chars`)
  else bad('embeds a stylesheet', cssMatch ? `${cssMatch[1].length} chars` : 'CSS template literal not found')

  /* ---- execute it against a minimal shell ---- */
  const created = []
  const El = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null,
      style: {}, dataset: {}, className: '', textContent: '', id: '',
      setAttribute() {}, getAttribute() { return null },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c },
      /* insertBefore is standard DOM and the plugin uses it to place the
         structure layer behind everything. Its absence here once made a
         perfectly good run report "insertBefore is not a function" — a harness
         gap masquerading as a plugin failure. */
      insertBefore(c, ref) {
        c.parentNode = this
        const i = ref ? this.children.indexOf(ref) : -1
        if (i < 0) this.children.push(c)
        else this.children.splice(i, 0, c)
        return c
      },
      get firstChild() { return this.children.length ? this.children[0] : null },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null }, querySelectorAll() { return [] },
    }
    created.push(el)
    return el
  }
  const headEl = El('head'), bodyEl = El('body')
  const doc = {
    body: bodyEl, head: headEl,
    documentElement: El('html'),
    createElement: (t) => El(t),
    getElementById: (id) => created.find((e) => e.id === id) || null,
    querySelector: () => null, querySelectorAll: () => [],
  }
  const win = {
    innerWidth: 1400, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    // The theme self-checks with getComputedStyle; provide a stub so the probe
    // runs here too instead of throwing "getComputedStyle is not defined".
    getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)' }),
    requestAnimationFrame: (fn) => { try { fn() } catch (e) { /* ignore */ } return 1 },
    __ModuleLoader__: { load(def) { win.__loaded = def } },
  }
  win.window = win

  const inserted = []
  const styles = { insert(css) { inserted.push(css); return () => {} } }

  const savedWindow = globalThis.window
  const savedDocument = globalThis.document
  globalThis.window = win
  globalThis.document = doc

  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', src)(win, doc)
    if (!win.__loaded) throw new Error('load() was never called')
    ok('registers without throwing', `id=${win.__loaded.id}`)

    const exportsObj = win.__loaded.factory(() => ({}))
    const plugin = exportsObj?.default
    if (plugin && typeof plugin.apply === 'function') ok('exports a mountable plugin', `name=${plugin.name}`)
    else bad('exports a mountable plugin')

    if (plugin && typeof plugin.apply === 'function') {
      plugin.apply({ effect: (fn) => { globalThis.__teardown = fn; return () => {} } })
      ok('apply() ran without throwing')

      if (inserted.length > 0 && inserted[0].length > 1000) {
        ok('stylesheet injected through the styles builtin', `${inserted[0].length} chars`)
      } else {
        const tag = created.find((e) => e.id === `${pkg.name}-css`)
        if (tag && tag.textContent) ok('stylesheet injected through a <style> tag', `${tag.textContent.length} chars`)
        else bad('stylesheet injected')
      }

      if (typeof globalThis.__teardown === 'function') {
        const d = globalThis.__teardown()
        if (typeof d === 'function') d()
        ok('ctx.effect teardown registered')
      } else bad('ctx.effect teardown registered')
    }
  } catch (error) {
    bad('browser half executes', `${error.constructor.name}: ${error.message}`)
  }

  globalThis.window = savedWindow
  globalThis.document = savedDocument
}

/* --------------------------------------------------------- 3. packaging -- */

head('3. packaging consistency')

const patchRel = pkg.dsh?.bundle?.patch
const patchPath = patchRel ? resolve(here, patchRel) : null
if (patchPath && existsSync(patchPath)) {
  ok('dsh.bundle.patch exists', patchRel)
  const entry = (readFileSync(patchPath, 'utf8').match(/^\s*name:\s*["']?([^"'\s]+)["']?\s*$/m) || [])[1]
  if (entry === pkg.name) ok('patch entry points at the host half', entry)
  else bad('patch entry points at the host half', `patch says '${entry}', expected '${pkg.name}' (never '<pkg>/client')`)
} else bad('dsh.bundle.patch exists')

if (!pkg.dsh?.client?.inject && !pkg.dsh?.client?.shared) ok('no inject/shared declarations')
else bad('inject/shared declared', 'a local-path install cannot satisfy them')

/* The overlay parser is strict YAML. Two things broke it once already:
   a `//` first line (not a comment in YAML) and full-width punctuation inside
   the comments. Both are static, so check them here rather than discovering
   them as an install failure. */
if (patchPath && existsSync(patchPath)) {
  const raw = readFileSync(patchPath, 'utf8')
  const nonAscii = [...raw].filter((ch) => ch.charCodeAt(0) > 126)
  if (nonAscii.length === 0) ok('patch is pure ASCII')
  else bad('patch is pure ASCII', `found ${nonAscii.length}: ${[...new Set(nonAscii)].join(' ')}`)

  const firstCode = raw.split(/\r?\n/).find((l) => l.trim() && !l.trimStart().startsWith('#'))
  if (firstCode && firstCode.trimStart().startsWith('- ')) ok('patch starts a YAML sequence', firstCode.trim())
  else bad('patch starts a YAML sequence', `first code line is ${JSON.stringify(firstCode)}`)

  if (/^\s*\/\//m.test(raw)) bad('no // comment lines', '// is not a YAML comment')
  else ok('no // comment lines')
}

if (pkg.dsh?.client?.platform) ok('dsh.client.platform declared', pkg.dsh.client.platform)
else bad('dsh.client.platform declared')

const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.peerDependencies ?? {}).length
if (deps === 0) ok('no dependencies at all')
else bad(`${deps} dependency declaration(s)`)

/* ------------------------------------------------- 4. committed build sync -- */

head('4. the committed bundle matches the template')

/* lib/client.js is generated, but it is committed so the plugin works straight
   after install_bundle without a build step. That only holds if the two stay in
   sync — edit the template, forget to build, and users install the old code.
   Rebuilding here and comparing catches exactly that. */
{
  /* Compare with line endings normalised.

     Git may check files out with CRLF depending on platform and config, while
     build.mjs always emits LF. A raw string comparison would then report a stale
     bundle on a perfectly up-to-date clone — a false failure that is worse than
     no check at all, because it teaches people to ignore the check. */
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const committed = norm(readFileSync(clientPath, 'utf8'))
  const template = norm(readFileSync(resolve(here, 'lib', 'client.template.js'), 'utf8'))
  if (template.includes('__CSS__')) ok('template still carries the __CSS__ placeholder')
  else bad('template still carries the __CSS__ placeholder')

  const cssRaw = norm(readFileSync(resolve(here, 'dsh-transparent.css'), 'utf8'))
  const lines = cssRaw.split(/\r?\n/)
  const start = lines.findIndex((l) => /^:root \{/.test(l))
  let foot = lines.findIndex((l) => /怎么调|Usage|How to tune/.test(l))
  if (foot < 0) foot = lines.findIndex((l, i) => i > start && /^\/\* ={10,}\s*$/.test(l))
  let end = foot - 2
  while (end > start && lines[end].trim() === '') end--
  const css = start >= 0 && end > start
    ? lines.slice(start, end + 1).join('\n').trimEnd().replace(/`/g, "'")
    : ''

  const expected = template.replace('__CSS__', css)
  if (committed === expected) ok('committed lib/client.js is up to date')
  else bad('committed lib/client.js is up to date', 'run `node build.mjs` — the bundle is stale')
}

/* ------------------------------------------------------------- done ----- */

head(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

