import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  JsonRpcPeer,
  JsonRpcPeerError,
  JsonRpcRemoteError,
  type JsonRpcDiagnostic,
  type JsonRpcInboundResponseWriteReceipt,
  type JsonRpcPeerOptions,
} from "./json-rpc-peer.js";

type WrittenMessage = Record<string, unknown>;

function recordingPeer(
  overrides: Partial<JsonRpcPeerOptions> = {},
): { readonly peer: JsonRpcPeer; readonly frames: string[] } {
  const frames: string[] = [];
  const peer = new JsonRpcPeer({
    requestTimeoutMs: 500,
    ...overrides,
    write:
      overrides.write ??
      (async (frame) => {
        frames.push(frame);
      }),
  });
  return { peer, frames };
}

function message(frame: string): WrittenMessage {
  assert.equal(frame.endsWith("\n"), true);
  assert.equal(frame.endsWith("\n\n"), false);
  return JSON.parse(frame.slice(0, -1)) as WrittenMessage;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${milliseconds} ms test bound`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function hasPeerCode(code: JsonRpcPeerError["code"]): (cause: unknown) => boolean {
  return (cause) => cause instanceof JsonRpcPeerError && cause.code === code;
}

describe("JsonRpcPeer outbound correlation (PC-TRN-002/003)", () => {
  it("uses monotonic numeric IDs and routes out-of-order responses", async () => {
    const { peer, frames } = recordingPeer();
    const first = peer.sendRequest("first", { order: 1 });
    const second = peer.sendRequest("second", { order: 2 });
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    await Promise.all([first.write, second.write]);
    assert.deepEqual(frames.map(message), [
      { jsonrpc: "2.0", id: 1, method: "first", params: { order: 1 } },
      { jsonrpc: "2.0", id: 2, method: "second", params: { order: 2 } },
    ]);

    await peer.receive({ jsonrpc: "2.0", id: 2, result: "two" });
    await peer.receive({ jsonrpc: "2.0", id: 1, result: "one" });
    assert.equal(await first.response, "one");
    assert.equal(await second.response, "two");
    assert.equal(peer.pendingRequestCount, 0);
    peer.close();
  });

  it("bounds pending requests without consuming a rejected ID", async () => {
    const { peer } = recordingPeer({ maxPendingRequests: 1 });
    const first = peer.sendRequest("one");
    assert.throws(
      () => peer.sendRequest("overflow"),
      hasPeerCode("pending_request_limit"),
    );
    assert.equal(peer.pendingRequestCount, 1);
    await peer.receive({ jsonrpc: "2.0", id: 1, result: null });
    const second = peer.sendRequest("two");
    assert.equal(second.id, 2);
    peer.close();
    await assert.rejects(second.response, hasPeerCode("transport_fault"));
    await first.write;
  });

  it("keeps local write evidence separate from remote acceptance", async () => {
    const { peer } = recordingPeer();
    const handle = peer.sendRequest("slow-remote");
    let responseSettled = false;
    void handle.response.then(
      () => {
        responseSettled = true;
      },
      () => {
        responseSettled = true;
      },
    );
    const receipt = await handle.write;
    await Promise.resolve();
    assert.equal(receipt.evidence, "local_writer_completion");
    assert.equal(receipt.remoteAcceptance, "not_evidenced");
    assert.equal(responseSettled, false);
    assert.equal(peer.pendingRequestCount, 1);

    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: { accepted: true } });
    assert.deepEqual(await handle.response, { accepted: true });
    peer.close();
  });

  it("emits notifications without creating response promises", async () => {
    const { peer, frames } = recordingPeer();
    const receipt = await peer.sendNotification("session/cancel", { sessionId: "s-1" });
    assert.equal(receipt.messageType, "notification");
    assert.equal(receipt.requestId, undefined);
    assert.equal(receipt.remoteAcceptance, "not_evidenced");
    assert.deepEqual(message(frames[0]!), {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s-1" },
    });
    assert.equal(peer.pendingRequestCount, 0);
    peer.close();
  });

  it("rejects a remote error without turning it into a protocol fault", async () => {
    const { peer } = recordingPeer();
    const handle = peer.sendRequest("will-fail");
    await peer.receive({
      jsonrpc: "2.0",
      id: handle.id,
      error: { code: -32001, message: "agent rejected", data: { retry: false } },
    });
    await assert.rejects(
      handle.response,
      (cause) =>
        cause instanceof JsonRpcRemoteError &&
        cause.response.code === -32001 &&
        cause.response.data !== undefined,
    );
    assert.equal(peer.terminalFault, undefined);
    peer.close();
  });
});

describe("JsonRpcPeer timeout and response-ID discipline", () => {
  it("lets an explicit null response deadline outlive the peer default and remain transport-bound", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      requestTimeoutMs: 10,
      writeTimeoutMs: 100,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const handle = peer.sendRequest(
      "no-remote-response-deadline",
      undefined,
      { responseTimeoutMs: null },
    );

    await handle.write;
    await delay(30);
    assert.equal(peer.pendingRequestCount, 1);
    assert.equal(peer.timeoutTombstoneCount, 0);
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.type === "request_timed_out"),
      false,
    );

    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: "still-correlated" });
    assert.equal(await handle.response, "still-correlated");

    const pending = peer.sendRequest(
      "no-deadline-still-closes",
      undefined,
      { responseTimeoutMs: null },
    );
    await pending.write;
    assert.equal(peer.close("test close"), true);
    await assert.rejects(pending.response, hasPeerCode("transport_fault"));
  });

  it("keeps an explicit finite response deadline behavior", async () => {
    const { peer } = recordingPeer({ requestTimeoutMs: 500 });
    const handle = peer.sendRequest(
      "finite-remote-response-deadline",
      undefined,
      { responseTimeoutMs: 10 },
    );

    await handle.write;
    await delay(25);
    await assert.rejects(handle.response, hasPeerCode("request_timeout"));
    assert.equal(peer.timeoutTombstoneCount, 1);
    peer.close();
  });

  it("keeps the write deadline active when the response deadline is null", async () => {
    const writeGate = deferred<void>();
    let writerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      requestTimeoutMs: 10,
      writeTimeoutMs: 100,
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });
    const handle = peer.sendRequest(
      "null-response-deadline-bounded-write",
      undefined,
      { responseTimeoutMs: null, writeTimeoutMs: 15 },
    );

    const settled = await bounded(
      Promise.allSettled([handle.write, handle.response]),
    );
    assert.equal(
      settled.every(
        (result) =>
          result.status === "rejected" && hasPeerCode("write_timeout")(result.reason),
      ),
      true,
    );
    assert.equal(writerSignal?.aborted, true);
    assert.equal(peer.pendingRequestCount, 0);
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });
    writeGate.resolve();
  });

  it("does not consume the remote-response timeout while the local writer is pending", async () => {
    const writeGate = deferred<void>();
    const { peer } = recordingPeer({
      requestTimeoutMs: 10,
      writeTimeoutMs: 500,
      write: async () => writeGate.promise,
    });
    const handle = peer.sendRequest("delayed-local-write");

    await delay(25);
    assert.equal(peer.pendingRequestCount, 1);
    assert.equal(peer.timeoutTombstoneCount, 0);

    writeGate.resolve();
    await bounded(handle.write);
    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: "after-write" });
    assert.equal(await bounded(handle.response), "after-write");
    peer.close();
  });

  it("accepts a response before the writer fulfills and never arms its response timer", async () => {
    const writeGate = deferred<void>();
    let peer!: JsonRpcPeer;
    peer = new JsonRpcPeer({
      requestTimeoutMs: 10,
      writeTimeoutMs: 500,
      write: async (frame) => {
        const outbound = message(frame);
        await peer.receive({ jsonrpc: "2.0", id: outbound["id"], result: "fast" });
        await writeGate.promise;
      },
    });

    const handle = peer.sendRequest("fast-response");
    assert.equal(await bounded(handle.response), "fast");
    assert.equal(peer.pendingRequestCount, 0);

    let writeSettled = false;
    void handle.write.finally(() => {
      writeSettled = true;
    });
    await Promise.resolve();
    assert.equal(writeSettled, false);

    writeGate.resolve();
    await bounded(handle.write);
    await delay(25);
    assert.equal(peer.timeoutTombstoneCount, 0);
    assert.equal(peer.terminalFault, undefined);
    peer.close();
  });

  it("leaves a bounded timeout tombstone and ignores a late match diagnostically", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      requestTimeoutMs: 10,
      maxTimeoutTombstones: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const first = peer.sendRequest("times-out-1");
    await delay(25);
    await assert.rejects(first.response, hasPeerCode("request_timeout"));
    assert.equal(peer.timeoutTombstoneCount, 1);
    await peer.receive({ jsonrpc: "2.0", id: first.id, result: "late" });
    assert.equal(peer.terminalFault, undefined);
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.type === "late_response_ignored" && diagnostic.requestId === first.id,
      ),
      true,
    );

    const second = peer.sendRequest("times-out-2");
    await delay(25);
    await assert.rejects(second.response, hasPeerCode("request_timeout"));
    assert.equal(peer.timeoutTombstoneCount, 1);
    peer.close();
  });

  it("ignores a truly unknown response ID without disrupting pending requests", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const first = peer.sendRequest("one");
    const second = peer.sendRequest("two");
    await peer.receive({ jsonrpc: "2.0", id: 99, result: null });
    assert.equal(peer.terminalFault, undefined);
    assert.equal(peer.pendingRequestCount, 2);
    assert.deepEqual(diagnostics, [{
      type: "orphan_response_ignored",
      classification: "unmatched",
      highestIssuedRequestId: 2,
      pendingMethods: ["one", "two"],
      pendingRequestCount: 2,
      responseId: 99,
      responseIdKind: "number",
      responseType: "result",
    }]);
    await peer.receive({ jsonrpc: "2.0", id: first.id, result: "first" });
    await peer.receive({ jsonrpc: "2.0", id: second.id, result: "second" });
    assert.equal(await first.response, "first");
    assert.equal(await second.response, "second");
  });

  it("ignores a duplicate completed response ID diagnostically", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const handle = peer.sendRequest("once");
    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: 1 });
    assert.equal(await handle.response, 1);
    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: 2 });
    assert.equal(peer.terminalFault, undefined);
    assert.deepEqual(diagnostics, [{
      type: "orphan_response_ignored",
      classification: "duplicate_or_stale",
      highestIssuedRequestId: handle.id,
      pendingMethods: [],
      pendingRequestCount: 0,
      responseId: handle.id,
      responseIdKind: "number",
      responseType: "result",
    }]);
  });

  it("ignores an unmatched string response ID without logging its value", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const handle = peer.sendRequest("numeric-only");
    await peer.receive({ jsonrpc: "2.0", id: "upstream-internal", result: null });
    assert.equal(peer.terminalFault, undefined);
    assert.deepEqual(diagnostics, [{
      type: "orphan_response_ignored",
      classification: "unmatched",
      highestIssuedRequestId: handle.id,
      pendingMethods: ["numeric-only"],
      pendingRequestCount: 1,
      responseIdKind: "string",
      responseType: "result",
    }]);
    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: "ok" });
    assert.equal(await handle.response, "ok");
  });

  it("clears response and write timers on completed operations", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const active = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      milliseconds?: number,
      ...args: unknown[]
    ) => {
      const timer = originalSetTimeout(callback, milliseconds, ...args);
      active.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
      if (typeof timer === "object" && timer !== null) {
        active.delete(timer as ReturnType<typeof setTimeout>);
      }
      originalClearTimeout(timer);
    }) as typeof clearTimeout;

    let peer: JsonRpcPeer | undefined;
    try {
      peer = new JsonRpcPeer({
        requestTimeoutMs: 50,
        writeTimeoutMs: 50,
        write: async () => undefined,
      });
      const handle = peer.sendRequest("timer-cleanup");
      await handle.write;
      await peer.receive({ jsonrpc: "2.0", id: handle.id, result: null });
      await handle.response;
      await peer.sendNotification(
        "timer-cleanup-notification",
        undefined,
        { writeTimeoutMs: 25 },
      );
      assert.equal(active.size, 0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      for (const timer of active) {
        originalClearTimeout(timer);
      }
      peer?.close();
    }
  });
});

describe("JsonRpcPeer inbound requests and validation", () => {
  it("routes callbacks and writes result/error replies with the exact inbound ID", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer, frames } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onRequest: (request) =>
        request.method === "permission/result"
          ? { type: "result", result: { allowed: true, seen: request.params ?? null } }
          : {
              type: "error",
              error: { code: -32010, message: "denied", data: "policy" },
            },
    });

    await peer.receive({
      jsonrpc: "2.0",
      id: "opaque-agent-id",
      method: "permission/result",
      params: { toolCallId: "tool-1" },
    });
    await peer.receive({
      jsonrpc: "2.0",
      id: 47,
      method: "permission/error",
    });
    assert.deepEqual(frames.map(message), [
      {
        jsonrpc: "2.0",
        id: "opaque-agent-id",
        result: { allowed: true, seen: { toolCallId: "tool-1" } },
      },
      {
        jsonrpc: "2.0",
        id: 47,
        error: { code: -32010, message: "denied", data: "policy" },
      },
    ]);
    assert.deepEqual(diagnostics, []);
    peer.close();
  });

  it("settles an explicitly abandoned inbound request without a frame and releases its active ID", async () => {
    const receipts: JsonRpcInboundResponseWriteReceipt[] = [];
    let abandonNext = true;
    const { peer, frames } = recordingPeer({
      onRequest: () => {
        if (abandonNext) {
          abandonNext = false;
          return { type: "no_response", reason: "abandoned" };
        }
        return { type: "result", result: { accepted: true } };
      },
    });
    peer.onInboundResponseWrite((receipt) => receipts.push(receipt));

    await peer.receive({ jsonrpc: "2.0", id: "reusable-id", method: "permission/abandon" });
    assert.deepEqual(frames, []);
    assert.equal(receipts.length, 0);

    await peer.receive({ jsonrpc: "2.0", id: "reusable-id", method: "permission/next" });
    assert.deepEqual(frames.map(message), [
      { jsonrpc: "2.0", id: "reusable-id", result: { accepted: true } },
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.requestId), ["reusable-id"]);
    peer.close();
  });

  it("emits ordered frozen privacy-bounded write receipts for every inbound ID type", async () => {
    const receipts: JsonRpcInboundResponseWriteReceipt[] = [];
    const frames: string[] = [];
    const order: string[] = [];
    const peer = new JsonRpcPeer({
      onRequest: () => ({
        type: "result",
        result: {
          echoedSecret: "private-params-sentinel",
          rawFrameSentinel: "must-not-enter-receipt",
        },
      }),
      write: async (frame) => {
        frames.push(frame);
        order.push("writer_completed");
      },
    });
    peer.onInboundResponseWrite(() => {
      throw new Error("observer failure must not affect response delivery");
    });
    const unsubscribe = peer.onInboundResponseWrite((receipt) => {
      receipts.push(receipt);
      order.push("receipt_emitted");
    });

    const requests = [
      { id: 47, method: "callback/number" },
      { id: "opaque-id", method: "callback/string" },
      { id: null, method: "callback/null" },
    ] as const;
    for (const request of requests) {
      await peer.receive({
        jsonrpc: "2.0",
        id: request.id,
        method: request.method,
        params: { privateValue: "private-params-sentinel" },
      });
      order.push("receive_resolved");
    }

    assert.deepEqual(order, [
      "writer_completed",
      "receipt_emitted",
      "receive_resolved",
      "writer_completed",
      "receipt_emitted",
      "receive_resolved",
      "writer_completed",
      "receipt_emitted",
      "receive_resolved",
    ]);
    assert.deepEqual(
      receipts.map((receipt) => ({
        method: receipt.method,
        requestId: receipt.requestId,
      })),
      requests.map((request) => ({
        method: request.method,
        requestId: request.id,
      })),
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.bytes),
      frames.map((frame) => Buffer.byteLength(frame)),
    );
    for (const receipt of receipts) {
      assert.equal(Object.isFrozen(receipt), true);
      assert.deepEqual(Object.keys(receipt), [
        "type",
        "method",
        "requestId",
        "bytes",
        "evidence",
        "remoteAcceptance",
      ]);
      assert.equal(receipt.type, "inbound_response_write_completed");
      assert.equal(receipt.evidence, "local_writer_completion");
      assert.equal(receipt.remoteAcceptance, "not_evidenced");
      assert.throws(() => {
        (receipt as unknown as Record<string, unknown>)["method"] = "mutated";
      }, TypeError);
    }
    const serializedReceipts = JSON.stringify(receipts);
    assert.equal(serializedReceipts.includes("private-params-sentinel"), false);
    assert.equal(serializedReceipts.includes("must-not-enter-receipt"), false);
    assert.equal(serializedReceipts.includes("jsonrpc"), false);

    unsubscribe();
    await peer.receive({
      jsonrpc: "2.0",
      id: "after-unsubscribe",
      method: "callback/unsubscribed",
    });
    assert.equal(receipts.length, 3);
    peer.close();
  });

  it("does not emit an inbound response receipt on writer failure or timeout", async () => {
    const failedReceipts: JsonRpcInboundResponseWriteReceipt[] = [];
    const failedPeer = new JsonRpcPeer({
      onRequest: () => ({ type: "result", result: null }),
      write: async () => {
        throw new Error("local writer failed");
      },
    });
    failedPeer.onInboundResponseWrite((receipt) => failedReceipts.push(receipt));
    await assert.rejects(
      failedPeer.receive({ jsonrpc: "2.0", id: 1, method: "callback/failure" }),
      hasPeerCode("write_failed"),
    );
    assert.deepEqual(failedReceipts, []);

    const writeGate = deferred<void>();
    const timedOutReceipts: JsonRpcInboundResponseWriteReceipt[] = [];
    let writerSignal: AbortSignal | undefined;
    const timedOutPeer = new JsonRpcPeer({
      writeTimeoutMs: 15,
      onRequest: () => ({ type: "result", result: null }),
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });
    timedOutPeer.onInboundResponseWrite((receipt) => timedOutReceipts.push(receipt));
    await assert.rejects(
      bounded(
        timedOutPeer.receive({
          jsonrpc: "2.0",
          id: "timeout-id",
          method: "callback/timeout",
        }),
      ),
      hasPeerCode("write_timeout"),
    );
    assert.equal(writerSignal?.aborted, true);
    assert.deepEqual(timedOutReceipts, []);
    writeGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(timedOutReceipts, []);
  });

  it("routes notifications without replying", async () => {
    const seen: unknown[] = [];
    const { peer, frames } = recordingPeer({
      onNotification: (notification) => {
        seen.push(notification);
      },
    });
    await peer.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1" },
    });
    assert.deepEqual(seen, [
      { method: "session/update", params: { sessionId: "s-1" } },
    ]);
    assert.deepEqual(frames, []);
    peer.close();
  });

  it("returns an exact-ID internal error when an inbound handler throws", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer, frames } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onRequest: () => {
        throw new Error("private handler detail");
      },
    });
    await peer.receive({ jsonrpc: "2.0", id: null, method: "callback" });
    assert.deepEqual(message(frames[0]!), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error" },
    });
    assert.deepEqual(diagnostics, [
      { type: "inbound_handler_failed", method: "callback" },
    ]);
    peer.close();
  });

  it("terminally rejects invalid JSON-RPC 2.0 shapes", async () => {
    const invalidMessages: readonly unknown[] = [
      { jsonrpc: "1.0", id: 1, result: null },
      { jsonrpc: "2.0", id: 1, result: null, error: { code: 1, message: "both" } },
      { jsonrpc: "2.0", method: 7 },
      { jsonrpc: "2.0", method: "x", params: null },
      { jsonrpc: "2.0", result: null },
      { jsonrpc: "2.0", id: 1.5, result: null },
      { jsonrpc: "2.0", id: 1, error: { code: "bad", message: "x" } },
    ];
    for (const invalid of invalidMessages) {
      const { peer } = recordingPeer();
      await assert.rejects(peer.receive(invalid), hasPeerCode("protocol_fault"));
      assert.deepEqual(peer.terminalFault, {
        type: "protocol_fault",
        code: "invalid_message",
      });
    }
  });
});

describe("JsonRpcPeer terminal transport behavior", () => {
  it("preserves a matching response when the deferred writer rejects afterward", async () => {
    const writeGate = deferred<void>();
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 500,
      write: async () => writeGate.promise,
    });
    const handle = peer.sendRequest("response-wins-write-rejection");

    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: "accepted" });
    assert.equal(await bounded(handle.response), "accepted");

    writeGate.reject(new Error("deferred writer rejected"));
    await assert.rejects(bounded(handle.write), hasPeerCode("write_failed"));
    assert.equal(await handle.response, "accepted");
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_failure", reason: "local writer rejected" },
    });
  });

  it("preserves a matching response when the deferred writer times out afterward", async () => {
    const writeGate = deferred<void>();
    let writerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 15,
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });
    const handle = peer.sendRequest("response-wins-write-timeout");
    let writeSettlements = 0;
    const observedWrite = handle.write.finally(() => {
      writeSettlements += 1;
    });

    await peer.receive({ jsonrpc: "2.0", id: handle.id, result: "accepted" });
    assert.equal(await bounded(handle.response), "accepted");
    await assert.rejects(bounded(observedWrite), hasPeerCode("write_timeout"));
    assert.equal(writerSignal?.aborted, true);
    assert.equal(await handle.response, "accepted");
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });

    writeGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writeSettlements, 1);
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });
  });

  it("keeps a winning write deadline terminal after a late match and writer resolution", async () => {
    const writeGate = deferred<void>();
    let writerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 15,
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });
    const handle = peer.sendRequest("write-timeout-wins");
    const settlements = { response: 0, write: 0 };
    const observed = [
      handle.write.finally(() => {
        settlements.write += 1;
      }),
      handle.response.finally(() => {
        settlements.response += 1;
      }),
    ];

    const initial = await bounded(Promise.allSettled(observed));
    assert.equal(
      initial.every(
        (result) =>
          result.status === "rejected" && hasPeerCode("write_timeout")(result.reason),
      ),
      true,
    );
    assert.deepEqual(settlements, { response: 1, write: 1 });
    assert.equal(writerSignal?.aborted, true);
    const terminalFault = peer.terminalFault;

    await assert.rejects(
      peer.receive({ jsonrpc: "2.0", id: handle.id, result: "too-late" }),
      hasPeerCode("peer_closed"),
    );
    writeGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(settlements, { response: 1, write: 1 });
    assert.equal(peer.terminalFault, terminalFault);
  });

  it("terminalizes when a notification write times out", async () => {
    const writeGate = deferred<void>();
    let writerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 15,
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });

    await assert.rejects(
      bounded(peer.sendNotification("notification-write-timeout")),
      hasPeerCode("write_timeout"),
    );
    assert.equal(writerSignal?.aborted, true);
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });
    writeGate.resolve();
  });

  it("terminalizes when an inbound callback-response write times out", async () => {
    const writeGate = deferred<void>();
    let writerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 15,
      onRequest: () => ({ type: "result", result: { allowed: true } }),
      write: async (_frame, signal) => {
        writerSignal = signal;
        await writeGate.promise;
      },
    });

    await assert.rejects(
      bounded(
        peer.receive({
          jsonrpc: "2.0",
          id: "callback-1",
          method: "permission/check",
        }),
      ),
      hasPeerCode("write_timeout"),
    );
    assert.equal(writerSignal?.aborted, true);
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });
    writeGate.resolve();
  });

  it("aborts all active writers on an unrelated terminal fault and ignores completion", async () => {
    const writeGates = [deferred<void>(), deferred<void>()];
    const writerSignals: AbortSignal[] = [];
    let writeIndex = 0;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 500,
      write: async (_frame, signal) => {
        const gate = writeGates[writeIndex++];
        assert.ok(gate !== undefined);
        writerSignals.push(signal);
        await gate.promise;
      },
    });
    const request = peer.sendRequest("pending-during-stdout-fault");
    const notification = peer.sendNotification("also-pending-during-stdout-fault");
    const settlements = { notification: 0, response: 0, write: 0 };
    const observed = [
      request.write.finally(() => {
        settlements.write += 1;
      }),
      request.response.finally(() => {
        settlements.response += 1;
      }),
      notification.finally(() => {
        settlements.notification += 1;
      }),
    ];

    assert.equal(peer.failTransport({ type: "stdout_eof" }), true);
    const initial = await bounded(Promise.allSettled(observed));
    assert.equal(
      initial.every(
        (result) =>
          result.status === "rejected" && hasPeerCode("transport_fault")(result.reason),
      ),
      true,
    );
    assert.equal(writerSignals.length, 2);
    assert.equal(writerSignals.every((signal) => signal.aborted), true);
    assert.deepEqual(settlements, { notification: 1, response: 1, write: 1 });
    const terminalFault = peer.terminalFault;

    for (const gate of writeGates) {
      gate.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(settlements, { notification: 1, response: 1, write: 1 });
    assert.equal(peer.terminalFault, terminalFault);
  });

  it("aborts a bounded write and terminalizes every pending operation exactly once", async () => {
    const writeGates = [deferred<void>(), deferred<void>()];
    const signals: AbortSignal[] = [];
    let writeIndex = 0;
    const peer = new JsonRpcPeer({
      requestTimeoutMs: 500,
      writeTimeoutMs: 500,
      write: async (_frame, signal) => {
        signals.push(signal);
        await writeGates[writeIndex++]!.promise;
      },
    });
    const request = peer.sendRequest(
      "write-times-out",
      undefined,
      { writeTimeoutMs: 15 },
    );
    const notification = peer.sendNotification("also-pending");
    const settlementCounts = { notification: 0, response: 0, write: 0 };
    const observed: Promise<unknown>[] = [
      request.write.finally(() => {
        settlementCounts.write += 1;
      }),
      request.response.finally(() => {
        settlementCounts.response += 1;
      }),
      notification.finally(() => {
        settlementCounts.notification += 1;
      }),
    ];

    const settled = await bounded(Promise.allSettled(observed));
    assert.equal(settled.every((result) => result.status === "rejected"), true);
    assert.equal(
      settled.every(
        (result) =>
          result.status === "rejected" && hasPeerCode("write_timeout")(result.reason),
      ),
      true,
    );
    assert.deepEqual(settlementCounts, { notification: 1, response: 1, write: 1 });
    assert.equal(signals.length, 2);
    assert.equal(signals.every((signal) => signal.aborted), true);
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_timeout", timeoutMs: 15 },
    });
    assert.equal(peer.pendingRequestCount, 0);

    for (const gate of writeGates) {
      gate.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(settlementCounts, { notification: 1, response: 1, write: 1 });
  });

  it("rejects every pending request exactly once and makes repeated failure idempotent", async () => {
    const diagnostics: JsonRpcDiagnostic[] = [];
    const { peer } = recordingPeer({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const first = peer.sendRequest("one");
    const second = peer.sendRequest("two");
    let rejectionCount = 0;
    const observed = [first.response, second.response].map(async (response) => {
      try {
        await response;
      } catch (cause) {
        rejectionCount += 1;
        throw cause;
      }
    });

    assert.equal(peer.failTransport({ type: "stdout_eof" }), true);
    assert.equal(peer.failTransport({ type: "process_exit", code: 1, signal: null }), false);
    const settled = await Promise.allSettled(observed);
    assert.equal(settled.every((result) => result.status === "rejected"), true);
    assert.equal(rejectionCount, 2);
    assert.equal(peer.pendingRequestCount, 0);
    assert.equal(
      diagnostics.filter((diagnostic) => diagnostic.type === "terminal_fault").length,
      1,
    );
    assert.throws(() => peer.sendRequest("after-fault"), hasPeerCode("peer_closed"));
  });

  it("turns writer rejection into a terminal typed write failure", async () => {
    const peer = new JsonRpcPeer({
      write: async () => {
        throw new Error("untrusted writer detail");
      },
    });
    const handle = peer.sendRequest("write-fails");
    await assert.rejects(handle.write, hasPeerCode("write_failed"));
    await assert.rejects(handle.response, hasPeerCode("write_failed"));
    assert.deepEqual(peer.terminalFault, {
      type: "transport_fault",
      fault: { type: "write_failure", reason: "local writer rejected" },
    });
  });

  it("terminalizes on request-ID exhaustion and rejects existing work", async () => {
    const writeGate = deferred<void>();
    let signal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      writeTimeoutMs: 500,
      write: async (_frame, writerSignal) => {
        signal = writerSignal;
        await writeGate.promise;
      },
    });
    const existing = peer.sendRequest("already-pending");
    Object.defineProperty(peer, "nextRequestId", {
      configurable: true,
      value: Number.MAX_SAFE_INTEGER + 1,
      writable: true,
    });

    assert.throws(
      () => peer.sendRequest("cannot-allocate"),
      hasPeerCode("request_id_exhausted"),
    );
    await assert.rejects(bounded(existing.write), hasPeerCode("request_id_exhausted"));
    await assert.rejects(bounded(existing.response), hasPeerCode("request_id_exhausted"));
    assert.equal(signal?.aborted, true);
    assert.equal(peer.pendingRequestCount, 0);
    assert.deepEqual(peer.terminalFault, { type: "request_id_exhausted" });
    assert.throws(() => peer.sendRequest("after-exhaustion"), hasPeerCode("peer_closed"));
    writeGate.resolve();
  });
});
