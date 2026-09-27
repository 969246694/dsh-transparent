/* ============================================================================
   build.mjs — splice the stylesheet into lib/client.js.

   Source of truth: ../dsh-transparent/dsh-transparent.css (this file's sibling).
   The CSS rule body runs from the first `:root {` to the usage footer.

   RUN
     node build.mjs
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcCss = join(here, 'dsh-transparent.css')
const templatePath = join(here, 'lib', 'client.template.js')
const outPath = join(here, 'lib', 'client.js')

if (!existsSync(srcCss)) {
  console.error(`build: theme source not found: ${srcCss}`)
  process.exit(1)
}

const lines = readFileSync(srcCss, 'utf8').split(/\r?\n/)
const startIdx = lines.findIndex((l) => /^:root \{/.test(l))
let footerIdx = lines.findIndex((l) => /怎么用/.test(l))
if (footerIdx < 0) footerIdx = lines.findIndex((l, i) => i > startIdx && /^\/\* ={10,}\s*$/.test(l))
if (startIdx < 0 || footerIdx < 0 || footerIdx <= startIdx) {
  console.error('build: could not locate the CSS body')
  process.exit(1)
}

let endIdx = footerIdx - 2
while (endIdx > startIdx && lines[endIdx].trim() === '') endIdx--

// Backticks in the CSS comments would break the template literal they land in.
const css = lines.slice(startIdx, endIdx + 1).join('\n').trimEnd().replace(/`/g, "'")

const problems = []

/* The stylesheet must contain NO backdrop-filter.
   Blur is written per detected element by the client half. A broad CSS selector
   for it is exactly what turned the whole UI to mush in an earlier attempt, so
   the sheet is not allowed to carry one at all. */
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
if (/backdrop-filter/.test(withoutComments)) {
  problems.push('the stylesheet declares backdrop-filter; blur is written per element by the client half instead')
}

/* Layout containers must never be blurred, and those selectors are banned. */
for (const bad of ['main', '[class*="panel"]', '[class*="pane"]', '[class*="layout"]']) {
  const esc = bad.replace(/[[\]"*]/g, (m) => '\\' + m)
  if (new RegExp(`(^|,)\\s*${esc}\\s*(,|\\{)`, 'm').test(withoutComments)) {
    problems.push(`bare selector "${bad}" matches nested containers and is banned`)
  }
}

if (css.includes('${')) problems.push('the CSS contains ${, which cannot be embedded in a template literal')
if (/<\/script/i.test(css)) problems.push('the CSS contains </script')

if (problems.length > 0) {
  console.error('build: refusing to emit this theme:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const template = readFileSync(templatePath, 'utf8')
if ((template.split('__CSS__').length - 1) !== 1) {
  console.error('build: template must contain __CSS__ exactly once')
  process.exit(1)
}
const out = template.replace('__CSS__', css)
if (out.includes('__CSS__')) {
  console.error('build: marker survived; aborting')
  process.exit(1)
}

writeFileSync(outPath, out, 'utf8')
console.log(`  CSS body        ${css.length} chars`)
console.log(`  backdrop-filter ${/backdrop-filter/.test(withoutComments) ? 'IN CSS (bad)' : 'absent from CSS (written per element)'}`)
console.log(`  wrote           lib/client.js (${(out.length / 1024).toFixed(1)} KB)`)
