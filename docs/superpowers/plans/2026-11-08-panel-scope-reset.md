# Panel Scope Reset Fix

## Design

Keep fixed HTTP and generic script names. Render each quoted panel key as
`API-Debug-Reset|direction|hit_limit|url_pattern` using the existing Module parameters.
On invocation the reset script recovers its scope from `$input.panelName`, so
Surge selecting another same-named generic script cannot redirect the reset.
The URL is the entire remaining suffix, including any literal pipes. Counters
retain the existing exact URL-pattern/direction key and survive the upgrade.
Legacy unscoped panel calls retain argument-based compatibility. Malformed scoped
identifiers must never fall back to another module's arguments.

Display configured `hit_limit` in the title, its meaning in the body, and preserve
both interface and direction feedback. No registry, extra parameter, or
user-assigned name is needed. Paired source version: 1.5.2.

## Evidence and validation

- Live read-only inspection found two enabled HTTP scripts with different URL
  patterns and two generic scripts named `API-Debug-Reset`; effective profile had
  two panels sharing both their key and script-name.
- A temporary panel-only module confirmed Surge's effective profile preserves
  a quoted panel key containing a comma quantifier, query equals, and ampersand.
  No counters were touched. The probe was disabled after inspection.
- Four regression tests failed before the fix: panel identity, cross-direction
  identity, hit-limit display, and rejecting incomplete scoped resets.
- Tests deliberately invoke panel B with script A's arguments, assert B's
  content/logs, and prove only B's exhausted counter is cleared.
- Native rendered-configuration check remains part of the full suite. Offline
  checks and injected script evaluation do not establish real UI button routing.
- Final suite: 112 tests pass, V8 range coverage 481/500 (96.2%). Surge's native
  runtime passed six additional scope/reset checks using real persistent storage
  and unique `.invalid` test URLs; all temporary storage entries were restored.

## Delivery boundary

Local A/B test modules were installed with the user's existing configurations
and direct references to the local 1.5.2 JavaScript. The old remote modules were
disabled and retained, and the original configuration was backed up. The user
confirmed the local test worked, including distinct panels and reset behavior.
The temporary installation server was stopped; the local script paths remain
usable. This establishes local application validation, not release publication.

After release, reimport or update both remote modules together to replace old
panel declarations and use the paired versioned JavaScript. The release workflow
and public installation URLs still need online verification after pushing.
