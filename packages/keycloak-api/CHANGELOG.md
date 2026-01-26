# keycloak-api

## 0.3.0

### Minor Changes

- f930fc9: Added new organization invitation endpoints: list, get, delete, and resend invitations for organizations.
- 887cbe1: Added new workflows API endpoints and types for managing workflows in admin realms.
- 887cbe1: Added types and endpoints for organization invitations.
- 74ad091: Migrate OpenAPI clients to SferaDev monorepo with improved build configuration, updated dependencies, and enhanced TypeScript support.
- 887cbe1: Added postAdminRealmsRealmIdentityProviderUploadCertificate API for uploading identity provider certificates.

### Patch Changes

- f930fc9: Removed the optional 'address' property from AccessToken and IDToken types.
- 887cbe1: Added 'capability' and 'type' filters to GetAdminRealmsRealmIdentityProviderInstancesQueryParams.
- 0075a59: Update some export types in schemas.ts to use void instead of undefined for better type semantics.
- 887cbe1: Updated AccessToken and IDToken address property to a generic object instead of AddressClaimSet.
- 887cbe1: Added webOrigins field to ClientInitialAccessCreatePresentation type.
- 887cbe1: Extended CertificateRepresentation with jwks property.
- 887cbe1: Updated and extended workflow-related types and fields, including WorkflowRepresentation and related subtypes.
- 0075a59: Refactor import statements and API method signatures in account and admin components for greater consistency and clarity.
- 887cbe1: Expanded IdentityProviderRepresentation with 'types' property.

## 0.2.6

### Patch Changes

- 9301bf7: Add subGroupsCount parameter to GetAdminRealmsRealmGroupsQueryParams

## 0.2.5

### Patch Changes

- fa00357: Change dateFrom and dateTo to accept timestamps in milliseconds

## 0.2.4

### Patch Changes

- 0ffd14e: Add new query parameters 'direction', 'resourceType', and 'audience' to several endpoint definitions

## 0.2.3

### Patch Changes

- e9199f6: Remove realm from account pathParams

## 0.2.2

### Patch Changes

- 44ab118: Add accept header

## 0.2.1

### Patch Changes

- ae275d0: Export extra

## 0.2.0

### Minor Changes

- 7bbd2fd: Add account API

## 0.1.0

### Minor Changes

- 35374e2: Update bundle mechanism
