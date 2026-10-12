import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedLocalAddress, isAllowedLocalHost } from "./network-policy.js";

const neverCalled = async (): Promise<string[]> => {
  throw new Error("lookup must not be called");
};

describe("local address policy", () => {
  it("allows loopback and the Tailscale 100.64.0.0/10 range", () => {
    for (const address of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "100.64.0.0", "100.100.1.1", "100.127.255.255", "::ffff:100.100.1.1"]) {
      assert.equal(isAllowedLocalAddress(address), true, address);
    }
  });

  it("rejects everything else", () => {
    for (const address of [
      "100.63.255.255",
      "100.128.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "8.8.8.8",
      "0.0.0.0",
      "::",
      "::2",
      "fe80::1",
      "fe80::1%en0",
      "fd7a:115c:a1e0::1",
      "::ffff:8.8.8.8",
      "not-an-ip",
      "",
    ]) {
      assert.equal(isAllowedLocalAddress(address), false, address);
    }
  });
});

describe("local host policy", () => {
  it("judges literal IP hosts without a lookup", async () => {
    assert.equal(await isAllowedLocalHost("127.0.0.1", neverCalled), true);
    assert.equal(await isAllowedLocalHost("100.64.0.5", neverCalled), true);
    assert.equal(await isAllowedLocalHost("[::1]", neverCalled), true);
    assert.equal(await isAllowedLocalHost("8.8.8.8", neverCalled), false);
    assert.equal(await isAllowedLocalHost("[2001:db8::1]", neverCalled), false);
  });

  it("requires every resolved address to be allowed", async () => {
    assert.equal(await isAllowedLocalHost("llm.local", async () => ["127.0.0.1", "::1"]), true);
    assert.equal(await isAllowedLocalHost("llm.local", async () => ["100.101.102.103"]), true);
    assert.equal(await isAllowedLocalHost("llm.local", async () => ["127.0.0.1", "8.8.8.8"]), false);
    assert.equal(await isAllowedLocalHost("llm.local", async () => ["10.0.0.5"]), false);
  });

  it("denies an empty answer and a failed lookup", async () => {
    assert.equal(await isAllowedLocalHost("llm.local", async () => []), false);
    assert.equal(await isAllowedLocalHost("llm.local", neverCalled), false);
  });

  it("passes the bare hostname to the lookup", async () => {
    const seen: string[] = [];
    await isAllowedLocalHost("llm-box", async (host) => {
      seen.push(host);
      return ["100.64.1.1"];
    });
    assert.deepEqual(seen, ["llm-box"]);
  });
});
