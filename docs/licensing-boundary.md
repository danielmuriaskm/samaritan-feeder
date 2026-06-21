# Licensing Boundary: MIT Feeder vs AGPL worldmonitor

This is the definitive statement of the licensing boundary between **this repo
(the Samaritan feeder, MIT)** and **worldmonitor (AGPL-3.0)**. It exists because
worldmonitor was an *idea source* during the design of the feeder's intelligence
"brain" — and ideas are free, but code is not. Getting this boundary wrong would
relicense the entire feeder under copyleft. The rules below are not stylistic;
they are what keeps `LICENSE` (MIT) true.

## TL;DR

- **The feeder is MIT.** Anyone may use, copy, modify, and ship it, including in
  closed-source/commercial products, with no source-availability obligation.
  (`LICENSE`, `Copyright (c) 2026 Samaritan`.)
- **worldmonitor is AGPL-3.0** (`Copyright (C) 2024-2026 Elie Habib`; the repo's
  `README.md` states "AGPL-3.0-only for the source code"). Its checkout lives at
  `../_worldmonitor_tmp/` purely as a **reference**; nothing from it is copied
  into this repo's distributed tree.
- **No worldmonitor source code, prompt strings, or curated data tables were
  copied into the feeder.** The whole brain layer was built **clean-room** from
  public methods/algorithms/API facts only.
- The **only** lawful way to run worldmonitor's actual code with this project is a
  **separate AGPL frontend** that talks to the MIT feeder **over the network**
  (HTTP / MCP). That keeps the two as independent programs: the feeder stays MIT;
  the frontend's operator carries the AGPL obligations.

## 1. Why copying worldmonitor code into the feeder is forbidden

AGPL-3.0 is a **strong copyleft, network-aware** license. The two licenses are
**one-directionally incompatible**: you may freely fold MIT code *into* an AGPL
project, but you may **not** fold AGPL code into an MIT project and keep it MIT.

### It would make the feeder a "covered work"

AGPL §0 defines "modify" as copying from or adapting "all or part of the work in a
fashion requiring copyright permission," producing a "modified version" or a work
"based on" the Program; a **"covered work"** is "either the unmodified Program or
a work based on the Program." The moment feeder source contains a non-trivial
copy or adaptation of worldmonitor source, the feeder becomes a work *based on*
worldmonitor — a covered work — and falls under the AGPL.

### §5 then forces the whole feeder to AGPL

AGPL **§5 (Conveying Modified Source Versions)** requires, for a work based on the
Program, that "you must license the **entire work, as a whole**, under this
License to anyone who comes into possession of a copy … to the whole of the work,
and all its parts, regardless of how they are packaged" (§5c). There is no
"just this file is AGPL" — copyleft is **viral across the linked whole**. The MIT
grant in `LICENSE` would be contradicted: you cannot offer the same combined work
under MIT's permissive terms while §5 obliges AGPL terms on all of it.

### In-process linking pulls it in — a folder boundary does not save you

Importing an AGPL module (`import … from`/`require`) and calling it in the same
process produces a **single combined program** that shares control flow and data
structures. AGPL §1's "Corresponding Source" explicitly reaches "the source code
for shared libraries and dynamically linked subprograms that the work is
specifically designed to require, such as by intimate data communication or
control flow." That is exactly an in-process import. Putting copied code under a
different subdirectory, renaming symbols, or wrapping it in a thin adapter does
**not** create a license boundary — it is still one covered work.

### §13 closes the "but we only run it as a server" escape

Plain GPL has a loophole: you can run a modified version on a server and never
distribute (convey) the binary, so source-availability never triggers. AGPL
**§13 (Remote Network Interaction)** removes that loophole:

> if you modify the Program, your modified version must **prominently offer all
> users interacting with it remotely through a computer network** … an
> opportunity to receive the Corresponding Source of your version … from a network
> server at no charge.

So even a feeder that is *never distributed* and only *serves API responses* —
exactly the feeder's deployment shape — would, if it contained worldmonitor code,
owe its **complete Corresponding Source** to every remote user of `/api/*`. That
is the precise obligation MIT is supposed to avoid.

### The incompatibility is one-directional

| Direction | Allowed? | Why |
|-----------|----------|-----|
| MIT feeder code → reused in an AGPL project | **Yes** | MIT permits relicensing; AGPL can absorb permissive code. |
| AGPL worldmonitor code → reused in the MIT feeder | **No** | §5 forces the entire combined work to AGPL; you cannot keep it MIT. |

This is why the rule is absolute: **do not copy, paste, port line-by-line, or
machine-translate any worldmonitor source into this repository.**

## 2. The clean-room rule: ideas are free, expression is not

Copyright protects **expression**, not **ideas, methods, or facts**
(idea/expression dichotomy; in U.S. terms, 17 U.S.C. §102(b)). The brain layer was
built on the safe side of that line.

**Safe to reimplement from scratch (not protected by worldmonitor's copyright):**

- **Methods and algorithms** — that a composite score can blend recency, source
  authority, corroboration, and velocity; that cross-stream convergence is worth
  detecting; that a source going quiet ("silent source") is itself a signal; the
  *idea* of freshness/velocity-spike/volume-anomaly detection.
- **Architecture and API facts** — endpoint shapes, that delivery can fan out to
  Telegram/Discord/Slack/webhook/email, the concept of a grounded brief, the
  notion of geo-enrichment. Facts and interfaces are not copyrightable expression.
- **Public, factual data** — e.g. that a given agency publishes an authoritative
  feed at a known URL (a fact you can independently verify and re-encode).

**NOT safe to copy (protected expression — these are the bright lines):**

- **Literal source code** — verbatim or lightly-edited functions, classes,
  type definitions, file layouts copied from worldmonitor.
- **Prompt strings** — the exact wording of an LLM system/user prompt is creative
  expression. Reuse the *technique*; **write your own prompt text.**
- **Curated data tables** — hand-assembled source lists, weighting tables,
  taxonomies, keyword/lexicon sets, scoring constants. The *selection and
  arrangement* of such a compilation is protected even when each datum is a fact.
  Re-derive these independently; do not transcribe worldmonitor's.

**Status of this repo:** the entire brain layer — composite scoring,
cross-stream convergence, freshness / silent-source detection, multi-channel
delivery, grounded briefs, geo enrichment, the new MCP tools, and the new
authoritative adapters — was implemented **clean-room on this basis**: built from
described methods, algorithms, and API facts, with original code, original prompt
text, and independently-derived data. worldmonitor was an **idea source only**;
its code was **never copied**. That is what makes the MIT grant in `LICENSE`
accurate.

## 3. The network boundary: the ONLY way to use worldmonitor's real code

You *can* combine this project with worldmonitor's **actual** (AGPL) code — but
only across a **process and network boundary**, never by linking it in.

### Why a network call is a true boundary

AGPL §0: "Mere interaction with a user through a computer network, with no
transfer of a copy, is **not conveying**." Two programs that communicate only by
sending HTTP requests / MCP messages over a socket are **separate works**, not one
combined work — there is no shared address space, no shared control flow, no
linking. The feeder serving JSON over `/api/*` and a client consuming it are as
independent as a browser and a web server.

### The shape

```
        ┌──────────────────────────────┐         HTTP / MCP          ┌───────────────────────────┐
        │  Samaritan feeder (THIS repo) │  ◀── /api/events ──────────│  worldmonitor frontend     │
        │  MIT — LICENSE                │      /api/signals          │  (separate repo, AGPL-3.0) │
        │  serves intelligence over     │      /api/brief/:user      │  worldmonitor's OWN code   │
        │  HTTP + MCP, no AGPL code     │ ───  /api/stream (SSE) ───▶ │  renders the dashboard     │
        └──────────────────────────────┘      MCP: top_intelligence │  operator owes §13 source  │
                                               query_signals, etc.   └───────────────────────────┘
```

The feeder is the **server**; the AGPL frontend is a **separate client program**
in its **own repository and process**. They exchange only data (events, signals,
briefs, the SSE stream, MCP tool results) — never code.

### What AGPL §13 obliges the *frontend operator* to do

If someone deploys an AGPL frontend (worldmonitor's own modified code) that talks
to this feeder and lets users interact with it over a network, **that operator**
must, per §13, prominently offer those users the Corresponding Source **of the
AGPL frontend**, from a network server at no charge (typically a visible "Source"
link, as the AGPL's own appendix suggests). That is the AGPL frontend operator's
obligation, arising from running AGPL code as a network service.

### Why this does NOT infect the feeder

- The feeder contains **no AGPL code**, so it is not a covered work and §13 never
  attaches to it.
- "Corresponding Source" of the AGPL frontend covers the frontend and what it is
  "specifically designed to require" by linking — **not** a separate upstream HTTP
  data source. The feeder is a separate program reached over the network, exactly
  the "mere interaction … not conveying" case.
- The feeder's MIT terms are unaffected: it may stay closed, be sold, and carry no
  source offer. The copyleft stops at the socket.

> One direction only: an AGPL frontend may consume the MIT feeder freely (MIT
> imposes no conditions on callers). The reverse — the MIT feeder importing or
> bundling the AGPL frontend's code — is the §5 trap in Section 1 and is
> forbidden.

## 4. Why this repo's own `web/` console is MIT (not worldmonitor code)

This repository ships its own operator console under `web/`. It is **MIT**, part
of the same `LICENSE`-covered work, for the same reason the brain layer is:

- It was written **clean-room** — original React 19 function components with
  inline styles, fetching through this repo's own `web/src/lib/api.ts`,
  `web/src/lib/types.ts`, and `web/src/lib/useSSE.ts`. **None of worldmonitor's UI
  source, components, or styles were copied.**
- Building a dashboard that shows events, signals, source health, and briefs is an
  **idea/method**, not protected expression. Independently-authored UI over the
  feeder's own public API is original work.
- It runs **in-process with the MIT feeder** and links only this repo's MIT code —
  which is fine precisely *because* none of that code is AGPL. (The same
  in-process linking would be fatal if the linked code were worldmonitor's; here
  it is not.)

So there are two clients of the feeder's API, with deliberately different license
status, and the difference is **provenance, not protocol**:

| Client | License | Why |
|--------|---------|-----|
| `web/` console (this repo) | **MIT** | Clean-room, original code; contains no worldmonitor source. |
| A worldmonitor AGPL frontend (separate repo) | **AGPL-3.0** | It *is* worldmonitor's own code; its operator owes §13 source for *that* frontend. |

Both reach the feeder the same way (HTTP/MCP). The MIT one happens to also be
co-located and in-process — allowed only because it carries no AGPL code.

## 5. Do / Don't checklist

**DO**

- Keep worldmonitor at arm's length as a **reference** (`../_worldmonitor_tmp/`)
  for *understanding methods and API facts only*.
- Reimplement algorithms, scoring methods, detection ideas, endpoint shapes, and
  delivery patterns in **original code**.
- Write **your own** prompt strings; re-derive **your own** source lists, weights,
  taxonomies, and lexicons from primary/public sources.
- Use worldmonitor's actual code only via a **separate AGPL frontend** that calls
  this feeder **over HTTP/MCP**, in its **own repo and process**.
- If you operate such an AGPL frontend, **comply with §13** for *that* frontend
  (offer its Corresponding Source to remote users).
- Keep this repo's `LICENSE` (MIT) accurate by ensuring every file in the
  distributed tree is original or already-permissive.

**DON'T**

- **Don't** copy, paste, port line-by-line, or machine-translate any worldmonitor
  source into this repo. (§5 would relicense the **whole** feeder AGPL.)
- **Don't** copy worldmonitor **prompt text** or **curated data tables**
  (source lists, weighting/keyword tables) — these are protected expression even
  when individual entries are facts.
- **Don't** `import`/`require` or otherwise **in-process link** any AGPL module
  into the feeder or the `web/` console — a folder/subdir boundary is **not** a
  license boundary (§1 "Corresponding Source" reaches linked subprograms).
- **Don't** assume "we only run it as a server, never distribute it" avoids
  copyleft — **§13 triggers on network interaction**, which is the feeder's whole
  deployment model.
- **Don't** relabel copied AGPL code as MIT, or strip its notices — §5 forbids
  relicensing, and AGPL §10 forbids imposing "further restrictions."

## References

- `LICENSE` — this repo, **MIT** (`Copyright (c) 2026 Samaritan`).
- `../_worldmonitor_tmp/LICENSE` — **GNU AGPL-3.0** (`Copyright (C) 2024-2026 Elie
  Habib`); §0 (definitions: modify / covered work / convey), §1 (Corresponding
  Source / linked subprograms), §5 (Conveying Modified Source Versions — whole-work
  copyleft), §10 (no further restrictions), §13 (Remote Network Interaction).
- `../_worldmonitor_tmp/README.md` (License section) — states the source code is
  **"AGPL-3.0-only"** and offers separate commercial terms; confirms the upstream
  posture.
