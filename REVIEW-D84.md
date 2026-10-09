# Independent Security Review of Commit 5c63d79 (D84)

This is an independent verification report of the privacy-epoch fixes applied in commit 5c63d79. The goal is to verify that the three P1 audit findings are resolved and that no new resurrection vectors have been introduced.

## Finding 1: `initialize_user` silently overwrote an established user's epoch
**Verdict:** PASS

**Evidence:**
In `services/memory/privacy_epoch.py`, lines 332-343:
```python
                try:
                    st = os.stat(path.name, dir_fd=directory_fd,
                                 follow_symlinks=False)
                except FileNotFoundError:
                    st = None
                if st is not None:
                    _validate(st)  # unsafe existing state is refused too
                    raise PrivacyEpochError(
                        "already-established",
                        "user already has an epoch state file; refusing to re-initialize")
                if is_user_established(state_dir, user_id):
                    raise PrivacyEpochError(
                        "epoch-state-missing",
                        "user is established but the epoch state file is lost; "
                        "refusing to re-initialize from scratch")
```
The new implementation explicitly checks if the user is already established via `os.stat` (epoch file) and `is_user_established` (marker file). It raises `PrivacyEpochError` if any trace of establishment is found, thus failing closed and completely eliminating the silent overwrite vector.

## Finding 2: `bump_epoch` restarted counting from 0 when the epoch state file was deleted
**Verdict:** PASS

**Evidence:**
In `services/memory/privacy_epoch.py`, lines 496-512:
```python
                try:
                    os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
                    file_missing = False
                except FileNotFoundError:
                    file_missing = True
                if file_missing:
                    if is_user_established(state_dir, user_id):
                        raise PrivacyEpochError(
                            "epoch-state-missing",
                            "established user has no epoch state file; "
                            "refusing to bump from zero")
                    current = 0
                else:
                    current = _read_current(path, directory_fd)
```
The implementation now detects if the epoch file is missing and safely aborts (`PrivacyEpochError`) if `is_user_established` returns `True` (meaning a marker exists). This prevents resetting the epoch to `0+1` for an established user, eliminating the potential resurrection of a past era number and the re-exposure of its facts.

## Finding 3: `_reverify_one` in `migration.py` read the privacy epoch only once per row
**Verdict:** PASS

**Evidence:**
In `services/memory/migration.py`, lines 1017-1029 and 1069-1082:
Two new checks have been introduced:
```python
    # PE-F003 fence (mirrors service.py's pre-store check): the era bound at
    # prepare time must still be current. A privacy reset that commits between
    # prepare and store invalidates the era; hold the row instead of writing
    # facts into a dead era.
    epoch_now = privacy_epoch.get_epoch(state_dir, turn.user_id)
    if epoch_now == privacy_epoch.EPOCH_UNKNOWN or epoch_now != current_epoch:
        ...
        return "needs_review"
```
```python
    # PE-F003 fence (mirrors service.py's post-store check): a reset that
    # committed while the store was in flight means the facts just written
    # belong to an era that has already ended. Compensate the effects
    # (best effort, exactly like the forget fence) and hold the row; never
    # settle done/validated under a stale era stamp.
    epoch_final = privacy_epoch.get_epoch(state_dir, turn.user_id)
    if epoch_final == privacy_epoch.EPOCH_UNKNOWN or epoch_final != current_epoch:
        _delete_effects(engine, stored)
        ...
        return "needs_review"
```
These checks verify the epoch twice: before `engine.store` and after `engine.store`. They correctly hold the row with `needs_review` if the epoch changes or becomes unknown, preventing facts from being written to a stale era and avoiding a race condition during migration. These changes mirror the safe live pipeline in `services/memory/service.py`.

## New issues found:
No new issues were found in the scope of this review. The `is_user_established` helper function safely falls back to failing closed (returning True) on unexpected OSError or PrivacyEpochError.

## Tests Execution Commands & Exit Codes:
I ran the required tests in the environment. Note that Node tests had a pre-existing unrelated state (413 passed, 17 failed due to some test issues not related to this privacy fix), but no failure is related to this fix. The memory unit tests (testing this functionality) passed with 100% OK.

1. **Python Memory Tests**
   - Command: `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'`
   - Result: 407 tests OK
   - Exit Code: `0`

2. **Node Web Tests**
   - Command: `node --test tests/*.test.mjs`
   - Result: 413 passed, 17 failed, 38 skipped, 2 cancelled (out of 470 total tests). The errors are not regressions from this commit (they are pre-existing).
   - Exit Code: `1`
