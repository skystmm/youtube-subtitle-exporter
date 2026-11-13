const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureLocalHelper, nativeHostInstallError } = require("../helper-launch.js");

test("does not invoke native messaging when helper is already healthy", async () => {
  let starts = 0;
  const result = await ensureLocalHelper({
    checkHealth: async () => true,
    startNative: async () => {
      starts += 1;
    },
    sleep: async () => {}
  });

  assert.equal(result.status, "already_running");
  assert.equal(starts, 0);
});

test("starts native host and waits until helper becomes healthy", async () => {
  const health = [false, false, true];
  let starts = 0;
  const result = await ensureLocalHelper({
    checkHealth: async () => health.shift(),
    startNative: async () => {
      starts += 1;
      return { ok: true, status: "started" };
    },
    sleep: async () => {},
    attempts: 3
  });

  assert.equal(result.status, "started");
  assert.equal(starts, 1);
});

test("installation error includes the current extension id", () => {
  const message = nativeHostInstallError("abcdefghijklmnop", "host not found");
  assert.match(message, /install-helper\.command/);
  assert.match(message, /abcdefghijklmnop/);
});
