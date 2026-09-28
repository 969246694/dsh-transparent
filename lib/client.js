/* ============================================================================
   dsh-transparent — browser half.

   A CLASSIC browser script registered with the web shell's module loader.
   Not an ES module: no import, no export.

   ==========================================================================
   ARCHITECTURE — this file carries almost no logic on purpose.
   ==========================================================================

   An earlier version marked elements with data-* attributes and generated CSS
   for them. That design cannot avoid flicker, and it is worth stating exactly
   why, because every symptom that followed came from it:

       the app replaces its own elements when it re-renders
       -> the replacement carries no marker
       -> the rule stops applying
       -> the plugin notices, and re-applies

   As long as "re-apply" exists, there is a window in which the element is
   painted unstyled. The only way to close it is to remove the re-application
   entirely, so:

       EVERYTHING STYLE-RELATED IS A CSS SELECTOR THAT MATCHES BY STRUCTURE.

   The browser re-evaluates those selectors itself on every render. A replaced
   element is matched automatically, with no code of ours involved, so there is
   no window and nothing to flicker.

   What JavaScript still does — twice, and never again:

     1. Detect how deeply the composer's card sits above the editable element,
        and append ONE rule with a :has() selector for that depth. The depth is a
        property of the app's component tree, not of any re-render, so it is
        resolved once and stays correct.

     2. Build the refraction lens map and the SVG filter that references it.
        This is the one thing CSS genuinely cannot express.

   There is no MutationObserver, no scheduler, no rate limiter and no
   re-marking. If the composer is replaced a thousand times, the browser matches
   it a thousand times, and no code of ours runs at all.
   ========================================================================== */
window.__ModuleLoader__.load({
  id: 'dsh-transparent/client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const CSS = `
:root {
  /* ---- 液态玻璃 ---- */

  /* 模糊。折射负责"形变"，模糊只负责柔化 */
  --tp-blur: 2px;
  /* 饱和度。液态玻璃的手感来自高饱和 */
  --tp-saturate: 130%;
  /* 明度提升，让折射后的背景"亮"起来 */
  --tp-lift: 1.12;
  /* 折射强度：贴图满强度时边缘像素被推移多少 px */
  --tp-lens: 55;

  /* 斜向高光（掠过玻璃面的那道亮）。
     刻意压得很低 —— 高光过强会像廉价拟物，不是液态玻璃 */
  --tp-sheen-a: 0.05;
  --tp-sheen-b: 0.012;
  /* 边缘高光强度 */
  --tp-rim: 0.10;

  /* 玻璃底色。中性灰，不带色相 */
  --tp-glass-fill: rgb(19 19 19 / 0.30);
  --tp-glass-edge: rgb(255 255 255 / 0.07);
  --tp-glass-shadow: rgb(0 0 0 / 0.45);

  /* ---- 重叠量：暂停，等布局测清楚再启用 ----

     两次尝试都失败了，原因是同一个：我在【假设】输入框之上的布局。

     第一次把负外边距加在内层 composerStack：内层被外层裁掉，列表没变高。
     第二次加到外层 composerSeat：仍然溢出且被裁，列表还是没变高。

     这说明 composerSeat 的父容器【不是】我假设的那种
     "flex 列 + 列表 flex:1"。可能列表不与之同级，也可能祖先有 overflow:hidden
     把溢出的部分裁掉了。

     正确顺序是：先测出真实的 display / flex / overflow 结构，再写规则。
     报告里会打印这条链。 */
  --tp-overlap: 100px;
}

/* [class*="composerSeat"] { margin-top: calc(-1 * var(--tp-overlap)); } */

/* ---------------------------------------------------------------------------
   背景清透

   应用的深色底由一个铺满视口的元素绘制。从实测的 DOM 结构看它在
   body > div > div 这一层 —— 用结构选择器直接表达，不需要打标记。

   限定在两层以内：更深的元素是内容卡片，不能动。
   --------------------------------------------------------------------------- */

html,
body {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
}

/* 背景清透 —— 只清"应用外壳"这条链

   ★ 这里踩过一次坑，记下来：
     最初写的是无差别的

         body > div,
         body > div > div { background-color: transparent !important }

     结果把【悬停预览窗】也打透了 —— 应用把弹窗 portal 到 body 下，
     结构正好是 body > div > div，深度完全一样。背景一透，后面的聊天文字
     就透过来了，很乱。

     现在用 :has() 限定成【含输入框的那条祖先链】，弹窗不在链上，不受影响。

     代价：如果输入框不在应用外壳内（理论上不会），壁纸就不透。 */
body > div:has([class*="composerStack"]),
body > div > div:has([class*="composerStack"]) {
  background-color: transparent !important;
}
`

    /* Stamped into every log line.

       Without this there is no way to tell which revision the browser is
       actually running. Console scrollback mixes lines from several builds, and
       debugging the wrong version wastes everyone's time — which happened. */
    const BUILD = '1.4.5'

    const STYLE_ID = 'dsh-transparent-css'
    const GLASS_STYLE_ID = 'dsh-transparent-glass'
    const FILTER_ID = 'dsh-transparent-liquid'
    const FILTER_HOST_ID = 'dsh-transparent-svg'
    const LIST_STYLE_ID = 'dsh-transparent-list'

    /* Set false to drop the glass and keep only the wallpaper. */
    const ENABLE_COMPOSER_GLASS = true

    /* Depth search bounds when locating the composer card. */
    const MIN_HOPS = 1
    const MAX_HOPS = 6
    const MIN_CARD_HEIGHT = 40
    const MAX_CARD_HEIGHT_RATIO = 0.6
    const MIN_CARD_WIDTH = 240

    /* ---------------------------------------------------------------------
       The lens map.

       Apple-style liquid glass is a lens, not a blur: the backdrop bends along
       the shape's normal — vertically at the top and bottom edges, horizontally
       at the sides, diagonally at the corners — and stays untouched across the
       flat middle.

       That description is a normal map, and feDisplacementMap is what consumes
       it: red is the x offset, green is the y offset, and 128 means "no offset".
       Building the map centred on 128 is therefore not a convention to remember
       but the mechanism that leaves the middle of the pane alone while the rim
       bends.

       The map is built ONCE at a fixed size. It does not track the element's
       real dimensions, because the filter stretches it with
       preserveAspectRatio="none" — and tracking dimensions would mean reading
       layout in a loop, which is exactly the kind of recurring work this rewrite
       exists to delete. A soft bevel does not need pixel-exact geometry.
       --------------------------------------------------------------------- */
    const buildLensMap = (w, h, radius) => {
      const W = Math.max(24, Math.round(w))
      const H = Math.max(24, Math.round(h))
      const rr = Math.max(2, Math.min(Math.round(radius), Math.floor(Math.min(W, H) / 2)))

      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c }

      // 1. the shape
      const shape = mk()
      const g1 = shape.getContext('2d')
      g1.fillStyle = '#000'
      g1.fillRect(0, 0, W, H)
      g1.fillStyle = '#fff'
      g1.beginPath()
      g1.moveTo(rr, 0)
      g1.lineTo(W - rr, 0)
      g1.quadraticCurveTo(W, 0, W, rr)
      g1.lineTo(W, H - rr)
      g1.quadraticCurveTo(W, H, W - rr, H)
      g1.lineTo(rr, H)
      g1.quadraticCurveTo(0, H, 0, H - rr)
      g1.lineTo(0, rr)
      g1.quadraticCurveTo(0, 0, rr, 0)
      g1.closePath()
      g1.fill()

      // 2. blur -> the bevel that stands in for glass thickness
      const bevel = mk()
      const g2 = bevel.getContext('2d')
      g2.filter = 'blur(' + Math.max(2, Math.round(Math.min(W, H) * 0.16)) + 'px)'
      g2.drawImage(shape, 0, 0)

      // 3. Sobel over the bevel -> the surface normal at every pixel
      const src = g2.getImageData(0, 0, W, H).data
      const lum = new Float32Array(W * H)
      for (let i = 0; i < W * H; i++) lum[i] = src[i * 4] / 255
      const at = (x, y) => lum[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]

      const out = mk()
      const g3 = out.getContext('2d')
      const img = g3.createImageData(W, H)
      const gain = 255 * 2.2

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                   - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
          const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                   - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
          const i = (y * W + x) * 4
          const R = 128 + dx * gain
          const G = 128 + dy * gain
          img.data[i] = R < 0 ? 0 : (R > 255 ? 255 : R)
          img.data[i + 1] = G < 0 ? 0 : (G > 255 ? 255 : G)
          img.data[i + 2] = 128
          img.data[i + 3] = 255
        }
      }
      g3.putImageData(img, 0, 0)
      return out.toDataURL('image/png')
    }

    /* Build the SVG filter that turns the map into refraction.

       color-interpolation-filters MUST be sRGB: the linearRGB default flattens
       the displacement and the result collapses into a plain blur.

       The filter region is oversized because rim displacement samples pixels
       outside the element box, and a tight region would clamp them into a visible
       seam around the edge. */
    const installFilter = (lensUrl) => {
      if (document.getElementById(FILTER_HOST_ID)) return

      /* scale must be a NUMBER. An SVG presentation attribute does not resolve
         CSS custom properties, so var(--tp-lens) here would be ignored and the
         displacement would silently fall back to 0 — glass with no refraction.
         The token is read from the stylesheet instead, so it stays tunable. */
      let scale = 55
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--tp-lens').trim()
        const n = parseFloat(raw)
        if (isFinite(n) && n > 0) scale = n
      } catch (e) { /* keep the default */ }

      const NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('id', FILTER_HOST_ID)
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('style', 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none')

      const filter = document.createElementNS(NS, 'filter')
      filter.setAttribute('id', FILTER_ID)
      filter.setAttribute('x', '-30%')
      filter.setAttribute('y', '-30%')
      filter.setAttribute('width', '160%')
      filter.setAttribute('height', '160%')
      filter.setAttribute('color-interpolation-filters', 'sRGB')

      const lens = document.createElementNS(NS, 'feImage')
      lens.setAttribute('href', lensUrl)
      lens.setAttribute('x', '0')
      lens.setAttribute('y', '0')
      lens.setAttribute('width', '100%')
      lens.setAttribute('height', '100%')
      lens.setAttribute('preserveAspectRatio', 'none')
      lens.setAttribute('result', 'lens')

      const disp = document.createElementNS(NS, 'feDisplacementMap')
      disp.setAttribute('in', 'SourceGraphic')
      disp.setAttribute('in2', 'lens')
      disp.setAttribute('scale', String(scale))
      disp.setAttribute('xChannelSelector', 'R')
      disp.setAttribute('yChannelSelector', 'G')

      filter.appendChild(lens)
      filter.appendChild(disp)
      svg.appendChild(filter)
      document.body.appendChild(svg)
    }

    /* The editable element, or null. Prefers the largest, which is the composer
       rather than a sidebar rename field. */
    const findAnchor = () => {
      const nodes = document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), textarea')
      const vh = window.innerHeight || 900
      let best = null
      let bestArea = 0
      for (const n of nodes) {
        if (n.closest && n.closest('.wisp-layer')) continue
        let r
        try { r = n.getBoundingClientRect() } catch (e) { continue }
        if (r.width < MIN_CARD_WIDTH || r.height < 12) continue
        if (r.height > vh * MAX_CARD_HEIGHT_RATIO) continue
        const area = r.width * r.height
        if (area > bestArea) { bestArea = area; best = n }
      }
      return best
    }

    /* Layout report.

       Written into the plugin rather than handed to the user as a snippet to
       paste into DevTools: pasting into that console triggers Chrome's self-XSS
       guard and demands an "allow pasting" confirmation, which is friction for
       no benefit when the plugin already holds the anchor element.

       It answers the one question that decides whether refraction can ever show
       chat text: does anything actually pass BEHIND the composer? The message
       list is the nearest scrollable ancestor, and if its bottom edge sits above
       the composer's top edge, the two never overlap and no amount of refraction
       will be visible.

       Read only: rects and computed styles, nothing is modified. */
    const describeLayout = (anchor, card) => {
      const lines = []
      lines.push('window ' + window.innerWidth + 'x' + window.innerHeight)
      let el = anchor
      for (let i = 0; el && el !== document.documentElement && i < 8; i++) {
        let r = { width: 0, height: 0, top: 0, bottom: 0 }
        let cs = null
        try { r = el.getBoundingClientRect(); cs = getComputedStyle(el) } catch (e) { /* ignore */ }
        const cls = String(el.className || '').split(/\s+/)[0] || '(none)'
        const scrollable = cs && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
        lines.push('  ' + i + ' ' + el.tagName + '.' + cls
          + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
          + ' top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom)
          + ' ' + (cs ? cs.position : '?')
          + ' ovf=' + (cs ? cs.overflowY : '?')
          + ' bg=' + (cs ? cs.backgroundColor : '?')
          + (scrollable ? ' <== SCROLL CONTAINER' : '')
          + (el === card ? ' <== CARD' : ''))
        el = el.parentElement
      }
      if (card) {
        const cr = card.getBoundingClientRect()
        lines.push('  card top=' + Math.round(cr.top) + ' bottom=' + Math.round(cr.bottom))

        /* Scan the WHOLE document for scroll containers rather than walking up
           from the anchor. Walking up was wrong: the composer's own text box is
           itself a scroll container (948x36, overflow auto), so the nearest one
           found from the anchor is the input's internal scroller, never the
           message list. The message list is a SIBLING of the composer, so it can
           only be found by searching sideways or globally.

           Only containers big enough to be a list are reported. */
        const found = []
        let all = []
        try { all = document.querySelectorAll('*') } catch (e) { all = [] }
        for (const el of all) {
          let cs, r
          try { cs = getComputedStyle(el); r = el.getBoundingClientRect() } catch (e) { continue }
          if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
          if (r.height < 200 || r.width < 200) continue
          if (card.el && card.el.contains(el)) continue
          const cls = String(el.className || '').split(/\s+/)[0] || '(none)'
          found.push('  SCROLL ' + el.tagName + '.' + cls
            + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
            + ' top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom)
            + ' padBottom=' + cs.paddingBottom
            + ' scrollHeight=' + el.scrollHeight
            + ' clientHeight=' + el.clientHeight)
        }
        lines.push('  scroll containers (h>200, outside the composer): ' + (found.length || 'NONE'))
        for (const f of found.slice(0, 6)) lines.push(f)

        /* The full chain from the card up to the root, with the properties that
           decide whether a negative margin can work at all.

           Two attempts at the overlap failed on the same wrong assumption: that
           the composer sits in a flex column whose sibling list is flex:1, so
           pulling the composer up would hand the freed space to the list. Both
           times the result was overflow plus clipping instead — so the parent is
           not that, or an ancestor hides its overflow.

           display / flex / overflow on each level answers it outright, instead
           of me guessing at the container model a third time. */
        if (card.el) {
          lines.push('  --- chain from the card upward ---')
          let up = card.el
          for (let i = 0; up && up !== document.documentElement && i < 14; i++) {
            let ur = { width: 0, height: 0, top: 0, bottom: 0 }
            let ucs = null
            try { ur = up.getBoundingClientRect(); ucs = getComputedStyle(up) } catch (e) { /* ignore */ }
            const ucl = String(up.className || '').split(/\s+/)[0] || '(none)'
            lines.push('    up' + i + ' ' + up.tagName + '.' + ucl
              + ' ' + Math.round(ur.width) + 'x' + Math.round(ur.height)
              + ' top=' + Math.round(ur.top) + ' bottom=' + Math.round(ur.bottom)
              + ' display=' + (ucs ? ucs.display : '?')
              + ' overflow=' + (ucs ? (ucs.overflowX + '/' + ucs.overflowY) : '?')
              + ' flex=' + (ucs ? (ucs.flexGrow + '/' + ucs.flexShrink + '/' + ucs.flexBasis) : '?')
              + ' pos=' + (ucs ? ucs.position : '?'))
            up = up.parentElement
          }
        }
      }
      return lines
    }

    /* Walk up from the anchor to the card: the nearest ancestor that actually
       paints a background and is shaped like a bar rather than a page.

       Returns the ELEMENT as well as the hop count. The element is needed to
       build the lens map at the right aspect ratio:

         the map is stretched onto the element with preserveAspectRatio="none",
         so a map whose aspect does not match gets squashed. A composer is a very
         wide, very short bar — around 12:1. Building a 3:1 map and letting it
         stretch compresses the vertical bevel by roughly 4x, and the top and
         bottom edges are precisely the edges that produce the refraction on a
         bar like this. The result is a pane that looks flat.

       That was the regression in the rewrite: the map had been generated from
       the element's real box, and replacing that with a fixed size quietly
       removed the effect without any error anywhere. */
    const findCard = (anchor) => {
      const vh = window.innerHeight || 900
      const vw = window.innerWidth || 1400
      let el = anchor
      for (let hops = MIN_HOPS; hops <= MAX_HOPS; hops++) {
        el = el.parentElement
        if (!el || el === document.body) return null
        let r, bg
        try {
          r = el.getBoundingClientRect()
          bg = getComputedStyle(el).backgroundColor
        } catch (e) { return null }
        if (r.height < MIN_CARD_HEIGHT) continue
        if (r.height > vh * MAX_CARD_HEIGHT_RATIO) continue
        if (r.width >= vw * 0.999 && r.height >= vh * 0.9) continue
        if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
          return { el, depth: hops, box: r }
        }
      }
      return null
    }

    /* ---------------------------------------------------------------------
       The one rule JavaScript writes.

       `div:has(> * > * > :is([contenteditable], textarea))` matches the ancestor
       at exactly that depth — one element, no nesting, because every level of
       the chain is a direct-child step. Once written the browser owns it: no
       code of ours runs when the composer is re-rendered, so the glass can never
       lag a frame behind.

       If the app's DOM depth ever changes the selector simply stops matching and
       the glass disappears quietly — a degradation, not a flicker. The console
       line reports the depth that was found so that is diagnosable.
       --------------------------------------------------------------------- */
    const installGlassRule = (depth) => {
      const ED = ':is([contenteditable]:not([contenteditable="false"]), textarea)'
      let inner = ED
      for (let i = 1; i < depth; i++) inner = '* > ' + inner
      const selector = 'div:has(> ' + inner + ')'

      let tag = document.getElementById(GLASS_STYLE_ID)
      if (!tag) {
        tag = document.createElement('style')
        tag.id = GLASS_STYLE_ID
        document.head.appendChild(tag)
      }
      tag.textContent = selector + '{'
        + '-webkit-backdrop-filter:blur(var(--tp-blur)) saturate(var(--tp-saturate)) brightness(var(--tp-lift)) url(#'
        + FILTER_ID + ');'
        + 'backdrop-filter:blur(var(--tp-blur)) saturate(var(--tp-saturate)) brightness(var(--tp-lift)) url(#'
        + FILTER_ID + ');'
        + 'background:'
        + 'linear-gradient(135deg, rgb(255 255 255 / var(--tp-sheen-a)) 0%,'
        + ' rgb(255 255 255 / var(--tp-sheen-b)) 34%,'
        + ' rgb(255 255 255 / 0) 62%),'
        + 'var(--tp-glass-fill) !important;'
        /* The rim is an inset shadow, deliberately not a border: a border takes
           layout space and would resize the element the moment the glass lands. */
        + 'box-shadow:'
        + 'inset 0 0 0 1px var(--tp-glass-edge),'
        + 'inset 0 1px 0 rgb(255 255 255 / var(--tp-rim)),'
        + 'inset 0 -1px 0 rgb(255 255 255 / calc(var(--tp-rim) * 0.35)),'
        + 'inset 0 0 20px rgb(255 255 255 / calc(var(--tp-rim) * 0.30)),'
        + '0 10px 34px var(--tp-glass-shadow) !important}'
      return selector
    }

    /* ======================================================================
       Settings panel.

       The host half declares a Config schema, which is what makes these options
       real settings rather than YAML keys. But a schema alone renders nothing:
       the Plugins page draws a bundle's configuration only for a bundle that
       REGISTERED one, and registration is a browser-half job. The page then
       renders that section between the bundle's description and its rows --
       which is the place a reader would look for it.

       Without this, the schema is registered and invisible: the host reports
       `status: "schema"` while the page shows no controls at all, which is
       exactly what happened before this code existed.

       Values come from ctx.remote.settings, the host's own configuration API:
       describe() returns every namespace with its live value and revision, and
       mutate() writes path-addressed edits. Passing the revision back is what
       makes the write a compare-and-set, so an edit made elsewhere in the
       meantime is reported as a conflict instead of being overwritten.

       Everything here is best-effort. A missing service, an absent namespace or
       a failed read must leave the plugin running -- the settings panel is a
       convenience, and the plugin's actual job is the window. */
    const PACKAGE_NAME = 'dsh-transparent'
    const SETTINGS_NS = 'transparent'

    const PANEL_OPTIONS = [
      { key: 'alpha', label: '整窗不透明度', hint: '255 = 完全不透明；215 = 默认，壁纸透出但内容略淡', kind: 'number', min: 0, max: 255, step: 1 },
      { key: 'darkTheme', label: '强制黑夜主题', hint: '白天主题下的透明会发灰', kind: 'boolean' },
      { key: 'updateCheck', label: '检查更新', hint: '启动时问一次源，有新版本就提示', kind: 'boolean' },
      { key: 'updateSource', label: '自定义更新地址', hint: '留空则用 profile 配置的源', kind: 'text' },
    ]

    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }

    /** A volatile field arrives as { get() }; a plain one as the value. */
    const plainValue = (raw) => {
      if (raw && typeof raw.get === 'function') {
        try { return raw.get() } catch { return undefined }
      }
      return raw
    }

    const buildSettingsPanel = (ctx) => {
      return function TransparentSettings() {
        /* Read the service lazily and defensively.

           `ctx.remote.settings` is declared in the plugin's inject list below,
           so it is present. But constructing the component happens WHILE the
           slot is being registered, and a throw at that moment aborts the
           registration with nothing to show for it -- which is exactly what
           "cannot get property remote without inject" did, twice, silently.
           Reading it inside the render keeps a missing service a visible
           message instead of a vanished panel. */
        let remote = null
        try {
          remote = ctx.remote && ctx.remote.settings ? ctx.remote.settings : null
        } catch {
          remote = null
        }

        const [state, setState] = React.useState({
          status: 'loading', values: {}, revision: undefined, error: null, notice: null,
        })
        const [draft, setDraft] = React.useState({})

        const read = React.useCallback(async () => {
          if (!remote) {
            setState({ status: 'unavailable', values: {}, revision: undefined, error: null, notice: '设置服务不可用（ctx.remote.settings 为空）。' })
            return
          }
          try {
            const view = await remote.describe()
            const list = (view && view.namespaces) || []
            const entry = list.find((n) => String(n.ns) === SETTINGS_NS)
              || list.find((n) => String(n.ns).endsWith(SETTINGS_NS))
            if (entry === undefined) {
              /* Name the namespaces that DO exist. A wrong SETTINGS_NS produced
                 a panel that rendered, said "not registered", and gave no way to
                 tell a wrong name from an absent service -- which is the same
                 silent-no-op pattern that cost several releases already. */
              const names = list.map((n) => String(n.ns)).join(', ') || '(空)'
              setState({
                status: 'unavailable', values: {}, revision: undefined, error: null,
                notice: '找不到命名空间 "' + SETTINGS_NS + '"。现有：' + names,
              })
              return
            }
            const values = {}
            for (const option of PANEL_OPTIONS) {
              values[option.key] = plainValue((entry.value || {})[option.key])
            }
            setState({ status: 'ready', values, revision: entry.revision, error: null, notice: null })
            setDraft({})
          } catch (error) {
            setState({
              status: 'error', values: {}, revision: undefined, notice: null,
              error: error && error.message ? error.message : String(error),
            })
          }
        }, [])

        React.useEffect(() => { read() }, [read])

        const save = async () => {
          const ops = Object.keys(draft).map((key) => ({ op: 'set', path: [key], value: draft[key] }))
          if (ops.length === 0) return
          try {
            const updated = await remote.mutate(SETTINGS_NS, ops, state.revision)
            const values = { ...state.values }
            for (const key of Object.keys(draft)) values[key] = plainValue((updated.value || {})[key])
            setState((s) => ({ ...s, values, revision: updated.revision, error: null, notice: '已保存，重启后生效' }))
            setDraft({})
          } catch (error) {
            setState((s) => ({
              ...s, notice: null,
              error: error && error.message ? error.message : String(error),
            }))
          }
        }

        const e = React.createElement
        const rows = PANEL_OPTIONS.map((option) => {
          const current = option.key in draft ? draft[option.key] : state.values[option.key]
          const control = option.kind === 'boolean'
            ? e('input', {
                type: 'checkbox',
                checked: current === true,
                disabled: state.status !== 'ready',
                onChange: (ev) => setDraft((d) => ({ ...d, [option.key]: ev.target.checked })),
              })
            : e('input', {
                type: option.kind === 'number' ? 'number' : 'text',
                value: current === undefined || current === null ? '' : String(current),
                min: option.min, max: option.max, step: option.step,
                disabled: state.status !== 'ready',
                onChange: (ev) => setDraft((d) => ({
                  ...d,
                  [option.key]: option.kind === 'number' ? Number(ev.target.value) : ev.target.value,
                })),
              })

          return e('label', { key: option.key, className: 'tp-set-row', style: {
            display: 'grid', gridTemplateColumns: '170px 1fr', gap: '10px',
            alignItems: 'center', padding: '8px 0',
          } },
            e('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px' } },
              option.label,
              e('span', { style: { display: 'block', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '16px' } },
                option.hint)),
            control)
        })

        const dirty = Object.keys(draft).length > 0
        const status = state.status === 'loading' ? '读取中…'
          : state.error ? ('读取失败：' + state.error)
            : state.notice ? state.notice
              : state.status === 'unavailable' ? '这些选项尚未注册到设置服务。'
                : ('当前：alpha ' + String(state.values.alpha) + '，主题 ' + (state.values.darkTheme ? '黑夜' : '跟随'))

        return e('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          e('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            '配置'),
          ...rows,
          e('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' } },
            e('button', {
              type: 'button',
              disabled: !dirty || state.status !== 'ready',
              onClick: save,
              style: {
                padding: '5px 14px', borderRadius: '6px', fontSize: '13px', cursor: dirty ? 'pointer' : 'default',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: dirty ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, '保存'),
            e('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, status)))
      }
    }

    const installSettingsPanel = (ctx) => {
      const note = (message) => {
        try {
          // eslint-disable-next-line no-console
          console.log('[transparent] settings panel: ' + message)
        } catch { /* a log must never break the plugin */ }
      }

      if (React === null) { note('SKIP react unavailable'); return }

      const spec = { name: 'plugins.bundle.config', key: PACKAGE_NAME }

      const doRegister = (slots, how) => {
        try {
          const dispose = slots.register(spec, buildSettingsPanel(ctx))
          note('REGISTERED via ' + how + ' (dispose=' + typeof dispose + ')')
          return true
        } catch (error) {
          note('register via ' + how + ' threw: ' + (error && error.message ? error.message : error))
          return false
        }
      }

      /* Report the OUTCOME, not the intent.

         The previous version logged "registered" immediately after calling
         slots.inject(...) -- before the callback that does the work had run, and
         whether or not it ever would. That line was wrong, and it sent this
         investigation the wrong way: the slot had no occupant while the console
         said it did. Hence the two explicit outcomes below. */
      if (!ctx.slots || typeof ctx.slots.register !== 'function') {
        note('SKIP ctx.slots is not a slots service')
        return
      }

      if (doRegister(ctx.slots, 'direct')) return

      if (typeof ctx.slots.inject !== 'function') { note('SKIP no slots.inject'); return }
      try {
        ctx.slots.inject('plugins.bundle.config', () => {
          note('slot became available')
          doRegister(ctx.slots, 'inject callback')
        })
        note('waiting on slots.inject; no result yet')
      } catch (error) {
        note('slots.inject threw: ' + (error && error.message ? error.message : error))
      }
    }

    const plugin = {
      name: 'transparent',
      /* The framework refuses to hand over a service that was not asked for:

           Cannot get property "slots" without inject

       That is a hard rule, not a hint. Declaring it is what makes ctx.slots
       readable in apply() -- and the child-fiber form, ctx.inject(['slots'], cb),
       did NOT substitute for it here: the callback simply never ran, which is
       precisely the silent no-op that cost three releases. */
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        installSettingsPanel(ctx)
        /* Remove the list-extension stylesheet if an earlier revision left one
           behind.

           Disabling a feature by simply not writing its rule again is not
           enough: the <style> element written by the previous revision is still
           in the document and still applies. That is precisely why the broken
           layout survived the revert — the rule was gone from the bundle but not
           from the page. */
        try {
          const stale = document.getElementById(LIST_STYLE_ID)
          if (stale) stale.remove()
        } catch (e) { /* ignore */ }

        console.log('[transparent] v' + BUILD + ' active')
        let via = 'style tag'
        try {
          if (typeof styles === 'object' && styles && typeof styles.insert === 'function') {
            styles.insert(CSS)
            via = 'styles builtin'
          } else {
            throw new Error('no styles builtin')
          }
        } catch (e) {
          let tag = document.getElementById(STYLE_ID)
          if (!tag) {
            tag = document.createElement('style')
            tag.id = STYLE_ID
            document.head.appendChild(tag)
          }
          tag.textContent = CSS
        }

        /* Boot. The composer may mount after plugins apply, so resolution is
           attempted a few times with widening gaps. Frame counts stand in for
           delays because setTimeout is a throwing trap in a client half.

           These are ATTEMPTS, not a polling loop: the first one that succeeds
           ends the sequence for good, because from then on the CSS selector
           handles every future render. */
        let done = !ENABLE_COMPOSER_GLASS
        let reported = false

        const attempt = () => {
          if (done) return
          let card = null
          let anchor = null
          try {
            anchor = findAnchor()
            if (anchor) card = findCard(anchor)
          } catch (e) { card = null }

          if (!anchor || !card) return false

          try {
            /* Build the lens at the card's OWN aspect ratio, downscaled only to
               keep the canvas small. Aspect is what matters; resolution is not,
               because a bevel this soft carries no fine detail.

               The measured radius is used too, so the refracted rim follows the
               corner the app actually drew. */
            const k = Math.min(1, 460 / Math.max(card.box.width, card.box.height))
            const radius = 18
            const lens = buildLensMap(card.box.width * k, card.box.height * k, radius * k)
            if (lens) installFilter(lens)

            const selector = installGlassRule(card.depth)

            /* LIST EXTENSION — DISABLED.

               Three attempts at making chat text travel behind the glass have
               each damaged the layout, and the third one was the worst: the
               element `findList` picked was not the message list, and adding
               margin-bottom plus padding-bottom to it squeezed the sidebar down
               to one character per line.

               The failure is not a tuning problem. It is that the list cannot be
               identified reliably from here: the tallest scrollable element that
               is not inside the composer can be a layout wrapper, and uniqueness
               of a class suffix says nothing about whether the element is the
               right one. Modifying another application's layout without being
               able to see it is the wrong thing to keep attempting.

               What remains is what was verified working: the wallpaper, and the
               glass on the composer. */
            done = true
            if (!reported) {
              reported = true
              console.log('[transparent] v' + BUILD + ' via ' + via
                + ' | selector ' + selector
                + ' | card ' + Math.round(card.box.width) + 'x' + Math.round(card.box.height)
                + ' ratio ' + (card.box.width / card.box.height).toFixed(1) + ':1'
                + ' | depth ' + card.depth
                + ' | glass is CSS-driven, nothing re-applies it')

              /* Overflow state, logged automatically.

                 This is here because asking for it interactively meant asking the
                 user to paste into DevTools, which trips Chrome's self-XSS guard
                 and demands an "allow pasting" confirmation. Reporting it at
                 startup costs one console line and removes that exchange.

                 docOverflow / bodyOverflow above zero mean the document itself is
                 taller than the viewport, which is what produces a window-level
                 scrollbar. If both are zero, any scrollbar on screen belongs to a
                 panel inside the app and cannot be caused by this plugin. */
              try {
                const de = document.documentElement
                const bd = document.body
                const ours = document.querySelectorAll('style[id^="dsh-transparent"], svg#dsh-transparent-svg')
                console.log('[transparent] v' + BUILD + ' diag'
                  + ' | docOverflow ' + (de.scrollHeight - de.clientHeight)
                  + ' | bodyOverflow ' + (bd.scrollHeight - bd.clientHeight)
                  + ' | docScroll ' + de.scrollHeight + '/' + de.clientHeight
                  + ' | ourNodes ' + ours.length
                  + ' | bodyKids ' + bd.children.length)
              } catch (e) { /* diagnostics must never break setup */ }
            }
          } catch (e) {
            console.error('[transparent] glass setup failed', e && e.message)
          }
          return done
        }

        const bootAt = (frames) => {
          let n = frames
          const step = () => {
            if (done) return
            if (n-- <= 0) { if (!attempt()) bootAt(60); return }
            window.requestAnimationFrame(step)
          }
          window.requestAnimationFrame(step)
        }

        try {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            if (!attempt()) { bootAt(20); bootAt(120); bootAt(400) }
          }))
        } catch (e) { attempt() }

        window.__tp = {
          retry: () => { done = false; reported = false; return attempt() },
          depth: () => { const a = findAnchor(); const c = a ? findCard(a) : null; return c ? c.depth : 0 },
          /* One-line diagnostic for "something moved and I do not know what".
             Answers the two questions that actually decide it: does the document
             overflow (and therefore show a scrollbar), and which of our own style
             elements are currently in the page. Pure reads. */
          diag: () => {
            const de = document.documentElement
            const bd = document.body
            return {
              docOverflow: de.scrollHeight - de.clientHeight,
              bodyOverflow: bd.scrollHeight - bd.clientHeight,
              ourStyleTags: Array.from(document.querySelectorAll('style[id^="dsh-transparent"], svg#dsh-transparent-svg'))
                .map((s) => s.tagName + '#' + s.id),
              bodyChildren: Array.from(bd.children).map((e) => {
                const r = e.getBoundingClientRect()
                return e.tagName + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                  + ' ' + (getComputedStyle(e).position)
              }),
            }
          },

          layout: () => {
            const a = findAnchor()
            const c = a ? findCard(a) : null
            return a ? describeLayout(a, c ? c.el : null) : ['composer not found']
          },
        }

        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            const a = document.getElementById(STYLE_ID)
            if (a) a.remove()
            const b = document.getElementById(GLASS_STYLE_ID)
            if (b) b.remove()
            const c = document.getElementById(FILTER_HOST_ID)
            if (c) c.remove()
            if (window.__tp) delete window.__tp
          }, 'dsh-transparent: stylesheet')
        }
      },
    }

    exports.default = plugin
    exports.plugin = plugin
    exports.apply = plugin.apply
    exports.name = plugin.name
    exports.inject = plugin.inject

    return module.exports
  },
})








