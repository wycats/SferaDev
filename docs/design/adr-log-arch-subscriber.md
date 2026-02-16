# ADR: Investigation Logger as Event Source with Subscribers

Date: 2026-02-15
Status: Accepted

## Context

Investigation logging is request-scoped today (startRequest -> recordEvent -> completeRequest).
We need a unified event stream so multiple sinks (file capture, output channel,
future telemetry) can consume the same events without coupling to request handles.
Tree-change diagnostics and non-request lifecycle events also need a common
interface so they can be emitted outside request lifecycles.

## Decision

- Define a unified `InvestigationEvent` union with a shared identity base
  (sessionId, conversationId, chatId, parentChatId, agentTypeHash) and a
  discriminator (`kind`).
- Treat `InvestigationLogger` as the event source for the extension, with
  subscribers registered via `subscribe()` and invoked for every emitted event.
- Allow events to be emitted from both request handles (request-scoped) and
  directly from `InvestigationLogger` (non-request events).
- Keep request handles focused on logging and event emission, while subscribers
  format or persist output.

## Consequences

- All event producers must supply the shared identity fields, even when some
  values are not meaningful (use consistent defaults where needed).
- Output channel and other sinks can subscribe once and receive a complete,
  ordered stream across all requests.
- New event categories can be added without changing subscriber wiring.

## Alternatives Considered

- Separate subscribers per request handle: rejected because it prevents a
  global output channel view and complicates non-request events.
- Dedicated event bus service: rejected for now to keep the surface area small
  and reuse the existing InvestigationLogger ownership.
