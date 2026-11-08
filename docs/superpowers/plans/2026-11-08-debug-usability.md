# API Debug Usability Improvements

**Goal:** Improve existing single-field debugging without batch actions or new parameters.

**Approach:** Retain fixed script names, scope-aware reset panels, existing counter keys,
and legacy argument syntax. Develop in a temporary copy because the active local
test modules load the workspace script directly; sync only after verification.
Retain the current development version until a new release is prepared, leaving
the published v1.5.2 tag unchanged.

## Tasks

- [x] Add failing regressions for unapplied requests being delayed; delay only an applied operation.
- [x] Add read-only panel progress: positive used/remaining, negative skipped/active, unlimited untracked; display storage errors and preserve independent resets.
- [x] Improve outcome/reason logs and configuration examples, including filtered-item counts and absent headers.
- [x] Harden percent decoding with mixed literal percent signs, valid escapes, malformed UTF-8, embedded parameter-like strings, JSON and quoted filter paths; retain one-pass decoding.
- [x] Run the complete suite, coverage gate, native configuration checks and scoped native runtime checks.
- [x] Update README/HTML guide, inspect the final diff, and sync the verified implementation to the workspace.

## Compatibility constraints

Do not change counting limits, the explicit hit_limit=0 reset fallback, parameter
names, panel identity, or array/path behavior. Auto-refresh reads counters only.
Treat changed limits as a new sequence without mutating storage from the panel.
Do not hide corrupt or unavailable counters behind a fabricated zero progress.
No commit, tag, push or release is included in this task.

## Verification

Ten initial regressions failed against the baseline and passed after implementation;
one additional regression covers typed-value and version error classification.
The full suite passes 123 tests with zero skips, including Surge's native rendered
configuration check. V8 range coverage is 501/521 (96.2%), all 60 functions covered.
Surge's native runtime passed 17 checks using real persistent storage and isolated
`.invalid` patterns. Temporary keys were restored; no user counters were reset.

The validated implementation was synced to the workspace, with the script replaced
atomically after the tests. Existing local test modules can keep using their current
parameters and version guard. No published tag was changed.
