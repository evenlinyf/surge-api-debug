# Automated Release Implementation Plan

**Goal:** One Actions run validates and publishes the paired Module/JS version.

**Approach:** A manual `workflow_dispatch` derives the stable tag from the source; a version-tag push also triggers publication. Ordinary commits do not publish. Use the GitHub CLI and built-in token, with write access confined to the publishing job. The JS remains available through the release tag; the Module is a Release asset.

**Constraints:** Validate versions and both pinned script URLs before publishing. Test and publish the same commit. Reject mismatching existing tags and never replace a published release. GitHub-hosted Linux does not have the proprietary Surge CLI, so native syntax validation remains a local check.

## Implementation

- [x] Add failing tests for source/Module/tag version mismatches and incorrect pinned script URLs.
- [x] Implement `scripts/check-release.js`, returning the validated tag for Actions and local use.
- [x] Add `.github/workflows/release.yml`: read-only validation/tests/coverage, then tag/Release creation with the Module attachment.
- [x] Document the manual publishing button, tag trigger, permissions, and local checks in README.
- [x] Run the full suite, coverage, release validation, workflow syntax checks, and inspect the final diff.

## Validation boundary

Local verification does not establish a successful GitHub Actions run or an online release. The workflow must reach the default branch before the manual button is available. Pushing, dispatching and publishing are separate from this local implementation.
