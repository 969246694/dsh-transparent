# dsh-transparent

[中文](README.zh-CN.md) | **English**

Make the DSH desktop window translucent so your wallpaper shows through.

An unofficial plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
desktop client. **Windows only.**

It also contains a genuinely refracting liquid-glass implementation for the
composer. **Be aware before installing: on this app's layout the refraction is
barely visible**, because nothing scrolls behind the composer. What you will
actually see is a translucent window. Read *Known limitations* below — it is
short and it is the honest part.

---

## What it does

| Effect | Status | Where it is implemented |
|---|---|---|
| Window becomes translucent, wallpaper shows through | **Works** | Host half (Node) spawns a PowerShell helper that sets Win32/DWM window attributes |
| The app's opaque background is cleared | **Works** | Browser half (CSS) |
| The composer refracts its backdrop instead of just blurring it | **Implemented; barely visible in practice** | Browser half: an SVG displacement map generated at runtime, referenced from `backdrop-filter: url()` |

### Why the glass is barely visible

Refraction needs **something behind it to bend**. A displacement map moving a
flat colour does nothing at all — every pixel is identical, so moving them
changes nothing.

Two things then have to be true for the effect to show, and only the first is:

1. **The page must not be opaque.** ✅ The wallpaper does reach the screen, via
   the translucent window.
2. **Content must pass behind the composer.** ❌ The composer occupies its own row
   at the bottom of the window and the message list ends above it. Nothing ever
   scrolls behind it, so the lens has nothing to bend.

The refraction itself is real and verified — the composer's `backdrop-filter`
resolves to `url(#dsh-transparent-liquid)`, and rendering the same filter over
scrolling text produces obvious distortion. It is the app's layout that keeps
that text out of the lens.

Making it visible means changing the application's layout so the message list
runs behind the composer. That was attempted three times and reverted three
times; see *Known limitations*.

## Install

**From npm** — recommended, and the only option that works without reaching
GitHub. In the *Add plugin* dialog set the install source to **中国⼤陆镜像源**
(`registry.npmmirror.com`) and enter the package name:

```
dsh-transparent
```

**From GitHub** — needs working access to github.com:

```
plugin_manager install_bundle  https://github.com/969246694/dsh-transparent
```

Pin the release instead of tracking `main`:

```
plugin_manager install_bundle  https://github.com/969246694/dsh-transparent#v1.0.0
```

**From a local path** — for a checkout or an unpacked tarball:

```
plugin_manager install_bundle  <path-to-this-repo>
```

Then restart the client. Window transparency is applied automatically at
startup — there is no script to run by hand.

> **Why the mirror only helps the npm route:** a GitHub URL is classified as a
> *git* spec and fetched by `git`, bypassing npm entirely. The install-source
> setting therefore has no effect on it. That is why this package is published
> to npm at all.

## Configuration

`cordis.patch.yml`:

```yaml
config:
  alpha: 215      # whole-window opacity
```

| alpha | Effect |
|---|---|
| `255` | Window stays fully opaque. Wallpaper not visible; content at full crispness |
| `215` | **Default.** Wallpaper visible, content slightly faded |
| `150` | Wallpaper obvious, content clearly faded |

Design tokens live in `dsh-transparent.css`:

| Token | Meaning | Default |
|---|---|---|
| `--tp-blur` | Blur applied before refraction | `2px` |
| `--tp-saturate` | Saturation of the refracted backdrop | `130%` |
| `--tp-lift` | Brightness lift | `1.12` |
| `--tp-lens` | Refraction strength, in px of displacement | `55` |
| `--tp-glass-fill` | Glass tint | `rgb(19 19 19 / 0.30)` |
| `--tp-rim` | Rim highlight strength | `0.10` |

Edit `dsh-transparent.css`, run `node build.mjs`, and the browser half
hot-reloads.

---

## How the liquid glass works

Blur is not liquid glass. **Refraction** is. A real lens bends the backdrop along
the shape's normal: vertically at the top and bottom edges, horizontally at the
sides, diagonally at the corners — and leaves the flat middle alone.

That description is a **normal map**, and `feDisplacementMap` is what consumes
one: red is the x offset, green is the y offset, and 128 means "no offset".
Because the map is built centred on 128, the middle of the pane leaves the
backdrop untouched while the rim bends it. That is the mechanism, not a
convention to remember.

The map is generated at runtime with canvas, at the composer's **own aspect
ratio**:

1. draw the rounded rectangle, white on black
2. blur it — this bevel stands in for glass thickness
3. Sobel the bevel — gives the surface normal at every pixel
4. write `(128 + dx, 128 + dy)` into red and green

Aspect ratio matters more than it looks. The map is stretched onto the element
with `preserveAspectRatio="none"`, and the composer is a very wide, very short
bar — around 10:1. Building a 3:1 map and letting it stretch compresses the
vertical bevel several times over, and the top and bottom edges are exactly the
edges that produce refraction on a bar like this. **Get the aspect wrong and the
glass goes flat, with no error anywhere.**

`color-interpolation-filters` must be `sRGB`. The `linearRGB` default flattens
the displacement and the result collapses back into a plain blur.

---

## Architecture

Styles are applied with **CSS selectors that match by structure**, not by
JavaScript marking elements.

That choice is the whole design, and it came out of a failure. Marking elements
with `data-*` attributes and generating CSS for them cannot avoid flicker:

```
the app replaces its own elements when it re-renders
  -> the replacement carries no marker
  -> the rule stops applying
  -> the plugin notices, and re-applies
```

As long as re-application exists, there is a window in which the element is
painted unstyled. The only way to close it is to delete the re-application.

So the browser half does exactly two things, both once:

1. **Resolves how deeply the composer's card sits above the editable element**,
   then appends one rule with a `:has()` selector for that depth. Depth is a
   property of the app's component tree, not of any re-render, so resolving it
   once is enough. Every step of the chain is a direct-child step, so exactly one
   element matches — no nesting, no compounding.
2. **Builds the lens map**, which CSS genuinely cannot express.

There is no `MutationObserver`, no scheduler, no rate limiter, no re-marking.
If the composer is replaced a thousand times, the browser matches it a thousand
times **and none of our code runs**.

### Repository layout

```
dsh-transparent.css      design tokens + structural rules (source of truth)
build.mjs                splices the CSS into lib/client.js; guards it
verify.mjs               30+ checks against stubs; no browser needed
lib/index.js             host half  — Node, spawns the window helper
lib/client.template.js   browser half — classic script, __CSS__ placeholder
lib/client.js            GENERATED by build.mjs — do not edit
assets/window-glass.ps1  Win32/DWM helper, run by the host half
```

### Three traps worth knowing

**1. `.ps1` files must be pure ASCII.**
`powershell.exe` reads a script as ANSI unless it has a UTF-8 BOM. A UTF-8 file
without one turns non-ASCII comments into mojibake, and a stray byte inside a
string can break parsing outright — which is exactly what happened here once,
with Chinese comments. `assets/window-glass.ps1` contains no non-ASCII
characters and should stay that way.

**2. A client half runs under traps.**
`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `fetch` and
`require` are shadowed by *throwing* traps inside a dynamically evaluated client
half. All timing must run on `requestAnimationFrame`. `verify.mjs` fails if any
of them is called.

**3. Disabling a feature means removing its stylesheet, not just not writing it.**
An injected `<style>` element does not disappear when the bundle stops writing
it. Reverting a rule in code while the old element is still in the page leaves
the old rule applying. The plugin explicitly removes stale stylesheets on
activation for this reason.

---

## Known limitations

- **Windows only** for window transparency. On other platforms the browser half
  still works; only the translucency is skipped.
- **The wallpaper cannot be refracted.** `backdrop-filter` only ever sees content
  *inside the page*. The desktop is composited by the OS, outside the browser, so
  the glass refracts the app's own content — text, code blocks, cards — but never
  the wallpaper itself. Not a tuning problem; it is where the API ends.
- **Chat text does not pass behind the composer.** The composer occupies its own
  row at the bottom of the window and the message list ends above it, so nothing
  scrolls behind the glass. Making it do so requires changing the application's
  layout — attempted three times, reverted three times. See below.
- If the app changes its DOM depth, the `:has()` selector stops matching and the
  glass simply disappears. This is a quiet degradation, not a flicker.

## Troubleshooting

The browser half logs one line at startup:

```
[transparent] selector div:has(> * > * > :is(...)) | card 952x98 ratio 9.7:1 | depth 3
```

If the glass is missing, check that line first. `depth 0` means the composer
could not be found.

From the console:

```js
window.__tp.layout()   // dump the layout chain around the composer
window.__tp.depth()    // composer depth, 0 if not found
window.__tp.retry()    // re-resolve and reinstall
```

Host-half activity is appended to `%TEMP%\dsh-transparent.log`.

## Development

```bash
node build.mjs     # splice CSS into the client bundle (guarded)
node verify.mjs    # contract, packaging, trap and YAML checks
```

`build.mjs` refuses to emit a theme that declares `backdrop-filter` in CSS, or
that uses bare container selectors. Both rules exist because breaking them caused
real, visible damage during development.

## An honest note on what was tried and reverted

Making chat text scroll behind the glass was attempted three times and reverted
three times. Every attempt damaged the layout; the worst left the sidebar one
character wide.

The cause was the same each time: **modifying another application's layout
without being able to see it.** A helper that picked "the tallest scrollable
element outside the composer" picked a layout wrapper rather than the message
list — and verifying that a class suffix is unique says nothing about whether the
element is the right one.

It is recorded here because a reader deserves to know which parts of this plugin
are load-bearing and which stopped being attempted, rather than discovering it
from the issue tracker.

## Licence

MIT — see [LICENSE](LICENSE).
Unofficial, and unaffiliated with DeepSeek — see [NOTICE](NOTICE.md).
