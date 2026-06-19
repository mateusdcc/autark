# Touch support for `autk-plot` and `autk-map`

## Current state at a glance

| Input gesture | `autk-map` | `autk-plot` |
|---|---|---|
| Single-pointer drag / pan | ✅ Pointer Events | n/a (no pan) |
| Mark/row tap selection | n/a | ⚠️ works via synthesized `click`, but no `touch-action` |
| Brush | n/a | ⚠️ D3 v7 uses Pointer Events, but no `touch-action` |
| Scroll/pinch zoom | ❌ `wheel` only | n/a |
| Pick (feature selection) | ❌ `dblclick` only | n/a |
| Two-finger rotate/tilt | ❌ none | n/a |

The good news: both stacks already sit on Pointer Events / D3 v7, so the **mechanical** event wiring is mostly touch-capable. The gaps are: (1) missing `touch-action: none` CSS, (2) zoom/pick tied to mouse-only events, and (3) no multi-touch (pinch) handling.

---

## 1. `autk-map` — `autk-map/src/events-mouse.ts`

**1a. No `touch-action: none` on the canvas (critical).**
The canvas never gets `touch-action: none` set in code. Only two gallery CSS files (`gallery/src/autk-map/building-picking.css`, `compute-render-osm-view-score.css`) set it. Without it, on touch devices the browser intercepts one-finger pan to scroll the page and two-finger pinch to zoom the page, so the map's pointer handlers never get a chance to drag. This is the single highest-impact fix.
- **Change:** set `canvas.style.touchAction = 'none'` in `MouseEvents.bindEvents()` (`events-mouse.ts` ~line 84) — or in `AutkMap.init()`/constructor. Remove in `destroyEvents()`. This makes the library self-contained instead of relying on each gallery page's CSS.

**1b. Zoom is `wheel`-only (`mouseWheel`, line ~210).**
`wheel` does not fire on touch. There is no pinch-zoom. Currently the only way to zoom on touch is… none.
- **Change:** add pinch-zoom via two-pointer tracking. Pointer Events deliver one `pointerdown/move/up` per active finger with `event.pointerId`. Today the class tracks a single `_lastPoint` and a single `_status`, so a second finger overwrites state and produces jitter.
  - Track an active-pointers map: `Map<pointerId, [x,y]>`.
  - On `pointermove` with two active pointers over the canvas, compute the inter-pointer distance delta and call `this._map.camera.zoom(delta, centerX, centerY)` anchored at the midpoint (reuse `mouseWheel`'s normalization logic).
  - With one pointer, keep existing pan/shift-orbit behavior.
  - One-pointer drag should still work; the existing `event.buttons === 1` deferred-drag detection in `pointerMove` (line ~149) already covers touch contact (`buttons === 1`).

**1c. Picking is `dblclick`-only (`mouseDoubleClick`, line ~226).**
`dblclick` is unreliable/absent on touch (double-tap is not a standardized DOM event across mobile browsers, and Safari often fires it late or not at all). On touch there is currently no way to pick a feature.
- **Change:** add a touch-friendly pick trigger. Options:
  - **Tap** (single `pointerup` without preceding drag movement, i.e. a "tap" detector): forward to the same picking path as `mouseDoubleClick`. This is the most discoverable on touch but changes mouse semantics unless gated by `event.pointerType === 'touch'`.
  - **Two-finger tap** / **long-press**: less discoverable but won't collide with desktop click behavior.
  - Recommended: implement a small tap detector (pointerdown→pointerup within ~300ms and <10px movement) that, when `pointerType === 'touch'`, calls the existing picking code (`activePickingLayer.layerRenderInfo.pickedComps = [x, y]`). Keep `dblclick` for mouse. Refactor the body of `mouseDoubleClick` into a shared `pickAt(clientX, clientY)` helper so both paths share logic.

**1d. Shift+drag orbit has no touch equivalent (`pointerMove`, line ~163).**
`event.shiftKey` is never true on touch, so orbit/tilt is unreachable on touch devices.
- **Change:** map a two-finger drag (no pinch, i.e. both fingers move in the same direction) to `camera.yaw`/`pitch`, mirroring the shift+drag path. This pairs naturally with the two-pointer tracking added in 1b (pinch = zoom, two-finger drag = orbit). One-finger drag stays as pan.

**1e. `contextmenu` suppression (`contextMenu`, line ~110).**
On touch, long-press can trigger the OS context menu / iOS callout before `contextmenu` fires; `touch-action: none` (1a) plus `-webkit-touch-callout: none` helps. The current `contextmenu` preventDefault is still worth keeping for mouse right-click.

**1f. Class/module naming.**
`MouseEvents` / `MouseStatus` / `events-mouse.ts` are now misnomers since they already handle pointer input and will handle touch. Optional: rename to `PointerEvents` / `PointerStatus` / `events-pointer.ts`. This is cosmetic but improves clarity; not required for behavior.

---

## 2. `autk-plot` — `autk-plot/src/plot-base-interactive.ts` + `plots/`

**2a. No `touch-action: none` on brushable elements (critical).**
D3 v7 brushes dispatch through Pointer Events and *do* support touch — but only if the browser doesn't steal the gesture first. D3's own docs require `touch-action: none` on the brushed element. None of the plot render code sets it (the `.autkBrush`/`.autkMarksGroup` `<g>` or the root `<svg>`). On touch, attempting to brush will scroll the page instead.
- **Change:** in each plot's `render()` (or centrally in `PlotBaseInteractive`), set `touch-action: none` on the root SVG (`svg.style('touch-action', 'none')`) and/or on the `.autkBrush` group. Cleanest single point: add it in `PlotBaseInteractive` via a shared hook, or set it on the `#plot` svg in each `render()`. The `autkClear` overlay rect should also inherit it (it's inside the group).

**2b. Mark click selection (`clickEvent`, line ~231) and `autkClear` click.**
`.on('click')` fires on tap (synthesized from touchend), so selection already works on touch *in principle*. The practical risk is the 300ms tap delay and scroll-conflict; `touch-action: none` (2a) resolves the conflict. No logic change needed beyond 2a, but worth verifying on device.

**2c. `parallel-coordinates` axis-label color-by click (`pcoordinates.ts` render).**
`.on('click', ...)` on `.axis-label` — tap works via synthesized click. No change needed once `touch-action` is set on the SVG. (Possibly enlarge the hit area for fingers — the labels are small text; consider `pointer-events` padding or larger font, but optional.)

**2d. `tablevis` header sort click (`tablevis.ts` render).**
`<th>.on('click', ...)` — tap works. Row `<tr>` click selection also works. The table container has `overflow: auto` so vertical scroll on touch is desirable — **do not** set `touch-action: none` on the table container, only on header cells if needed (likely unnecessary). No change required for sort; row selection already works via the events system.

**2e. Brush hit-area sizing.**
D3 brush handles are tiny and hard to hit with a finger. This is a UX polish item, not a correctness bug; out of scope unless requested.

---

## 3. Cross-cutting

**3a. Tests.**
All existing Playwright tests (`tests/gallery/autk-plot/*`, map tests) use mouse events. To guard touch support, add a small set of Playwright touch tests using `page.touchscreen.tap()` / `touchscreen.tap()` and synthetic pinch via `page.dispatchEvent` of `pointerdown`/`pointermove` with two `pointerId`s. At minimum: tap-select on scatterplot, brush on a histogram, pinch-zoom + tap-pick on the map.

**3b. Verify Pointer Event coverage.**
Both packages already use Pointer Events, so no `touchstart/touchmove/touchend` migration is needed anywhere — confirm no stray `mousedown/mousemove/mouseup` listeners exist (grep showed none in the library code; only `dblclick` and `wheel` remain, addressed above).

---

## Recommended implementation order

1. **`touch-action: none`** on map canvas + plot SVGs (1a, 2a). Small, huge win, low risk. Verify with a quick device/simulator check.
2. **Touch pick trigger** + shared `pickAt()` helper (1c). Unblocks feature selection on touch.
3. **Pinch-zoom** via two-pointer tracking (1b). Largest change; refactor `_lastPoint`/`_status` into a per-pointer map.
4. **Two-finger orbit** (1d). Builds on the two-pointer tracking from step 3.
5. **Playwright touch tests** (3a).
6. Optional rename `MouseEvents`→`PointerEvents` (1f).
