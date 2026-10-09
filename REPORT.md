# Independent Code Review Report

## A. `services/memory/privacy_epoch.py` + `tests/memory_privacy_epoch_test.py` (PE-F002)
* **File:** `services/memory/privacy_epoch.py`
  * **Line 226-234:** The 5-retry loop for `os.open` in `_locked` properly catches `FileNotFoundError` during `O_CREAT` (which can happen under concurrent file creation on macOS APFS) and has bounded exponential backoff (`0.005 * (attempt + 1)`). It raises the exception if the file isn't created by the 5th attempt, so it does not cause infinite waiting.
  * **Line 248:** The lock inode validation (`if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):`) correctly prevents operating on a stale lock file that was replaced.
  * **Line 87-124 (`is_user_established`):** Correctly checks both the marker and epoch file paths. It returns `True` and fails closed on unreadable/damaged directory.
  * **Line 126-173 (`get_epoch`):** If the marker exists but the epoch file does not, or the directory is unreadable, it fails closed to `EPOCH_UNKNOWN`.
  * **Line 164 (`_parse(raw, user_id)`):** Properly extracts the epoch; failures are caught and result in `EPOCH_UNKNOWN`.
* **File:** `tests/memory_privacy_epoch_test.py`
  * Covers fail-closed semantics for marker established users (lines 717-768). Tests verify missing file, missing directory, corrupt file, and permission denial all result in `EPOCH_UNKNOWN`.
  * The `concurrent_reset` test reproduces the lock and prevents race conditions correctly.
* **Conclusion for Section A:** **pass**. no findings.

## B. `services/memory/service.py` + `services/memory/migration.py` + `tests/memory_epoch_binding_test.py` (PE-F003)
* **File:** `services/memory/service.py`
  * **Line 624:** The plan binds `privacy_epoch = privacy_before` before `self._save_plan()` and before the vector effect.
  * **Line 606-612:** On retry, if `plan.get("privacy_epoch")` does not match `privacy_before`, it halts execution and routes to `needs_review` with `privacy_epoch_changed`.
  * **Line 649-652:** A second check before vector effect happens, ensuring the privacy epoch is still known.
  * **Line 723 & 737:** `_trusted_receipts` requires `privacy_epoch EQUALS current_epoch`. Older eras are correctly filtered out.
  * **Bypass checks:** `no_facts` and `assistant_archived` status branches (Lines 633-639) save the plan and finish without vector effects, which is correct. The `search` conflict path (Line 901) safely returns conflict metadata. End of search checks `privacy_before == privacy_after` (Line 913-916).
* **File:** `tests/memory_epoch_binding_test.py`
  * Fully covers `prior_era_facts_are_unrecallable_after_reset`, persisted plans, store settlement, and metadata.
* **Conclusion for Section B:** **pass**. no findings.

## C. AUI-03 Same-origin read proxy
* **File:** `vendor/cezar/packages/cezar/src/server/personal-ai-os.ts`
  * **Line 92-94 (`proxyEnvelope`):** The upstream returns a response, and `body = await response.json().catch(() => null)`. Then it returns `{ available: true, upstreamStatus: response.status, body }`.
  * **Line 104 & 111:** Validates `section` enum and `taskId` with single safe path segment regex (`/^[A-Za-z0-9_-]{1,200}$/`).
  * Token is only sourced from `authorityPath` and added to `headers.Authorization`. It is never returned in the envelope.
* **File:** `vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx`
  * **Line 11-19 (`readTasks`):** The proxy returns `HTTP 200` with the envelope `{ available: true, upstreamStatus: 500, body: null }`. However, `readTasks` only checks `!response.ok` (which will be false since it's 200) and `envelope.available !== true` (which is false, since available is `true`). It **fails to throw** an error when `upstreamStatus >= 400`, returning an empty body `{}` instead. This hides upstream failures, violating the honest retry state requirement.
  * **Evidence:** `control-plane-tasks.tsx:18`. **Severity:** major.
* **File:** `vendor/cezar/packages/web/src/routes/dashboard/control-plane-approvals.tsx`
  * The frontend is bypassing the proxy entirely and attempting to fetch directly from `127.0.0.1:4324`. While this violates AUI-03, `docs/handoffs/aui03-same-origin-proxy-r1.md` explicitly notes that `approvals 写面` and other components are intentionally left as direct connections for now ("明确未做（后续片）"). Therefore, this is not a blocker but a known constraint of the current slice.
* **Conclusion for Section C:** **needs-changes**. The frontend has critical issues: swallowing HTTP errors in tasks.

## D. Testing Coverage & Claims
* The Python memory tests effectively cover the fail-closed semantics, missing markers, and bounded O_CREAT retry.
* The TypeScript frontend tests mock `fetch` to simulate both AUI-03 routing and 5xx errors. The test `shows an unreachable notice with a retry and never fabricates executions when the detail fails` passes, but it mocks `planStatus: 500` and `dStatus: 500`, testing `control-plane-executions.tsx` (which *does* check `upstreamStatus >= 400`). However, there is a missing negative test for `readTasks` (in `control-plane-tasks.tsx`) failing with `upstreamStatus >= 400`.
* **Conclusion for Section D:** **needs-changes**. The tests fail to catch the swallowed error in `readTasks`.

## PR Review Comments
* **vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx:14**
  * *Comment:* `readTasks` doesn't check `envelope.upstreamStatus >= 400`. Because the proxy returns HTTP 200 on its own envelope, `response.ok` is always true. When the upstream fails (e.g. 500), it will silently swallow the error and return an empty body `{}`, hiding the honest degradation state. Please add `if (typeof envelope.upstreamStatus === 'number' && envelope.upstreamStatus >= 400) throw new Error(...)` as you did in `control-plane-executions.tsx`.
