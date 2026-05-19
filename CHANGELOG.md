# Changelog

This project follows [semver](https://semver.org/) once it reaches 1.0.
Until then, breaking changes can land in any minor version.

## Unreleased

- Hunt-r3 saturation across 7 categories (spec drift, resource hygiene,
  shutdown/signal, delivery correctness, watcher symmetry, input
  validation, identity uniqueness + per-resource mutex).
- Extracted reusable primitives: `src/watcher.ts` (uniform inotify +
  prescan + sweep + respawn), `src/mutex.ts` (keyed mutex), and
  `src/constants.ts` (shared thresholds).
- Toolchain modernized: biome 2.4.15, TypeScript 6.0.3,
  simple-git-hooks 2.13.1. Pre-commit hook runs lint + `tsc --noEmit` +
  tests.
- Relative imports purged via `package.json` `imports` field
  (`#choros/*`).
- README + LICENSE + .editorconfig + .gitignore + CHANGELOG added.

## 0.28 and earlier

See git log; pre-changelog history is captured in commit messages.
