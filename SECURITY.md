# Security Policy

Guild is a local desktop client. It must not become a shared gateway, extract
Grok credentials, or send model requests outside the official user-installed
`grok` process.

Please report a suspected vulnerability through this repository's private
security-advisory flow when available. Do not include passwords, tokens,
cookies, private prompts, local file contents, or other personal data in a
public issue. If the private flow is unavailable, open a minimal public issue
asking the maintainer to establish a private contact channel.

Supported security fixes target the latest source release. Reproduction steps
should use synthetic data and should identify the affected Guild version and
macOS version without attaching personal diagnostics.
