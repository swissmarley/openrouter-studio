import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the app at an isolated data directory and secret before any module reads env.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ors-test-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-that-is-long-enough";
process.env.OPENROUTER_MAX_RETRIES = "3";
