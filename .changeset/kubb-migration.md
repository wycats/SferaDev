---
"keycloak-api": major
"litellm-api": major
"netlify-api": major
"nuki-api-js": major
"zoom-api-js": major
---

Migrate from openapi-codegen to kubb for code generation.

Breaking changes:
- Generated code is now in `./src/generated/` instead of `./src/api/` or other locations
- Export structure changed: now exports `Fetchers`, `Helpers`, `Schemas`, `Types` instead of previous structure
- New MCP (Model Context Protocol) support with optional peer dependency on `@modelcontextprotocol/sdk`
- `FetcherExtraProps` renamed to `FetcherConfig`
- Added new type exports: `ApiClient`, `ApiOperation`, `ApiOperationParams`, `ApiOperationResult`, `ApiOperationByMethod`
