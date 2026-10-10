# Humanity

> **Written by AI** (as **澄** / Cheng) — code, tests and docs were produced by an AI assistant; requirements, decisions and acceptance belong to the repository owner.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2%20%7C%200.2.0--rc.2-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

English | [简体中文](README.md)

**Humanity** is a personification suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
persona, memory, skills, self-evolution and dreaming, all behind one native Web workbench.
It ships as a single installable bundle whose modules stay independent and individually switchable.

The problem it solves is plain: **let your agent remember things and have a character of its own —
in a place you can see, edit and undo.**

## Features

| Module | What you get |
|---|---|
| **Persona** | Identity card + persona card. Native sections are locked (the plugin keys off them); everything else is yours: add, rename, delete. Names are fixed text, content is a plain editable field. Changes take effect **immediately** (hot reload) and history is kept for rollback |
| **Memory** | Three scopes (long-term / workspace / session), automatic capture, seven-signal relevance retrieval. Low-risk content is stored automatically; high-risk content only becomes a **proposal you approve**. Entries can be re-scoped, deduplicated, archived and restored — it never grows without bound, and it is **never auto-deleted** |
| **Skills** | Skills distilled by self-evolution land in the official user skills directory; create, edit, disable and restore them from the workbench. Tool dependencies are reported **by plugin name**, not as a vague warning |
| **Self-evolution & dreaming** | Scheduled passes over new sessions → model analysis → memories and proposals, fully metered with a daily cap. "Dreaming" renders each pass as a readable run timeline |

Plus: one master switch and four module switches (effective immediately), registered in DSH's own
settings service — search for `Humanity` there.

## Requirements

- [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.5-rc.2`…0.1.x, or `0.2.0-rc.2`…0.2.x (see Compatibility)
- Node **>= 22**
- [pnpm](https://pnpm.io/) when installing from source

## Install

### From GitHub

```bash
dsh plugin --profile web add github:Thr33H/Deepseek-Harness-Humanity
docker restart <your-container>        # or restart your own dsh process
```

The Git install runs the `prepare` build once to produce `lib/`. If pnpm reports ignored build
scripts (pnpm 11 gates these), click "allow these scripts and retry" on the DSH plugin page, or put
this in that profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
```

### From npm

> ⚠️ Check that a version exists first: `npm view deepseek-harness-humanity version`.
> If that returns nothing (not published yet), use the GitHub route above.

```bash
dsh plugin --profile web add deepseek-harness-humanity
docker restart <your-container>
```

`dsh plugin add` appends the package to the profile's `dsh.profile.bundles` automatically
(the package declares `dsh.bundle`), so no config file needs editing by hand.

### From a local checkout

```bash
git clone https://github.com/Thr33H/Deepseek-Harness-Humanity.git
cd Deepseek-Harness-Humanity
pnpm install
dsh plugin --profile humanity-dev add "$PWD"
dsh --profile humanity-dev --port 3099 --no-open   # verify in an isolated profile first
```

After installing, a `Humanity` entry appears in the sidebar (with a red dot when something needs your
approval); switches live in DSH settings under `Humanity`.

### Update / uninstall

```bash
dsh plugin --profile web update deepseek-harness-humanity
dsh plugin --profile web remove deepseek-harness-humanity
```

Plugin data (`$DSH_HOME/storages/humanity.json`, `$DSH_HOME/skills/`) is **independent data**:
uninstalling the plugin does not delete it.

## Where data lives

| Content | Location |
|---|---|
| Persona, memories, proposals, run records | `$DSH_HOME/storages/humanity.json` (versioned storage domain `humanity`) |
| Persona history (superseded / deleted entries) | `persona_history` table, with a **retention window** (30 days by default, or forever) |
| Module switches, memory mode, schedule and budget | `$DSH_HOME/settings.yaml`, `humanity` section |
| Skill files | `$DSH_HOME/skills/` |

Everything stays inside `$DSH_HOME` and migrates with DSH. The plugin writes nowhere else.

## It spends your own money (self-evolution)

Self-evolution calls the model on a schedule to distill sessions (default `idle`: 30 minutes without
an active conversation; it is **not** manual-only).

- Budgets: sessions per run, events per session, input bytes, output tokens and a **daily call cap** are
  all editable in the workbench. Over budget means a warning and a stop — never a silent spend.
- Spend is itemised on the self-evolution page.
- **Persona injection and memory retrieval make no model calls**; memory decay accounting is local computation.

## Compatibility

The machine-readable criterion is this package's `peerDependencies`: `^0.1.5-rc.2 || ^0.2.0-rc.2`
(six official seams). A DSH outside that range **refuses to mount the whole bundle at startup**
(persona disappears from the prompt, the workbench page and the `remember`/`recall` tools vanish —
**no data is harmed**).

Known gaps: `0.1.7-rc.*`, `0.1.6-rc.*`, `0.2.1-rc.*` are **not** covered, because semver's
pre-release "same segment" rule pins the range's pre-releases to `0.1.5` / `0.2.0`. Add that
pre-release segment explicitly if you need them.

## Development

```bash
pnpm install
pnpm typecheck   # host + client
pnpm build       # lib/index.js (host, ESM) and lib/client.js (client, single-file CJS bundle)
pnpm test        # build, then run all tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, and [docs/](docs/) for architecture notes.

## Documentation

| Document | Content |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Using personas, the memory tiers, skill persistence, every self-evolution switch |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module boundaries, the compatibility gate, and why they are cut this way |
| [CHANGELOG.md](CHANGELOG.md) | Release history, including the symptom behind each fix |

## License

[MIT](LICENSE) © 2026 Thr33H

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — this plugin only uses its public seams
- Character-card and memory-format design draws on community practice (Character Card V2/V3, SillyTavern World Info)
