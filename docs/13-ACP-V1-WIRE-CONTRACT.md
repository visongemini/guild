# ACP v1 wire contract for the official Grok adapter

## Version rule

Guild implements the stable ACP version negotiated by the installed official process. The
2026-08-26 runtime negotiated protocol v1. ACP v2 remains a draft and its required message IDs or
other changed semantics must not leak into the v1 adapter.

The client starts with the smallest truthful capability surface:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {}
}
```

Guild adds filesystem, terminal, authentication-terminal, or other callbacks only after that exact
capability is implemented, workspace-scoped, permission-gated, and contract-tested.

## Authentication and session creation

After `initialize`, select only one advertised authentication method and send:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {"methodId": "cached_token"}
}
```

The literal method is an example from the measured runtime, not a hard-coded choice. If no usable
non-interactive method is advertised, Guild presents a user-initiated official-login action. Guild
does not open the credential source.

Create a session only after authentication:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/new",
  "params": {"cwd": "/absolute/project/path", "mcpServers": []}
}
```

The returned `sessionId` is opaque. `cwd` is canonical, absolute, and already authorized by the
workspace picker. Additional directories are omitted unless both the negotiated capability and the
installed Grok behavior pass a dedicated probe.

## Resume and load

Call `session/resume` only when `agentCapabilities.sessionCapabilities.resume` is present:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/resume",
  "params": {
    "sessionId": "opaque-session-id",
    "cwd": "/absolute/project/path",
    "mcpServers": []
  }
}
```

The response may be empty or include optional mode/config state. Standard v1 does not require a
top-level returned session ID. Before the response, the agent must not replay conversation history.
Non-history state such as the measured commands update is not appended to the timeline.

Call `session/load` only when `agentCapabilities.loadSession` is true and resume is unavailable or
has failed under an explicit recovery policy:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/load",
  "params": {
    "sessionId": "opaque-session-id",
    "cwd": "/absolute/project/path",
    "mcpServers": []
  }
}
```

Every `session/update` received after writing that request and before its response is
`ingestMode=replay`. The agent must replay history before responding. Guild stages those updates
behind the response barrier, disables side effects, and reconciles them against local history.
xAI's optional `noReplay` metadata extension is not used in the first adapter because standard
resume passed and the extension has not been independently accepted for this product path.

## Prompt cancellation

`session/cancel` is a notification and has no request ID:

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {"sessionId": "opaque-session-id"}
}
```

Guild first persists `cancel_requested`, then writes the notification. Writing it is not terminal
evidence. Correctly identified `session/update` notifications may still arrive and are admitted
while the original prompt is pending. The Run terminalizes only when the original prompt request
responds, for example:

```json
{
  "jsonrpc": "2.0",
  "id": 77,
  "result": {"stopReason": "cancelled"}
}
```

Pending permission requests receive ACP's cancelled outcome. Capability-gated `session/close` is a
separate request for closing active session resources; it is not a substitute terminal result for
an owned prompt Run.

## Message IDs

In ACP v1, `messageId` is optional on `user_message_chunk`, `agent_message_chunk`, and
`agent_thought_chunk`. When present, it is agent-generated, opaque, unique per message within a
session, and stable across chunks of that message. It is not guaranteed to remain the same across
separate `session/load` operations. The measured Grok runtime omitted it from all eligible live and
replay updates. Guild may use a present ID as an in-stream grouping hint, never as a required field,
database primary key, or sole replay-deduplication key.

## Compatibility discipline

- Negotiate every process epoch; do not cache capabilities across binary changes.
- Parse standard optional response fields and ignore accepted extension fields without depending on
  them.
- Reject malformed standard fields, wrong session IDs, stale epochs, and unrequested callback
  capabilities.
- Never infer account usage, media prompts, extra directories, or session operations merely because
  another Grok version or generic ACP implementation supports them.

Official references:

- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation
- https://agentclientprotocol.com/protocol/v1/cancellation
- https://agentclientprotocol.com/rfds/message-id
- https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.21.0
- https://github.com/xai-org/grok-build/commit/77cd7eb675ba911c225c3aaeeece3a20cbccc426
