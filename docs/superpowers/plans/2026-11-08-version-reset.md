# Restart Public Versioning at 1.0.0

The user requested removing every existing tag and starting at 1.0.0, and
explicitly confirmed removing old GitHub Releases as well. At the time of the
reset, the Releases collection was already empty. Four tags existed locally
and remotely: v1.4.2, v1.5.0, v1.5.1 and v1.5.2. Their exact refs and reachable
history were backed up in a verified Git bundle outside the repository before
deletion. Repository commit history and existing counter keys are retained.

The new 1.0.0 baseline includes the current single-field features and usability
improvements: scope-aware panels, read-only progress, applied-only delay,
outcome/reason logs and mixed percent decoding. Batch actions are not included.
Module/JS/test versions and public installation documentation are synchronized;
old release installation links and feature-version prerequisites are removed.
Historical implementation notes remain as records of the development process.

The release workflow skips deleted-tag push events so cleanup cannot recreate
old tags. Push the updated workflow to main before deleting remote tags. Then
delete old local tags, create/push v1.0.0, follow the Actions run, and verify
the Release asset and both fixed/latest installation URLs against the source.
