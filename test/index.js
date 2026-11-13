/**
 * `node --test test/` entry point.
 *
 * Node 24 does not search a directory passed as a positional argument: it
 * resolves the path as a module (see the local run of `node --test test/`,
 * which loads `test/index.js`). This file exists only so the documented
 * acceptance command works; it adds no tests of its own.
 *
 * `test/real-codex.mjs` is deliberately not imported: it runs the real
 * `codex-dev` and costs a model call, so it is opt-in via
 * `node test/real-codex.mjs`.
 */
import './tool.test.js';
import './codex-dev.test.js';
import './cleanup.test.js';
