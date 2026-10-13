# Security Policy

Guild is a local desktop client. It must not become a shared gateway, extract
Grok credentials, or read Claude or Codex credentials. Grok model requests come only from the
official user-installed `grok` process. Codex task requests come from the
user-installed Codex adapter and its Codex core. Gemini task requests come from the
user-installed Gemini CLI, on an API key you designate that Guild reads only in memory and sends
only to `generativelanguage.googleapis.com`, never a Google account login. Claude task requests come from the
user-installed `claude`; Online and Local models are reached only through a
loopback-only, single-user router on `127.0.0.1`.

Please report a suspected vulnerability through this repository's private
security-advisory flow when available. Do not include passwords, tokens,
cookies, private prompts, local file contents, or other personal data in a
public issue. If the private flow is unavailable, open a minimal public issue
asking the maintainer to establish a private contact channel.

Supported security fixes target the latest source release. Reproduction steps
should use synthetic data and should identify the affected Guild version and
macOS version without attaching personal diagnostics.
