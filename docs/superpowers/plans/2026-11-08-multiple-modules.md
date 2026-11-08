# Multiple API Debug Modules Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks in this session.

**Goal:** Support independently counted modifications of different interfaces using multiple installations of one Module.

**Architecture:** Keep the existing parameters and shared JS. Isolate Module storage by exact URL pattern and direction, and include that scope in reset-panel feedback. Keep direct-call storage behavior unchanged.

**Tech Stack:** JavaScript, Node.js built-in test/VM/inspector APIs, Surge Module syntax.

**Spec:** ../specs/2026-11-08-multiple-modules-design.md

## Global Constraints

- No new Module parameter, external dependency, private configuration or historical source copy.
- Paired Module/JS version 1.5.0 with version-pinned public script URLs; do not change a published tag or asset.
- Keep the contiguous argument metadata block and existing value parsing.
- No commit, push or deployment requested for this implementation.

## Review Focus

- Interleaved A/B hits must not start fresh sequences for the other rule.
- Resetting A, including unlimited-mode clearing, must leave B and the other direction untouched.
- Regex delimiters, literal percent escapes and Unicode must not alias another rule's storage.
- Changing a pattern back must resume its counter; changing its limit must not change another pattern's counter.
- Same-name panels require a real Surge check in addition to VM tests and offline syntax checks.

### Task 1: Rule-scoped counters and panel feedback

**Files:** surge_api_debug.js, tests/surge_api_debug.test.js

**Interfaces:** `hitCounterKey(direction)` chooses URL-scoped storage for Module arguments and retains direct-call fallback. `handleResetPanel()` returns the existing title and scoped content.

- [x] Add tests for A/B interleaving, positive/negative/zero limits, manual reset isolation, automatic refresh, shared-regex counts, delimiter/Unicode patterns, same-pattern sharing, direction separation and old-state isolation. Update the old switch-back expectation to resume rather than reset.
- [x] Run the selected tests against 1.4.2 and record the expected failures before implementation.
- [x] Use an encoded exact pattern in a new Module storage namespace. Show pattern and direction in panel content without changing manual-reset guards.
- [x] Run the full suite and coverage gate.

### Task 2: Paired metadata, documentation and integration validation

**Files:** surge_api_debug.sgmodule, surge_api_debug.js, tests/surge_api_debug.test.js, tests/surge_module_native.test.js, README.md

**Interfaces:** Both script entry points continue passing `url_pattern` and direction to the same versioned JS; editable parameters stay unchanged.

- [x] Advance paired source/test versions to 1.5.0 and update Module description.
- [x] Document installation using `?name=login` / `?name=messages`, exact-pattern sharing, scope-preserving resets and same-interface limitations. Preserve a pinned 1.4.2 install option.
- [x] Validate the rendered Module using Surge CLI; investigate installed-instance script/panel resolution without changing user traffic configuration.
- [x] Run full tests, coverage, local Markdown-link checks and diff checks; perform final review and state any live-app verification gap.

## Execution record

- Initial state: clean public checkout on main; 1.4.2's global per-direction Module slot reproduces the design problem in source. Surge offline checker accepts duplicate script/panel names.
- Task 1 RED: selected regression run failed 9/10 cases on the old implementation. GREEN: 98/98 tests passed after scope isolation and feedback changes (includes coverage runner).
- Native evidence: user's screenshot shows both reset panels; read-only Surge script listing confirms two HTTP scripts and two generic reset scripts, each carrying its own pattern.
- Additional RED→GREEN: the native checker rejected an unquoted pattern containing `{1,3}`. Added `tests/surge_module_native.test.js`; quoted the Module pattern, and the same native regression now passes. This is required to retain comma-bearing regex support through real Module loading, not just VM argument parsing.
- Native execution: the new JS passed 15 checks in Surge's own runtime with its real persistent store, exercising interleaving, manual/automatic reset, request/response separation, negative limits and unlimited clearing. The test used unique `.invalid` patterns and restored all touched storage slots.
- Review: an independent reviewer found no proven new production defect. Remaining integration boundary is live panel-to-script lookup between installed instances; VM calls and CLI script evaluation inject the intended arguments and do not prove button routing. Computer Use could not start, so no live panel-click claim is made.
- Final validation: 99/99 tests pass with zero skips on this Mac, including the native rendered-configuration test. V8 range coverage is 462/477 (96.9%); functions 55/55. README relative links, public-domain scan and `git diff --check` pass. The new version has not been committed, pushed, tagged or released.
