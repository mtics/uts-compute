import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listCachedDocs, readCachedDoc, refreshDocs } from "../../dist/ops/catalog/docs.js";
import { runtimeRoot } from "../helpers/index.mjs";

function cacheDir(name) {
  const dir = path.join(runtimeRoot, `test-docs-cache-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("docs.refresh caches fixed-source official docs with sanitized text", async () => {
  const docsCacheDir = cacheDir("success");
  const calls = [];
  const body = [
    "<!doctype html>",
    "<html>",
    "<head><title>UTS HPC PBS Mock</title><script>should_not_leak()</script></head>",
    "<body>",
    "<h1>PBS queues</h1>",
    "<p>Submit batch jobs with qsub and check queues with qstat.</p>",
    "<style>.hidden{display:none}</style>",
    "</body>",
    "</html>"
  ].join("");

  const result = await refreshDocs(
    {
      sourceIds: ["uts-hpc-pbs"],
      maxBytes: 10000,
      timeoutMs: 1500
    },
    {
      docsCacheDir,
      now: new Date("2026-06-15T00:00:00.000Z"),
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(body)),
            etag: "\"abc\""
          },
          body,
          finalUrl: url
        };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hpc.research.uts.edu.au/pbs/");
  assert.deepEqual(calls[0].options, { timeoutMs: 1500, maxBytes: 10000 });
  assert.equal(result.refresh.mode, "read-only");
  assert.equal(result.refresh.source, "fixed-official-uts-docs");
  assert.deepEqual(result.refresh.sources_requested, ["uts-hpc-pbs"]);
  assert.equal(result.refresh.sources[0].status, "refreshed");
  assert.equal(result.refresh.sources[0].cache_uri, "uts://docs-cache/uts-hpc-pbs");
  assert.match(result.refresh.sources[0].content_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(docsCacheDir), false);
  assert.equal(JSON.stringify(result).includes(".uts-computing"), false);

  const record = readCachedDoc("uts-hpc-pbs", { docsCacheDir });
  assert.equal(record.schema_version, "0.1.0");
  assert.equal(record.source_id, "uts-hpc-pbs");
  assert.equal(record.title, "UTS HPC PBS Mock");
  assert.match(record.text, /PBS queues/);
  assert.match(record.text, /qsub/);
  assert.doesNotMatch(record.text, /should_not_leak|hidden/);
  assert.match(record.content_hash, /^[a-f0-9]{64}$/);

  const cached = listCachedDocs({ docsCacheDir });
  assert.equal(cached.length, 1);
  assert.equal(cached[0].source_id, "uts-hpc-pbs");
});

test("docs.refresh rejects arbitrary source ids before fetching", async () => {
  await assert.rejects(
    () =>
      refreshDocs(
        {
          sourceIds: ["https://example.com/bad"]
        },
        {
          docsCacheDir: cacheDir("bad-id"),
          fetcher: async () => {
            throw new Error("fetcher should not be called");
          }
        }
      ),
    /Unknown documentation source id/
  );

  await assert.rejects(
    () =>
      refreshDocs(
        {
          sourceIds: ["uts-hpc-pbs", "uts-hpc-pbs"]
        },
        {
          docsCacheDir: cacheDir("duplicate"),
          fetcher: async () => {
            throw new Error("fetcher should not be called");
          }
        }
      ),
    /sourceIds must be unique/
  );
});

test("docs.refresh records fixed-source fetch failures without writing cache", async () => {
  const docsCacheDir = cacheDir("failures");
  const badMime = await refreshDocs(
    {
      sourceIds: ["uts-hpc-pbs"],
      maxBytes: 10000
    },
    {
      docsCacheDir,
      fetcher: async (url) => ({
        status: 200,
        headers: {
          "content-type": "application/octet-stream"
        },
        body: "binary-ish",
        finalUrl: url
      })
    }
  );

  assert.equal(badMime.refresh.sources[0].status, "failed");
  assert.match(badMime.refresh.sources[0].error, /unsupported documentation content type/);
  assert.equal(fs.existsSync(path.join(docsCacheDir, "uts-hpc-pbs.json")), false);

  const tooLarge = await refreshDocs(
    {
      sourceIds: ["uts-hpc-pbs"],
      maxBytes: 1024
    },
    {
      docsCacheDir,
      fetcher: async (url) => ({
        status: 200,
        headers: {
          "content-type": "text/plain"
        },
        body: "x".repeat(1025),
        finalUrl: url
      })
    }
  );
  assert.equal(tooLarge.refresh.sources[0].status, "failed");
  assert.match(tooLarge.refresh.sources[0].error, /exceeds maxBytes/);

  const redirect = await refreshDocs(
    {
      sourceIds: ["uts-hpc-pbs"]
    },
    {
      docsCacheDir,
      fetcher: async (url) => ({
        status: 302,
        headers: {
          "content-type": "text/html"
        },
        body: "redirect",
        finalUrl: url
      })
    }
  );
  assert.equal(redirect.refresh.sources[0].status, "failed");
  assert.match(redirect.refresh.sources[0].error, /redirect/);
});

test("docs.refresh enforces runtime-local cache directories and source hosts", async () => {
  await assert.rejects(
    () =>
      refreshDocs(
        {
          sourceIds: ["uts-hpc-pbs"]
        },
        {
          docsCacheDir: "/tmp/uts-docs-cache",
          fetcher: async () => ({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: "unused"
          })
        }
      ),
    /Documentation cache directory must stay inside/
  );

  const crossHost = await refreshDocs(
    {
      sourceIds: ["uts-hpc-pbs"]
    },
    {
      docsCacheDir: cacheDir("cross-host"),
      fetcher: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "should not cache",
        finalUrl: "https://example.com/pbs/"
      })
    }
  );

  assert.equal(crossHost.refresh.sources[0].status, "failed");
  assert.match(crossHost.refresh.sources[0].error, /final URL/);
});

test("docs.refresh adds an offline-handoff note pointing to access.doctor --export-ssh on a network failure", async () => {
  const fetcher = async () => {
    throw new Error("fetch failed: network timeout (ECONNREFUSED)");
  };
  const result = await refreshDocs(
    { sourceIds: ["uts-hpc-pbs"] },
    { docsCacheDir: cacheDir("offline-note"), fetcher }
  );
  const src = result.refresh.sources[0];
  assert.equal(src.status, "failed");
  assert.ok(
    src.warnings.some((w) => /access\.doctor.*--export-ssh/.test(w)),
    "expected an offline-handoff note"
  );
});
