# Changelog

All notable changes to the Home dashboard plugin.

## Versioning convention

Small releases, shipped often:

- **Patch** (`1.3.x`) — bug fixes, polish, tweaks to existing widgets,
  micro-features. The default bump for day-to-day work.
- **Minor** (`1.4.0`) — a batch of new widgets, or a feature that changes
  how the Home itself works.
- **Major** (`2.0.0`) — redesigns or breaking changes to the persisted
  layout schema.

Every release updates the version in `package.json`, `plugin.yaml` and
`dashboard/manifest.json`, rebuilds both bundles (`npm run build`), and
commits the regenerated `dashboard/dist/` + `desktop/plugin.js` (installs
clone, they never build).

---

## 1.3.0 — 2026-08-03

- **Host: live graphs view.** Third view in the hover cycle
  (meters → detail → graphs): four sparklines — cpu, ram, load, proc —
  over a rolling one-minute window sampled every 2s. Tokens-style area
  gradient; percent signals pin to 0–100, load/proc autoscale to the
  window peak; missing sources draw as gaps, never zeros.
- Pure series logic extracted to `hostSeries.ts` with `node:test`
  coverage (21 tests). Legacy persisted view values coerce safely.
- `layout.json` (per-install user state) is now gitignored.

## 1.2.1 and earlier

Pre-changelog era: initial grid + 16 widgets, Tokens/Logs redesign,
native Desktop runtime plugin and installer, caduceus refinements.
See `git log` for details.
