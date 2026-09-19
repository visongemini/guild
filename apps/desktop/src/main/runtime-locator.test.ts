import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRuntimeSearchPath,
  mergeMacOSSystemProxyEnvironment,
} from "./runtime-locator.js";

describe("official Grok runtime search path", () => {
  it("extends a Finder-style PATH with common Homebrew locations", () => {
    assert.equal(
      buildRuntimeSearchPath("/usr/bin:/bin:/usr/sbin:/sbin", "/Users/example"),
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/example/.grok/bin:/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin",
    );
  });

  it("deduplicates existing locations without adding an empty current-directory entry", () => {
    assert.equal(
      buildRuntimeSearchPath(":/opt/homebrew/bin:/usr/bin:", "/Users/example"),
      "/opt/homebrew/bin:/usr/bin:/Users/example/.grok/bin:/Users/example/.local/bin:/usr/local/bin:/bin:/usr/sbin:/sbin",
    );
  });
});

describe("official Grok runtime proxy environment", () => {
  const systemProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
  }
  HTTPEnable : 1
  HTTPPort : 10808
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 10808
  SOCKSProxy : 127.0.0.1
}`;

  it("translates the active macOS proxy for a Finder-style environment", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      { PATH: "/usr/bin:/bin", LANG: "zh_CN.UTF-8" },
      systemProxy,
    );
    assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:10808");
    assert.equal(environment.http_proxy, "http://127.0.0.1:10808");
    assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:10808");
    assert.equal(environment.https_proxy, "http://127.0.0.1:10808");
    assert.equal(environment.ALL_PROXY, undefined);
    assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1,127.0.0.0/8");
    assert.equal(environment.no_proxy, environment.NO_PROXY);
    assert.equal(Object.isFrozen(environment), true);
  });

  it("preserves explicit proxy variables instead of overriding them", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      { HTTPS_PROXY: "http://explicit.example:8080" },
      systemProxy,
    );
    assert.equal(environment.HTTPS_PROXY, "http://explicit.example:8080");
    assert.equal(environment.HTTP_PROXY, undefined);
  });

  it("ignores malformed system proxy endpoints", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      {},
      `HTTPEnable : 1\nHTTPProxy : bad host/@example\nHTTPPort : 70000`,
    );
    assert.equal(environment.HTTP_PROXY, undefined);
    assert.equal(environment.NO_PROXY, undefined);
  });
});
