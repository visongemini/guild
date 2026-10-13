# Security Policy

Guild is a local desktop client. It must not become a shared gateway, extract
Grok credentials, or read Claude or Codex credentials. Grok model requests come only from the
official user-installed `grok` process. Codex task requests come from the
user-installed Codex adapter and its Codex core. Claude task requests come from the
user-installed `claude`; Online and Local models are reached only through a
loopback-only, single-user router on `127.0.0.1`.

## What the file checks trust

Guild runs programs the user installed (`node`, the Claude and Codex adapters, `claude`, the Codex core) and copies what it can
into a private staging directory before running it. It trusts the user and root. Its checks defend against other accounts that can
write those files, or a folder above them, through ownership or mode bits without the user having done anything for it: for
example every administrator account through the shared `admin` group of a Homebrew prefix, or a folder writable by group or
others. Files that cannot be copied (the `claude` binary, the adapter packages, the Codex core) must be owned by the user or root,
with every folder above them, and writable by neither group nor others; a Homebrew-owned install is refused with a message that
names the path.

Write access that the user or root granted to another account by an access control list (ACL) is treated like trusting that
account with the user's files: it could equally edit the user's shell profile or a LaunchAgent. Guild reads owner and mode bits only
and does not parse ACLs. This is a stated limit of the design. Guild also does not defend against root, the user, or anything that
already runs as the user.

Please report a suspected vulnerability through this repository's private
security-advisory flow when available. Do not include passwords, tokens,
cookies, private prompts, local file contents, or other personal data in a
public issue. If the private flow is unavailable, open a minimal public issue
asking the maintainer to establish a private contact channel.

Supported security fixes target the latest source release. Reproduction steps
should use synthetic data and should identify the affected Guild version and
macOS version without attaching personal diagnostics.
