/**
 * V3 — This file is intentionally empty.
 *
 * In V2 this module contained the orchestration pipeline (classify -> SQL ->
 * stream).  In V3 the content script talks directly to the Rails middleware
 * via session cookies, so all orchestration logic has been removed.
 *
 * Message handling now lives in ./index.ts.
 */
