# Contributing to AdVeil

Thank you for considering a contribution. This document covers setup, testing expectations, and the pull request process.

## Getting started

1. Fork the repository and clone your fork.
2. Load the extension unpacked in Chrome or Firefox — see [`README.md`](README.md#installation).
3. Make your changes.
4. If you edited `rules/domains-source.txt`, regenerate the compiled ruleset:
   ```sh
   npm run build
   ```

No build tooling is required for the extension itself; all scripts run as-authored.

## Before submitting a pull request

- **Syntax-check every changed JavaScript file**: `node --check <file>`.
- **Validate JSON files** you touched, including `rules/generated/dnr-rules.json` if regenerated.
- **Run the manual fixture test**: open `test/overlay-test.html` and confirm the positive fixtures are hidden and the negative-control fixtures (login modal, cookie banner, paywall) remain visible.
- **Test against a real site** if you changed detection logic in `content-scripts/overlay-engine.js`, `cosmetic-filter.js`, or `popunder-guard.js`. Fixture pages do not reliably surface every failure mode — see `plan.md` for examples of bugs that only appeared under live testing. [canyoublockit.com/extreme-test](https://canyoublockit.com/extreme-test/) is a safe default target.
- **Update `plan.md`** if you change an architectural decision.

## Code conventions

- No build step or bundler for the extension source; content scripts are written as plain, unbundled JavaScript.
- `content-scripts/overlay-engine.js` and `content-scripts/cosmetic-filter.js` share a single JavaScript global scope at runtime. Every top-level `let`, `const`, and `function` declared in either file must have a name unique across both — a duplicate declaration throws a fatal error that silently disables the other script. Prefix new identifiers accordingly (`oabCosmetic*` in the cosmetic filter, `oab*` in the overlay engine).
- Keep the domain and selector lists in `rules/` curated and reviewed — do not bulk-import third-party filter lists without discussion, per the project's intentionally scoped-down approach (see `plan.md`).
- Match the comment density and style of the surrounding code.

## Reporting bugs

Open an issue using the bug report template. Include the site URL (if applicable), browser and version, and steps to reproduce. For security-sensitive reports, see [`SECURITY.md`](SECURITY.md) instead of filing a public issue.

## Proposing features

Open an issue using the feature request template before submitting a large pull request, to confirm the change fits the project's scope.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
