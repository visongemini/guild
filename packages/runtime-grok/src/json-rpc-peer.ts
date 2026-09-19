import { Buffer } from "node:buffer";
import {
  assertJsonValue,
  isNonArrayObject,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from "./json-value.js";
import { encodeNdjson } from "./ndjson.js";

export type JsonRpcId = number | string | null;
export type JsonRpcParams = JsonArray | JsonObject;

export type JsonRpcErrorObject = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

export type JsonRpcInboundRequest = {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: JsonRpcParams | undefined;
};

export type JsonRpcInboundNotification = {
  readonly method: string;
  readonly params: JsonRpcParams | undefined;
};

export type JsonRpcHandlerReply =
  | { readonly type: "error"; readonly error: JsonRpcErrorObject }
  | { readonly type: "no_response"; readonly reason: "abandoned" }
  | { readonly type: "result"; readonly result: JsonValue };

export type JsonRpcInboundRequestHandler = (
  request: JsonRpcInboundRequest,
) => JsonRpcHandlerReply | Promise<JsonRpcHandlerReply>;

export type JsonRpcInboundNotificationHandler = (
  notification: JsonRpcInboundNotification,
) => void | Promise<void>;

export type JsonRpcFrameWriter = (
  frame: string,
  signal: AbortSignal,
) => Promise<unknown>;

export type JsonRpcWriteReceipt = {
  readonly type: "write_completed";
  readonly messageType: "notification" | "request" | "response";
  readonly requestId: JsonRpcId | undefined;
  readonly bytes: number;
  readonly evidence: "local_writer_completion";
  readonly remoteAcceptance: "not_evidenced";
};

export type JsonRpcInboundResponseWriteReceipt = {
  readonly type: "inbound_response_write_completed";
  readonly method: string;
  readonly requestId: JsonRpcId;
  readonly bytes: number;
  readonly evidence: "local_writer_completion";
  readonly remoteAcceptance: "not_evidenced";
};

export type JsonRpcInboundResponseWriteListener = (
  receipt: JsonRpcInboundResponseWriteReceipt,
) => void;

export type JsonRpcRequestOptions = {
  readonly responseTimeoutMs?: number | null;
  readonly timeoutMs?: number;
  readonly writeTimeoutMs?: number;
};

export type JsonRpcRequestHandle = {
  readonly id: number;
  readonly write: Promise<JsonRpcWriteReceipt>;
  readonly response: Promise<JsonValue>;
};

export type JsonRpcProtocolFaultCode =
  | "duplicate_inbound_request_id"
  | "duplicate_response_id"
  | "invalid_message"
  | "unknown_response_id";

export type JsonRpcTransportFault =
  | { readonly type: "decoder_fault"; readonly code: string }
  | { readonly type: "explicit_close"; readonly reason: string }
  | { readonly type: "process_exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "spawn_failure"; readonly reason: string }
  | { readonly type: "stdout_eof" }
  | { readonly type: "write_failure"; readonly reason: string }
  | { readonly type: "write_timeout"; readonly timeoutMs: number };

export type JsonRpcTerminalFault =
  | {
      readonly type: "protocol_fault";
      readonly code: JsonRpcProtocolFaultCode;
    }
  | {
      readonly type: "transport_fault";
      readonly fault: JsonRpcTransportFault;
    }
  | { readonly type: "request_id_exhausted" };

export type JsonRpcDiagnostic =
  | {
      readonly type: "inbound_handler_failed";
      readonly method: string;
    }
  | {
      readonly type: "late_response_ignored";
      readonly requestId: number;
    }
  | {
      readonly type: "orphan_response_ignored";
      readonly classification: "duplicate_or_stale" | "unmatched";
      readonly highestIssuedRequestId: number;
      readonly pendingMethods: readonly string[];
      readonly pendingRequestCount: number;
      readonly responseId?: number;
      readonly responseIdKind: "null" | "number" | "string";
      readonly responseType: "error" | "result";
    }
  | {
      readonly type: "notification_handler_failed";
      readonly method: string;
    }
  | {
      readonly type: "request_timed_out";
      readonly requestId: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "terminal_fault";
      readonly fault: JsonRpcTerminalFault;
    };

export type JsonRpcPeerErrorCode =
  | "invalid_outbound_message"
  | "peer_closed"
  | "pending_request_limit"
  | "protocol_fault"
  | "request_id_exhausted"
  | "request_timeout"
  | "transport_fault"
  | "write_timeout"
  | "write_failed";

export class JsonRpcPeerError extends Error {
  readonly code: JsonRpcPeerErrorCode;
  readonly terminal: boolean;

  constructor(code: JsonRpcPeerErrorCode, message: string, terminal = false) {
    super(message);
    this.name = "JsonRpcPeerError";
    this.code = code;
    this.terminal = terminal;
  }
}

export class JsonRpcRemoteError extends Error {
  readonly response: JsonRpcErrorObject;

  constructor(response: JsonRpcErrorObject) {
    super(`remote JSON-RPC error ${response.code}: ${response.message}`);
    this.name = "JsonRpcRemoteError";
    this.response = response;
  }
}

export type JsonRpcPeerOptions = {
  readonly maxPendingRequests?: number;
  readonly maxTimeoutTombstones?: number;
  readonly onDiagnostic?: (diagnostic: JsonRpcDiagnostic) => void;
  readonly onNotification?: JsonRpcInboundNotificationHandler;
  readonly onRequest?: JsonRpcInboundRequestHandler;
  readonly requestTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly write: JsonRpcFrameWriter;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
};

type PendingRequest = {
  readonly deferred: Deferred<JsonValue>;
  readonly id: number;
  readonly method: string;
  responseTimer: NodeJS.Timeout | undefined;
};

type PendingWrite = {
  readonly complete: ((receipt: JsonRpcWriteReceipt) => void) | undefined;
  readonly controller: AbortController;
  readonly deferred: Deferred<JsonRpcWriteReceipt>;
  readonly frameBytes: number;
  readonly messageType: JsonRpcWriteReceipt["messageType"];
  readonly requestId: JsonRpcId | undefined;
  readonly timeoutMs: number;
  timer: NodeJS.Timeout | undefined;
};

type ParsedMessage =
  | {
      readonly type: "notification";
      readonly method: string;
      readonly params: JsonRpcParams | undefined;
    }
  | {
      readonly type: "request";
      readonly id: JsonRpcId;
      readonly method: string;
      readonly params: JsonRpcParams | undefined;
    }
  | {
      readonly type: "response_error";
      readonly id: JsonRpcId;
      readonly error: JsonRpcErrorObject;
    }
  | {
      readonly type: "response_result";
      readonly id: JsonRpcId;
      readonly result: JsonValue;
    };

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_TOMBSTONES = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;

/** Strict JSON-RPC 2.0 request correlation and callback routing (PC-TRN-002/003). */
export class JsonRpcPeer {
  private readonly writer: JsonRpcFrameWriter;
  private readonly maxPendingRequests: number;
  private readonly maxTimeoutTombstones: number;
  private readonly requestTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private readonly timeoutTombstones = new Map<number, true>();
  private readonly activeInboundIds = new Set<string>();
  private readonly diagnosticListeners = new Set<(diagnostic: JsonRpcDiagnostic) => void>();
  private readonly inboundResponseWriteListeners =
    new Set<JsonRpcInboundResponseWriteListener>();
  private requestHandler: JsonRpcInboundRequestHandler | undefined;
  private notificationHandler: JsonRpcInboundNotificationHandler | undefined;
  private nextRequestId = 1;
  private highestIssuedRequestId = 0;
  private status: "open" | "terminal" = "open";
  private currentTerminalFault: JsonRpcTerminalFault | undefined;

  constructor(options: JsonRpcPeerOptions) {
    this.writer = options.write;
    this.maxPendingRequests = positiveSafeInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING,
      "maxPendingRequests",
    );
    this.maxTimeoutTombstones = positiveSafeInteger(
      options.maxTimeoutTombstones ?? DEFAULT_MAX_TOMBSTONES,
      "maxTimeoutTombstones",
    );
    this.requestTimeoutMs = positiveSafeInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.writeTimeoutMs = positiveSafeInteger(
      options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
      "writeTimeoutMs",
    );
    this.requestHandler = options.onRequest;
    this.notificationHandler = options.onNotification;
    if (options.onDiagnostic !== undefined) {
      this.diagnosticListeners.add(options.onDiagnostic);
    }
  }

  get terminalFault(): JsonRpcTerminalFault | undefined {
    return this.currentTerminalFault;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get timeoutTombstoneCount(): number {
    return this.timeoutTombstones.size;
  }

  onDiagnostic(listener: (diagnostic: JsonRpcDiagnostic) => void): () => void {
    if (this.status === "terminal") {
      return () => undefined;
    }
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  onInboundResponseWrite(listener: JsonRpcInboundResponseWriteListener): () => void {
    if (this.status === "terminal") {
      return () => undefined;
    }
    this.inboundResponseWriteListeners.add(listener);
    return () => this.inboundResponseWriteListeners.delete(listener);
  }

  setRequestHandler(handler: JsonRpcInboundRequestHandler | undefined): () => void {
    this.assertOpen();
    this.requestHandler = handler;
    return () => {
      if (this.requestHandler === handler) {
        this.requestHandler = undefined;
      }
    };
  }

  setNotificationHandler(handler: JsonRpcInboundNotificationHandler | undefined): () => void {
    this.assertOpen();
    this.notificationHandler = handler;
    return () => {
      if (this.notificationHandler === handler) {
        this.notificationHandler = undefined;
      }
    };
  }

  sendRequest(
    method: string,
    params?: JsonRpcParams,
    options: JsonRpcRequestOptions = {},
  ): JsonRpcRequestHandle {
    this.assertOpen();
    validateMethodAndParams(method, params);
    if (!Number.isSafeInteger(this.nextRequestId)) {
      const error = new JsonRpcPeerError(
        "request_id_exhausted",
        "JSON-RPC numeric request ID space exhausted",
        true,
      );
      this.terminate({ type: "request_id_exhausted" }, error);
      throw error;
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new JsonRpcPeerError(
        "pending_request_limit",
        `pending JSON-RPC request limit ${this.maxPendingRequests} reached`,
      );
    }

    const responseTimeoutMs =
      options.responseTimeoutMs === null
        ? null
        : positiveSafeInteger(
            options.responseTimeoutMs ?? options.timeoutMs ?? this.requestTimeoutMs,
            "responseTimeoutMs",
          );
    const writeTimeoutMs = positiveSafeInteger(
      options.writeTimeoutMs ?? this.writeTimeoutMs,
      "writeTimeoutMs",
    );
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.highestIssuedRequestId = id;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message["params"] = params;
    }
    const frame = encodeOutbound(message);
    const deferred = createDeferred<JsonValue>();
    this.pending.set(id, { deferred, id, method, responseTimer: undefined });

    const write = this.writeFrame(frame, "request", id, writeTimeoutMs);
    void write.then(
      () => {
        if (responseTimeoutMs !== null) {
          this.startResponseTimer(id, responseTimeoutMs);
        }
      },
      () => undefined,
    );
    // Handles are independently observable. Internal handlers prevent either ignored branch from
    // becoming an unhandled rejection while preserving rejection for callers that await it.
    void write.catch(() => undefined);
    void deferred.promise.catch(() => undefined);
    return { id, write, response: deferred.promise };
  }

  sendNotification(
    method: string,
    params?: JsonRpcParams,
    options: { readonly writeTimeoutMs?: number } = {},
  ): Promise<JsonRpcWriteReceipt> {
    this.assertOpen();
    validateMethodAndParams(method, params);
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message["params"] = params;
    }
    const operation = this.writeFrame(
      encodeOutbound(message),
      "notification",
      undefined,
      positiveSafeInteger(
        options.writeTimeoutMs ?? this.writeTimeoutMs,
        "writeTimeoutMs",
      ),
    );
    void operation.catch(() => undefined);
    return operation;
  }

  async receive(input: unknown): Promise<void> {
    this.assertOpen();
    let message: ParsedMessage;
    try {
      message = parseMessage(input);
    } catch {
      this.raiseProtocolFault("invalid_message", "invalid JSON-RPC 2.0 message");
    }

    switch (message.type) {
      case "response_error":
      case "response_result":
        this.routeResponse(message);
        return;
      case "notification":
        await this.routeNotification(message);
        return;
      case "request":
        await this.routeInboundRequest(message);
        return;
    }
  }

  failTransport(fault: JsonRpcTransportFault): boolean {
    if (this.status === "terminal") {
      return false;
    }
    const terminalFault: JsonRpcTerminalFault = { type: "transport_fault", fault };
    const error = new JsonRpcPeerError(
      "transport_fault",
      `terminal JSON-RPC transport fault: ${fault.type}`,
      true,
    );
    this.terminate(terminalFault, error);
    return true;
  }

  close(reason = "peer closed explicitly"): boolean {
    return this.failTransport({ type: "explicit_close", reason });
  }

  private routeResponse(
    message: Extract<ParsedMessage, { type: "response_error" | "response_result" }>,
  ): void {
    const id = message.id;
    if (typeof id === "number" && this.timeoutTombstones.has(id)) {
      this.emitDiagnostic({ type: "late_response_ignored", requestId: id });
      return;
    }
    const numericId = typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
    const pending = numericId !== undefined && numericId >= 1
      ? this.pending.get(numericId)
      : undefined;
    if (pending === undefined) {
      this.emitDiagnostic(Object.freeze({
        type: "orphan_response_ignored",
        classification:
          numericId !== undefined && numericId >= 1 && numericId <= this.highestIssuedRequestId
            ? "duplicate_or_stale"
            : "unmatched",
        highestIssuedRequestId: this.highestIssuedRequestId,
        pendingMethods: Object.freeze(
          [...this.pending.values()].slice(0, 8).map((request) => request.method.slice(0, 80)),
        ),
        pendingRequestCount: this.pending.size,
        ...(numericId === undefined ? {} : { responseId: numericId }),
        responseIdKind: id === null ? "null" : typeof id as "number" | "string",
        responseType: message.type === "response_error" ? "error" : "result",
      }));
      return;
    }
    this.pending.delete(pending.id);
    if (pending.responseTimer !== undefined) {
      clearTimeout(pending.responseTimer);
      pending.responseTimer = undefined;
    }
    if (message.type === "response_error") {
      pending.deferred.reject(new JsonRpcRemoteError(message.error));
    } else {
      pending.deferred.resolve(message.result);
    }
  }

  private async routeNotification(
    notification: Extract<ParsedMessage, { type: "notification" }>,
  ): Promise<void> {
    const handler = this.notificationHandler;
    if (handler === undefined) {
      return;
    }
    try {
      await handler({ method: notification.method, params: notification.params });
    } catch {
      this.emitDiagnostic({
        type: "notification_handler_failed",
        method: notification.method,
      });
    }
  }

  private async routeInboundRequest(
    request: Extract<ParsedMessage, { type: "request" }>,
  ): Promise<void> {
    const key = rpcIdKey(request.id);
    if (this.activeInboundIds.has(key)) {
      this.raiseProtocolFault(
        "duplicate_inbound_request_id",
        "duplicate in-flight inbound request ID",
      );
    }
    this.activeInboundIds.add(key);
    try {
      let reply: JsonRpcHandlerReply;
      if (this.requestHandler === undefined) {
        reply = {
          type: "error",
          error: { code: -32601, message: "Method not found" },
        };
      } else {
        try {
          reply = await this.requestHandler({
            id: request.id,
            method: request.method,
            params: request.params,
          });
          validateHandlerReply(reply);
        } catch {
          this.emitDiagnostic({
            type: "inbound_handler_failed",
            method: request.method,
          });
          reply = {
            type: "error",
            error: { code: -32603, message: "Internal error" },
          };
        }
      }

      if (this.status === "terminal") {
        return;
      }
      if (reply.type === "no_response") {
        return;
      }
      const response: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: request.id,
      };
      if (reply.type === "error") {
        response["error"] = reply.error;
      } else {
        response["result"] = reply.result;
      }
      await this.writeFrame(
        encodeOutbound(response),
        "response",
        request.id,
        this.writeTimeoutMs,
        (writeReceipt) => {
          this.emitInboundResponseWrite(
            Object.freeze({
              type: "inbound_response_write_completed",
              method: request.method,
              requestId: request.id,
              bytes: writeReceipt.bytes,
              evidence: "local_writer_completion",
              remoteAcceptance: "not_evidenced",
            }),
          );
        },
      );
    } finally {
      this.activeInboundIds.delete(key);
    }
  }

  private expireRequest(id: number, timeoutMs: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    if (pending.responseTimer !== undefined) {
      clearTimeout(pending.responseTimer);
      pending.responseTimer = undefined;
    }
    this.timeoutTombstones.set(id, true);
    while (this.timeoutTombstones.size > this.maxTimeoutTombstones) {
      const oldest = this.timeoutTombstones.keys().next().value as number | undefined;
      if (oldest === undefined) {
        break;
      }
      this.timeoutTombstones.delete(oldest);
    }
    pending.deferred.reject(
      new JsonRpcPeerError(
        "request_timeout",
        `JSON-RPC request ${id} timed out after ${timeoutMs} ms`,
      ),
    );
    this.emitDiagnostic({ type: "request_timed_out", requestId: id, timeoutMs });
  }

  private startResponseTimer(id: number, timeoutMs: number): void {
    const pending = this.pending.get(id);
    if (this.status === "terminal" || pending === undefined) {
      return;
    }
    const timer = setTimeout(() => this.expireRequest(id, timeoutMs), timeoutMs);
    timer.unref();
    pending.responseTimer = timer;
  }

  private writeFrame(
    frame: string,
    messageType: JsonRpcWriteReceipt["messageType"],
    requestId: JsonRpcId | undefined,
    timeoutMs: number,
    complete?: (receipt: JsonRpcWriteReceipt) => void,
  ): Promise<JsonRpcWriteReceipt> {
    const controller = new AbortController();
    const deferred = createDeferred<JsonRpcWriteReceipt>();
    const pending: PendingWrite = {
      complete,
      controller,
      deferred,
      frameBytes: Buffer.byteLength(frame),
      messageType,
      requestId,
      timeoutMs,
      timer: undefined,
    };
    this.pendingWrites.add(pending);
    const timer = setTimeout(() => this.expireWrite(pending), timeoutMs);
    timer.unref();
    pending.timer = timer;

    let operation: Promise<unknown>;
    try {
      operation = this.writer(frame, controller.signal);
    } catch {
      this.failWrite(pending);
      return deferred.promise;
    }
    void operation.then(
      () => this.completeWrite(pending),
      () => this.failWrite(pending),
    );
    return deferred.promise;
  }

  private completeWrite(pending: PendingWrite): void {
    if (!this.pendingWrites.delete(pending)) {
      return;
    }
    this.clearWriteTimer(pending);
    const receipt: JsonRpcWriteReceipt = {
      type: "write_completed",
      messageType: pending.messageType,
      requestId: pending.requestId,
      bytes: pending.frameBytes,
      evidence: "local_writer_completion",
      remoteAcceptance: "not_evidenced",
    };
    pending.complete?.(receipt);
    pending.deferred.resolve(receipt);
  }

  private failWrite(pending: PendingWrite): void {
    if (!this.pendingWrites.has(pending)) {
      return;
    }
    const error = new JsonRpcPeerError(
      "write_failed",
      "local JSON-RPC frame write failed; delivery is uncertain",
      true,
    );
    this.terminate(
      {
        type: "transport_fault",
        fault: { type: "write_failure", reason: "local writer rejected" },
      },
      error,
    );
  }

  private expireWrite(pending: PendingWrite): void {
    if (!this.pendingWrites.has(pending)) {
      return;
    }
    const error = new JsonRpcPeerError(
      "write_timeout",
      `local JSON-RPC frame write did not settle within ${pending.timeoutMs} ms; delivery is uncertain`,
      true,
    );
    this.terminate(
      {
        type: "transport_fault",
        fault: { type: "write_timeout", timeoutMs: pending.timeoutMs },
      },
      error,
    );
  }

  private clearWriteTimer(pending: PendingWrite): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  private raiseProtocolFault(
    code: JsonRpcProtocolFaultCode,
    message: string,
  ): never {
    const fault: JsonRpcTerminalFault = { type: "protocol_fault", code };
    const error = new JsonRpcPeerError("protocol_fault", message, true);
    this.terminate(fault, error);
    throw error;
  }

  private terminate(fault: JsonRpcTerminalFault, error: JsonRpcPeerError): void {
    if (this.status === "terminal") {
      return;
    }
    this.status = "terminal";
    this.currentTerminalFault = fault;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      if (request.responseTimer !== undefined) {
        clearTimeout(request.responseTimer);
        request.responseTimer = undefined;
      }
      request.deferred.reject(error);
    }
    const pendingWrites = [...this.pendingWrites];
    this.pendingWrites.clear();
    for (const write of pendingWrites) {
      this.clearWriteTimer(write);
      write.controller.abort();
      write.deferred.reject(error);
    }
    this.activeInboundIds.clear();
    this.emitDiagnostic({ type: "terminal_fault", fault });
    this.requestHandler = undefined;
    this.notificationHandler = undefined;
    this.inboundResponseWriteListeners.clear();
    this.diagnosticListeners.clear();
  }

  private emitInboundResponseWrite(
    receipt: JsonRpcInboundResponseWriteReceipt,
  ): void {
    for (const listener of [...this.inboundResponseWriteListeners]) {
      try {
        listener(receipt);
      } catch {
        // Receipt observers cannot affect protocol state or write truth.
      }
    }
  }

  private emitDiagnostic(diagnostic: JsonRpcDiagnostic): void {
    for (const listener of [...this.diagnosticListeners]) {
      try {
        listener(diagnostic);
      } catch {
        // Diagnostic observers cannot affect protocol state.
      }
    }
  }

  private assertOpen(): void {
    if (this.status === "terminal") {
      throw new JsonRpcPeerError("peer_closed", "JSON-RPC peer is terminal", true);
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateMethodAndParams(method: string, params: JsonRpcParams | undefined): void {
  if (typeof method !== "string") {
    throw new JsonRpcPeerError(
      "invalid_outbound_message",
      "JSON-RPC method must be a string",
    );
  }
  if (params !== undefined && !Array.isArray(params) && !isNonArrayObject(params)) {
    throw new JsonRpcPeerError(
      "invalid_outbound_message",
      "JSON-RPC params must be an array or object",
    );
  }
  if (params !== undefined) {
    try {
      assertJsonValue(params);
    } catch {
      throw new JsonRpcPeerError(
        "invalid_outbound_message",
        "JSON-RPC params are not strict JSON",
      );
    }
  }
}

function encodeOutbound(message: Record<string, unknown>): string {
  try {
    return encodeNdjson(message);
  } catch {
    throw new JsonRpcPeerError(
      "invalid_outbound_message",
      "outbound JSON-RPC message is not strict JSON",
    );
  }
}

function parseMessage(input: unknown): ParsedMessage {
  assertJsonValue(input);
  if (!isNonArrayObject(input)) {
    throw new TypeError("JSON-RPC message must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0") {
    throw new TypeError("jsonrpc must be 2.0");
  }

  const hasMethod = hasOwn(record, "method");
  const hasId = hasOwn(record, "id");
  const hasParams = hasOwn(record, "params");
  const hasResult = hasOwn(record, "result");
  const hasError = hasOwn(record, "error");

  if (hasMethod) {
    if (typeof record["method"] !== "string" || hasResult || hasError) {
      throw new TypeError("invalid JSON-RPC request shape");
    }
    const params = parseParams(record["params"], hasParams);
    if (!hasId) {
      return { type: "notification", method: record["method"], params };
    }
    const id = parseId(record["id"]);
    return { type: "request", id, method: record["method"], params };
  }

  if (!hasId || hasParams || hasResult === hasError) {
    throw new TypeError("invalid JSON-RPC response shape");
  }
  const id = parseId(record["id"]);
  if (hasError) {
    return { type: "response_error", id, error: parseErrorObject(record["error"]) };
  }
  return { type: "response_result", id, result: record["result"] as JsonValue };
}

function parseParams(value: unknown, present: boolean): JsonRpcParams | undefined {
  if (!present) {
    return undefined;
  }
  if (!Array.isArray(value) && !isNonArrayObject(value)) {
    throw new TypeError("JSON-RPC params must be structured");
  }
  return value as JsonRpcParams;
}

function parseId(value: unknown): JsonRpcId {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  throw new TypeError("invalid JSON-RPC id");
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  assertJsonValue(value);
  if (!isNonArrayObject(value)) {
    throw new TypeError("JSON-RPC error must be an object");
  }
  const code = value["code"];
  const message = value["message"];
  if (typeof code !== "number" || !Number.isSafeInteger(code) || typeof message !== "string") {
    throw new TypeError("invalid JSON-RPC error object");
  }
  if (hasOwn(value, "data")) {
    return { code, message, data: value["data"] as JsonValue };
  }
  return { code, message };
}

function validateHandlerReply(reply: unknown): asserts reply is JsonRpcHandlerReply {
  if (!isNonArrayObject(reply)) {
    throw new TypeError("handler reply must be an object");
  }
  if (reply["type"] === "result" && hasOwn(reply, "result")) {
    assertJsonValue(reply["result"]);
    return;
  }
  if (reply["type"] === "error" && hasOwn(reply, "error")) {
    parseErrorObject(reply["error"]);
    return;
  }
  if (
    hasOwn(reply, "type") &&
    hasOwn(reply, "reason") &&
    reply["type"] === "no_response" &&
    reply["reason"] === "abandoned" &&
    Object.keys(reply).length === 2
  ) {
    return;
  }
  throw new TypeError("invalid handler reply");
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function rpcIdKey(id: JsonRpcId): string {
  if (id === null) {
    return "null";
  }
  return `${typeof id}:${String(id)}`;
}
