# Elevating the intelligence graph (Liam + OSS) → the Samaritan **Pulse** tab

Decision-ready research brief. Opinionated; file/repo citations are real. Produced
from a 4-agent analysis of **Liam** (`liam-hq/liam`, Apache-2.0, cloned to
`C:/Users/Admin/liam-ref`), the OSS graph-viz landscape, and the Samaritan
integration path.

> **Naming (decided):** when the feeder's intelligence graph is ported into the
> Samaritan web UI it is the **"Pulse"** tab — NOT "Graph" (Samaritan already has a
> Graph tab tied to its **memory** feature; reusing the name collides). Place
> **Pulse** next to the three tabs already sourced from the feeder via the proxy —
> **Discover, Events, Radar** — so it groups with its siblings. (The report below
> originally suggested `intel-graph` to dodge the collision; we use **`pulse`** as
> the route/label instead.) The feeder's *own* console tab stays "Graph".

---

## TL;DR — highest-leverage moves

| # | Move | Effort | Impact |
|---|------|--------|--------|
| 1 | **Copy Liam's dark design-token CSS** (`liam-ref/frontend/packages/ui/src/styles/Dark/variables.css`, 416 lines, zero framework coupling) and alias the feeder's `wm-*`/`theme.css` onto it. Reskin only the `#1ded83` accent. | **XS** (½ day) | **High** — unifies feeder + Samaritan look instantly, underpins everything else |
| 2 | **Add `graphology` + `graphology-communities-louvain` + `forceatlas2` as a data layer** under the *existing* `react-force-graph-2d` canvas — cluster coloring + cleaner separation, no renderer swap. | **S–M** (2–4 days) | **High** — biggest legibility ROI; de-risks any future Sigma migration |
| 3 | **Keep react-force-graph; do NOT migrate the main graph to React Flow or WebGL.** Borrow Liam's *look* (node cards, toolbar, ⌘K, minimap/dot-grid), not its engine. | n/a (a decision) | **High** — avoids a multi-week regression on a 100–500 node graph |
| 4 | **Port the feeder graph into Samaritan as the `pulse` tab** (next to Discover/Events/Radar): proxy prefix + NavItem + Route + copied `GraphView`. | **S** (1–2 days) | **Medium-High** — ships the feature; zero new auth code |
| 5 | **Lift Liam's token-driven UI primitives** (`Button`, `IconButton`, `Drawer`, `Resizable`, `Tabs`) as the node-detail panel / left-pane split / floating toolbar chrome. | **M** (spread over phase 2) | **Medium** — polish, reusable across both apps |

---

## Recommended graph engine

### Verdict: **KEEP `react-force-graph-2d` and polish it.** Do not migrate to React Flow. Do not go WebGL yet.

The decisive fact is **scale**, and the feeder's scale is small. `src/routes/graph.ts:130` caps `/network` at `Math.min(Number(limit ?? 100), 500)` — hard ceiling **500 nodes**, live default **100** (`GraphView.tsx`). That is squarely **canvas territory**. The "WebGL is mandatory" narrative (Sigma/Cosmograph, "100k+ nodes") solves a problem the feeder *does not have*.

The current canvas is already the right *renderer class*. The real gaps are **layout quality, clustering, interaction polish, and integration look** — none of which require a renderer swap. And `react-force-graph-2d` already does the feeder's signature per-node art a DOM renderer can't cheaply reproduce: hub glow halos, entity discs vs hollow event rings, zoom-gated label halos, curved teal lineage edges with directional particles.

### Why the rejected options lose *for this use case*

- **Migrate to React Flow / `@xyflow/react` (Liam's stack).** WRONG engine for a dense force graph — xyflow's maintainers state it's *not intended for 1000+ nodes*; every node is a DOM element and node movement triggers React re-renders. It *is* right for ONE complementary mode — a hand-curated "investigation board" of a few dozen pinned nodes with rich HTML cards + ELK/dagre layout. Use it there, not as the main engine.
- **Go WebGL (Sigma.js / cosmos.gl).** Sigma v3 (MIT, graphology-native) renders ~100k edges and is the correct *escape hatch* — but its shader model is **less** flexible than canvas free-draw for the feeder's bespoke glow/particle art; cosmos.gl has **no official React wrapper**. Trigger only if a single view must render **>~2–3k nodes**. Adopting graphology now (move #2) makes that future step small.
- **Cytoscape.js / AntV G6.** Heavier frameworks; adopting them means abandoning the custom canvas. **Adopt the ideas** (Cytoscape's `fcose` compound-spring layout, convex-hull cluster nodes), not the dependency.
- **Commercial (Ogma, ReGraph, KeyLines, yFiles).** Best-in-class intel UX but proprietary. Use them as a **feature checklist** only: lasso multi-select, time-range brush, community hulls, edge bundling.

---

## Look & feel from Liam — concrete adoptions

Liam ERD (Apache-2.0, © 2024 ROUTE06, Inc.) gives two cleanly separable wins: a **copy-paste token system** and a set of **portable canvas/chrome patterns**. Map everything onto the feeder's existing `wm-*` dark theme by aliasing.

| Adoption | Port vs Idea | Source | Maps onto feeder |
|----------|--------------|--------|------------------|
| **Dark design tokens** — gray ramp `--color-gray-0..1000`, semantic `--global-*`/`--node-*`/`--pane-*`/`--button-*`/`--toolbar-*`, spacing (4px base), radius, `--z-index-*`, scrollbar tokens | **PORT** (verbatim) | `…/ui/src/styles/Dark/variables.css` | Alias `wm-*`/`theme.css` onto these. `--node-block`/`--node-action`/`--node-partial` map to entity-type colors. Reskin `#1ded83` → brand |
| **Custom DOM node component** (icon + label + type pill; hover/active/highlight; Radix tooltip) | **PORT (CSS) + IDEA (structure)** | `…/ERDContent/components/TableNode/*` | The glow recipe (min-width, `box-shadow`, accent border + green glow on highlight, `[data-loading]` fade) ports almost verbatim — only if you adopt a DOM renderer for the board mode. For the canvas, copy the **color/glow values**, not the markup |
| **Bezier edge + animated-particle highlight** | **IDEA** | `…/RelationshipEdge/*` | Crow's-feet are irrelevant; the **animated "active provenance path"** on focus upgrades the feeder's straight confidence lines — extend the existing directional particles |
| **Floating Radix toolbar** (zoom / fit / tidy / show-mode pill) | **PORT (CSS+structure) + adopt-dep** `@radix-ui/react-toolbar` | `…/Toolbar/DesktopToolbar.tsx`, `ZoomControls/`, `FitviewButton/` | `ShowModeMenu` (ALL/KEY_ONLY/NAME) = the direct analog of the feeder's **declutter toggles** |
| **⌘K command palette** (`cmdk` + Radix Dialog, live preview) | **IDEA + adopt-dep** `cmdk`, `@radix-ui/react-dialog` (MIT) | `…/CommandPalette/*` | Strict upgrade to the search-to-center box: fuzzy-find entity/event → Enter to center+focus |
| **Minimap / Controls / dot-grid Background** | **IDEA** (reimplement in `wm-*`) | React Flow `<Background variant={Dots}>` | Canvas chrome polish against the existing canvas |
| **UI primitives** — `Button`/`IconButton`/`Drawer`/`Resizable`/`Tabs`/`Tooltip` (token-driven, Radix + clsx + ts-pattern) | **PORT (per-component) + adopt-dep** | `…/ui/src/components/{Button,IconButton,Drawer,Resizable,Tabs}/*` | `Drawer` = node-detail panel; `Resizable` = left-pane split; `Tabs` = view-mode switch |
| **App-shell theming** (single `@import` token line; `grid-template-rows auto 1fr`; `pointer-events:none` wrapper / `auto` children so canvas stays live under the toolbar) | **IDEA + PORT (the import line)** | `apps/app/app/globals.css`; `ERDRenderer.module.css` | The integration recipe so the **Pulse** tab matches Discover/Radar |

> **Attribution (Apache-2.0):** any file copied substantially (token CSS, component `.module.css`/`.tsx`) must **retain the `© 2024 ROUTE06, Inc.` header** and ship a **`NOTICE`** crediting "Liam ERD, Apache-2.0." Ideas reimplemented from scratch carry no legal obligation. Do **not** port the token-generation pipeline (`figma-to-css-variables`, Style Dictionary) — the feeder has no Figma source; adopt only the *delivery model* (tokens as generated CSS custom properties consumed by both apps).

---

## OSS ideas & ports — ranked landscape

| Rank | Library / project | Best at | License | React fit | Perf ceiling | What to take |
|------|-------------------|---------|---------|-----------|--------------|--------------|
| **1** | **react-force-graph-2d** (vasturiano) | Bespoke canvas node art at 100s–low-1000s | MIT | Native (in use) | Low-thousands | **Keep it.** The feeder's identity |
| **2** | **graphology + louvain + forceatlas2** | Community detection + clean force separation as a *data layer* | MIT | Agnostic | n/a | **Adopt.** Compute `clusterId` + seed positions → feed existing canvas. Biggest ROI |
| **3** | **Sigma.js v3** (`@react-sigma/core`) | WebGL render at scale | MIT | Idiomatic hooks | ~100k edges | **Idea now / dep later.** Escape hatch past ~2–3k visible nodes |
| **4** | **React Flow / `@xyflow/react`** (Liam) | Curated draggable HTML-card boards | MIT | Native | *Not* 1000+ nodes | **Idea (engine) + dep (board mode only).** Node-card language, MiniMap/Controls/Background |
| **5** | **Cytoscape.js + `fcose`** / **AntV G6 v5** | Analysis layouts; compound/cluster nodes | MIT | wrappers exist | High (G6 WebGL) | **Ideas only:** `fcose` separation, convex-hull community outlines, combo/group interactions, edge bundling |
| **6** | **elkjs** / **`@dagrejs/dagre`** | Layered/DAG hierarchy layout | **EPL-2.0** / MIT | via adapters | n/a | **Idea:** lay out the event→event **lineage DAG subview** with **dagre (MIT)** when "Include lineage" is on. **ELK is EPL-2.0**, not MIT |
| **7** | cosmos.gl / vis-network / ngraph | GPU force at 100k+ / small diagrams / layout toolkit | MIT / Apache-MIT / MIT | none / fine / n/a | huge / low / n/a | **Skip** for now |
| — | Ogma / ReGraph / KeyLines / yFiles | Best-in-class intel UX | **Proprietary** | — | — | **Feature checklist only** (no code) |

### Specific capabilities to port (priority order)
1. **Louvain community detection → cluster coloring + convex-hull outlines** (graphology). The single biggest legibility win; replaces the hand-tuned d3 charge/link/collide config.
2. **ForceAtlas2 seed layout** (optional web-worker) for cleaner separation than current d3-force.
3. **dagre layered layout for the lineage-DAG subview** — provenance chains read top-down, stable, no jitter.
4. **Lasso / rubber-band multi-select** — not yet present.
5. **Time-range brush on `firstSeenAt`/`lastSeenAt`** — already exposed in `EntityStats`, so mostly UI.
6. **⌘K search-to-center palette** (cmdk) replacing the current search box.

---

## Samaritan **Pulse** tab — integration plan

### The one real blocker: namespace collision
The `graph` route and `sidebar.graph` label are already taken by the **chat-memory graph** (Samaritan `apps/web` Sidebar/App + server). The feeder OSINT graph **must register under a new name — use `pulse`.** Place it next to the feeder-sourced **Discover, Events, Radar** tabs.

### Smallest working path (ship this first)
1. **Proxy wiring** — add `pulse` to `FEEDER_PREFIXES` in `C:/Users/Admin/samaritan/apps/server/src/proxy/feeder-proxy.ts` (gated on `SAMARITAN_FEEDER_URL`, header injection already handled).
2. **Feeder side** — mount `graphRoutes` under `/pulse` (alongside `/graph`) in the feeder `src/index.ts` so proxied `/pulse/network` etc. resolve.
3. **Component reuse — COPY** `GraphView` + its theme into Samaritan `apps/web`; `npm i react-force-graph-2d`; repoint its API calls to the proxied `pulse` endpoints.
4. **Tab registration** — mirror `apps/web/src/routes/Radar.tsx`: one `NavItem` + one `Route` + wrap in `PageShell` + one i18n key — placed adjacent to Discover/Events/Radar.
5. **Auth/data/theming** — **zero new auth code** (rides the existing feeder-proxy auth). Theming: this is exactly where token move #1 pays off — alias tokens first and the copied `GraphView` inherits the dark shell and matches Discover/Radar.

### Better long-term path
- Extract `GraphView` + the graph client into a **shared package** consumed by both the feeder console and `apps/web` (instead of a copy that drifts).
- Layer in the **graphology data layer** (move #2) + the **Liam-look chrome** (toolbar, ⌘K, Drawer node-detail) so Pulse is the polished version, not the raw canvas.
- Add the **React Flow "investigation board"** as a *second mode* within Pulse once the force view is solid.

> Reject **iframe** embedding — it breaks shared theming, shared auth context, and the unified-look goal.

---

## Phased roadmap

### Phase 1 — Quick polish on the current canvas *(no renderer swap)*
- `feat(theme): import Liam dark tokens + alias wm-* vars` — copy `Dark/variables.css`, add `NOTICE`, reskin accent.
- `feat(graph): graphology louvain clusters + forceatlas2 seed` — data layer feeding `react-force-graph-2d`; color nodes by `clusterId`.
- `feat(graph): dagre layout for the lineage-DAG subview` (when "Include lineage" is on).

### Phase 2 — Liam look-and-feel *(still canvas-primary)*
- `feat(graph): floating Radix toolbar (zoom/fit/tidy/declutter)`.
- `feat(graph): ⌘K command palette (cmdk) search-to-center`.
- `feat(graph): Drawer node-detail panel + Resizable left pane`.
- `feat(graph): community hulls + lasso multi-select + time-range brush`.
- *(optional)* `feat(graph): React Flow "investigation board" mode`.

### Phase 3 — Samaritan **Pulse** tab
- `feat(proxy): add pulse to FEEDER_PREFIXES`.
- `feat(feeder): mount graph routes under /pulse`.
- `feat(web): pulse tab (NavItem + Route + PageShell + i18n) next to Discover/Events/Radar`.
- *(long-term)* `refactor: extract shared graph package consumed by feeder + apps/web`.

---

## Licensing

| Source | License | Obligation |
|--------|---------|------------|
| **Liam ERD** (token CSS, component CSS/TSX copied) | **Apache-2.0**, © 2024 ROUTE06, Inc. | Retain copyright header on copied files; ship a `NOTICE` crediting Liam ERD. Apache-2.0 is permissive and **compatible with the feeder's MIT** — but it adds an **affirmative attribution duty** (headers + NOTICE) the SpiderFoot MIT→MIT port did not |
| **Feeder** | **MIT** | Baseline; no change |
| **react-force-graph, graphology(+louvain/FA2), Sigma, @xyflow/react, cmdk, Radix, clsx, ts-pattern, dagre** | **MIT** | Standard MIT attribution in a bundled licenses file |
| **elkjs (ELK)** | **EPL-2.0 (weak/file-level copyleft)** | **The one to watch.** Fine to depend on unmodified, but a distinct obligation — prefer **dagre (MIT)** for the lineage layout to avoid it |
| **Commercial (Ogma/ReGraph/yFiles)** | Proprietary | **Excluded** — copy capabilities, never code |

**Bottom line:** copy Liam's tokens today (XS, high impact). Keep `react-force-graph` and add the graphology algorithm layer under it — that's the real upgrade, not a renderer migration. Steal Liam's *look* (node cards, toolbar, ⌘K, drawer) but not its *engine*. Ship the Samaritan **Pulse** tab via the existing feeder-proxy with zero new auth, next to Discover/Events/Radar. Mind only one non-permissive license (elkjs/EPL-2.0) and prefer dagre to sidestep it.
