# zoom-api-js

## 0.7.0

### Minor Changes

- 74ad091: Migrate OpenAPI clients to SferaDev monorepo with improved build configuration, updated dependencies, and enhanced TypeScript support.

### Patch Changes

- ec0dcc0: Updated descriptions for from and to parameters to clarify time field is specified by time_filter_field.
- ec0dcc0: Added time_filter_field parameter to ListmeetingsummariesQueryParams to specify which summary time field to use for filtering.
- 5d138a3: Added show_join_info setting to Webinar settings objects for controlling if join info appears on the registration confirmation page.
- 5d138a3: Added additional_data_center_regions field to Meeting and Webinar settings for creating, updating, and responding with extra allowed data center regions.
- 1d4a15e: Refactored import statements in extra.ts for improved readability and organization.
- 5d138a3: Added visible property to Webinar tracking field responses indicating portal visibility status.
- 5d138a3: Added template_id field to MeetingResponse, MeetingCreateResponse, WebinarResponse, and WebinarCreateResponse types for tracking meeting and webinar templates used.
- 5d138a3: Added registrants_confirmation_email to WebinarCreateRequestBody settings for sending confirmation emails to webinar registrants.
- 5d138a3: Improved various field descriptions and documentation in WebinarCreateResponse for clarity and consistency.
- 5d138a3: Added registration_url field to MeetingResponse and WebinarResponse types for returning the registration link when registration is enabled.

## 0.6.4

### Patch Changes

- fe9b002: Fix description format for end date parameter.

## 0.6.3

### Patch Changes

- 9d02e30: Add 'push_change_to_calendar' option to MeetingUpdateRequestBody.
- 5ebc0ca: Add getMeetingTranscript API endpoint to retrieve meeting transcripts
- edc8a7c: Add example for the 'userId' field in WebinarCreatePathParams
- fa20faf: [BREAKING] Change type of userId in ReportMeetingsPathParams to a specific string

## 0.6.2

### Patch Changes

- ca1fe30: Add AIC_CONVERSATION type to ListArchivedFilesResponse and GetArchivedFilesResponse.

## 0.6.1

### Patch Changes

- 57f2658: Replace single quotes with double quotes for consistency

## 0.6.0

### Minor Changes

- 8e307db: Added new actions 'pause' and 'resume' to MeetingRTMSStatusUpdateRequestBody.

## 0.5.0

### Minor Changes

- 428dd8e: Add new endpoint to update Real-Time Media Streams (RTMS) status for a specific participant in a meeting

## 0.4.5

### Patch Changes

- 93af0c9: Update URL in comments for double encode UUID
- 58398e6: [BREAKING] Deprecated and replaced legacy meeting summary fields with a unified 'summary_content' field in GetameetingsummaryResponse

## 0.4.4

### Patch Changes

- 71999cd: Add summary_template_id to MeetingResponse, MeetingUpdateRequestBody, MeetingCreateResponse, MeetingCreateRequestBody

## 0.4.3

### Patch Changes

- 6bad508: Change in the meeting UUID description

## 0.4.2

### Patch Changes

- ab0a9f5: Change 'approval type' to 'registration approval type'
- ec9d82c: Update link to List groups API documentation

## 0.4.1

### Patch Changes

- d4c62b3: [OpenAPI] Spec updates for zoom-api-js

## 0.4.0

### Minor Changes

- 547d18b: Add new endpoint to list SIP phones on an account

### Patch Changes

- fb17c28: Fix a typo in the example for telephony report
- c09c7b9: Change meeting API response to include fields for who will receive meeting summary and who can ask questions about meeting transcript

## 0.3.2

### Patch Changes

- a0a2535: Add prerequisites for various endpoints

## 0.3.1

### Patch Changes

- 552b3b0: [OpenAPI] Spec updates for zoom-api-js

## 0.3.0

### Minor Changes

- 4ce9f11: Add new endpoint to assign a device to a new group

## 0.2.0

### Minor Changes

- 35374e2: Update bundle mechanism

## 0.1.3

### Patch Changes

- c62c402: Update spec

## 0.1.2

### Patch Changes

- 9e0fcd1: Update OAuth refresh token logic

## 0.1.1

### Patch Changes

- 9349c03: Add a way to refresh token

## 0.1.0

### Minor Changes

- bc329fc: Initial release
