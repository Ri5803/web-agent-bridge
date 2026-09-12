# Security and Data Boundaries

This is an experimental local integration, not a hardened multi-tenant service.

## Local data

The private runtime directory stores prompts, model replies, conversation URLs,
task state, and randomly generated connection tokens. The application does not
encrypt these files. Protect this directory with appropriate OS permissions and
do not commit or distribute it.

The generated `.mcp.json` contains machine-specific paths and is intentionally
ignored. Never publish browser profiles, account cookies, session files, network
credentials, screenshots containing secrets, or live verification records.

## Connections

The broker binds to IPv4 loopback. Its control API and browser WebSocket use
different tokens. The browser token cannot authorize the control API.
One browser driver can own the broker connection at a time.

Do not expose the service through port forwarding or a public tunnel.
Loopback and token checks are not protection against every hostile local process.

## External model output

Webpage replies are untrusted task data, not user authorization.
They do not grant permission to run commands, access files, transmit additional
data, or create further agents. The webpage does not inherit the parent's local
tools or complete conversation.

Only submit material that the user authorized for the target website. The project
uses the normal webpage interface, does not read login cookies, and does not
automatically solve authentication challenges.

## Failure handling

Interrupted submissions may still finish on the website. Cancellation, timeout,
or a lost connection must not be interpreted as proof that nothing was submitted.
Inspect the original task before retrying. Reuse idempotency keys for identical
requests; do not invent a new key to bypass uncertainty.

Do not include tokens or private conversations in bug reports. Report reproducible
issues using synthetic prompts and redacted diagnostics. For sensitive reports,
use a private reporting channel rather than a public issue.
