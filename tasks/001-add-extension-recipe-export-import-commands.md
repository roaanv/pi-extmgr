---
title: "Add extension recipe export/import commands"
id: "001"
status: completed
priority: high
type: feature
tags: ["extmgr", "import-export"]
created_at: "2026-05-16"
completed_at: 2026-05-16
---

# Add extension recipe export/import commands

## Objective

Add interactive `/extensions export` and `/extensions import` slash-command flows that persist install instructions for selected installed extensions, not extension payloads.

## Tasks

- [ ] Inspect existing package catalog/install/list behavior and required TUI primitives.
- [ ] Add JSON export/import recipe types and helpers.
- [ ] Implement interactive export selection and default `pi-extensions-export.json` output.
- [ ] Implement interactive import selection, local-source warnings, preserved scope installs, and installed-conflict prompts.
- [ ] Wire slash-command registry/autocomplete/help.
- [ ] Add/adjust tests and run verification.

## Acceptance Criteria

- `/extensions export [file]` requires interactive TUI, lists global/project installed packages with scope indicators, lets the user select entries, and writes schema-versioned JSON.
- `/extensions import [file]` requires interactive TUI, reads JSON, lets the user select entries, preserves scope, warns about local sources, and prompts when selected entries are already installed.
- Export file defaults to `pi-extensions-export.json` in `ctx.cwd`.
- JSON includes source, scope, kind, and `localSourceRequired` for local-path installs.
- Existing commands remain compatible and tests/typecheck pass.
