import assert from "node:assert/strict";
import test from "node:test";
import { redactCommand } from "../../dist/core/audit.js";

test("redactCommand redacts common token, bearer, cloud key, and private key spellings", () => {
  const raw = [
    "python train.py",
    "password=hunter2",
    "access_token=tok_live_123",
    "refresh-token=refresh_live_123",
    "client_secret=client-secret-value",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
    "private_key=/Users/example/.ssh/id_rsa",
    "--api-key sk-test",
    "--secret-access-key cloud-secret",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "curl https://user:pass@example.test/path"
  ].join(" ");

  const redacted = redactCommand(raw);

  assert.doesNotMatch(redacted, /hunter2|tok_live|refresh_live|client-secret-value/);
  assert.doesNotMatch(redacted, /wJalrXUtn|id_rsa|sk-test|cloud-secret|eyJhbGci|:pass@/);
  assert.match(redacted, /password=<redacted>/);
  assert.match(redacted, /Authorization: Bearer <redacted>/);
  assert.match(redacted, /https:\/\/user:<redacted>@example\.test\/path/);
});

test("redactCommand redacts JSON values, PEM blocks, bare tokens, and base64 blobs without a key", () => {
  // (a) bare high-entropy token as a positional arg (no key, no separators)
  const bare = redactCommand("deploy Xk9aB2mQ7pL4vR8wZ3nT6yU1cD5eF0 --now");
  assert.doesNotMatch(bare, /Xk9aB2mQ7pL4vR8wZ3nT6yU1cD5eF0/);
  assert.match(bare, /deploy <redacted> --now/);

  // (b) secret inside a JSON-style "key": "value"
  const json = redactCommand('curl -d {"api_key": "skLiVeAb12Cd34Ef56Gh78ZZ"} host');
  assert.doesNotMatch(json, /skLiVeAb12Cd34Ef56Gh78ZZ/);
  assert.match(json, /"api_key":\s*"<redacted>"/);

  // (c) multiline PEM private-key block
  const pem = redactCommand(
    [
      "ssh-add - <<EOF",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "U2VjcmV0S2V5TWF0ZXJpYWxMaW5lT25lQUJDREVGRw==",
      "U2VjcmV0S2V5TWF0ZXJpYWxMaW5lVHdvMTIzNDU2Nzg5",
      "-----END OPENSSH PRIVATE KEY-----",
      "EOF"
    ].join("\n")
  );
  assert.match(pem, /-----BEGIN OPENSSH PRIVATE KEY-----<redacted>-----END OPENSSH PRIVATE KEY-----/);
  assert.doesNotMatch(pem, /U2VjcmV0S2V5TWF0ZXJpYWw/);

  // (d) standalone base64 blob with no key prefix
  const b64 = redactCommand("echo Tm93IGlzIHRoZSB0aW1lIGZvciBhbGwgZ29vZCBtZW4= | base64 -d");
  assert.doesNotMatch(b64, /Tm93IGlzIHRoZSB0aW1lIGZvciBhbGwgZ29vZCBtZW4=/);
  assert.match(b64, /echo <redacted> \| base64 -d/);
});

test("redactCommand does not over-redact run ids, plan hashes, paths, or queue names", () => {
  const benign = [
    "python train.py --epochs 10",
    "run-id my-experiment-run-001-alpha-beta",
    "plan_hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    "path /data/alice/experiments/run-001/output.json",
    "queue gpuq",
    "snapshot quota-acct-a-2026-06-15T00-00-00-000Z"
  ].join(" ");
  assert.equal(redactCommand(benign), benign, "benign args must pass through unchanged");
});
