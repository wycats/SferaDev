# RFCs: Vercel VS Code AI Gateway Extension

This directory contains Request for Comments (RFC) documents for converting the SferaDev VS Code AI Gateway extension into an official Vercel extension.

RFCs are organized by stage using subdirectories:

- **stage-0/** — Draft proposals (0 - Proposing)
- **stage-1/** — Under review (1 - Reviewing)
- **stage-2/** — Accepted (2 - Accepting)
- **stage-3/** — Implemented (3 - Implementing)
- **stage-4/** — Rejected (4 - Rejected)
- **withdrawn/** — Previously proposed, no longer relevant

## Stage 0: Draft (10 RFCs)

| RFC                                                 | Title                                 | Status      | Summary                                             | Depends On                                                                               |
| --------------------------------------------------- | ------------------------------------- | ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [003a](./stage-0/003a-streaming-adapter.md)         | Streaming Adapter Extraction          | Implemented | Extract stream adapter and chunk handling           | [ref](./stage-0/ref-stream-mapping.md)                                                   |
| [003b](./stage-0/003b-token-estimation.md)          | Token Estimation & Message Conversion | Implemented | Hybrid token estimation, message conversion, MIME   | —                                                                                        |
| [008](./stage-0/008-high-fidelity-model-mapping.md) | High-Fidelity Model Mapping           | Draft       | Accurate model identity, token limits, capabilities | —                                                                                        |
| [001](./stage-0/001-standalone-repository.md)       | Standalone Repository                 | Draft       | Extract to vercel/vscode-ai-gateway                 | [007](./stage-0/007-migration-deprecation.md)                                            |
| [002](./stage-0/002-branding-identity.md)           | Branding and Identity                 | Draft       | Rebrand from SferaDev to Vercel                     | [007](./stage-0/007-migration-deprecation.md)                                            |
| [007](./stage-0/007-migration-deprecation.md)       | Migration & Deprecation               | Draft       | Settings migration, deprecation plan                | [001](./stage-0/001-standalone-repository.md), [002](./stage-0/002-branding-identity.md) |
| [005b](./stage-0/005b-authentication.md)            | Authentication                        | Draft       | OIDC and API key auth                               | [stage-1/005a](./stage-1/005a-configuration-logging.md)                                  |
| [005c](./stage-0/005c-telemetry-privacy.md)         | Telemetry & Privacy                   | Draft       | Telemetry schema and retention                      | [stage-1/005a](./stage-1/005a-configuration-logging.md)                                  |
| [004](./stage-0/004-openresponses-integration.md)   | OpenResponses Integration             | Draft       | OpenResponses API support                           | —                                                                                        |
| [ref](./stage-0/ref-stream-mapping.md)              | Stream Feature Mapping                | Reference   | Stream chunk mapping, fix plan                      | —                                                                                        |

## Stage 1: Reviewing (1 RFC)

| RFC                                             | Title                   | Status           | Summary                                      | Depends On |
| ----------------------------------------------- | ----------------------- | ---------------- | -------------------------------------------- | ---------- |
| [005a](./stage-1/005a-configuration-logging.md) | Configuration & Logging | Ready for Review | Configuration schema, model filters, logging | —          |

## Stage 2: Accepted

(Empty - ready for promotion from Stage 1)

## Stage 3: Implemented

(Empty - will be populated as RFCs complete)

## Stage 4: Rejected

(Empty - reserved for rejected proposals)

## Withdrawn

- [003-streaming-package.md.archived](./withdrawn/003-streaming-package.md.archived)
- [005-configuration-enterprise.md.archived](./withdrawn/005-configuration-enterprise.md.archived)

## Dependencies

- RFC 007 consolidates migration and deprecation steps referenced by RFC 001 and RFC 002.
- RFC 005b (stage-0) and RFC 005c (stage-0) build on RFC 005a (stage-1).
- RFC 003a (stage-0) relies on stream mapping reference in [ref](./stage-0/ref-stream-mapping.md).

## RFC Promotion Process

When promoting an RFC:

1. The `exo rfc promote <ID>` command automatically moves the file to the next stage directory
2. Update this README to reflect the new stage location
3. The CLI maintains the RFC's metadata through promotion

**Example:** RFC 005a was promoted from stage-0 to stage-1 and automatically moved from `stage-0/005a-configuration-logging.md` to `stage-1/005a-configuration-logging.md`

## RFC Lifecycle

1. **Draft** — Initial proposal, open for discussion
2. **Review** — Under active review by stakeholders
3. **Accepted** — Approved for implementation
4. **Implemented** — Completed and released
5. **Rejected** — Not moving forward (with rationale)

## Contributing

To propose a new RFC:

1. Copy the template below
2. Create a new file: `NNN-short-title.md`
3. Fill in all sections
4. Open a PR for discussion

### RFC Template

```markdown
# RFC NNN: Title

**Status:** Draft  
**Author:** [Your Name]  
**Created:** YYYY-MM-DD  
**Updated:** YYYY-MM-DD

## Summary

[One paragraph summary]

## Motivation

[Why is this needed?]

## Detailed Design

[Technical details, code examples, diagrams]

## Drawbacks

[Potential downsides]

## Alternatives

[Other approaches considered]

## Unresolved Questions

[Open questions for discussion]

## Implementation Plan

[Phases, milestones, timeline]
```

## Related Resources

- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [Vercel AI Gateway Documentation](https://vercel.com/docs/ai-gateway)
- [OpenResponses Specification](https://openresponses.org/)
- [Vercel AI SDK](https://ai-sdk.dev/)
