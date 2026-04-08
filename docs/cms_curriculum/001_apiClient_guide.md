# CMS Admin Tool — User Guide: API Client

**Guide Number:** 001
**File:** public/cms/js/apiClient.js
**Belt Level:** Green Belt (intermediate infrastructure)
**Prerequisite Knowledge:** What an API is, what HTTP requests are, basic JavaScript

---

## What Is This File?

The API Client is the messenger between the admin tool in your browser and the server that stores all of The Expanse's data. Every time you click something in the admin panel — view a list of characters, save an edit, upload an image — the API Client is the thing that actually sends that request to the server and brings back the answer.

Think of it like a postal service. The admin panel writes a letter ("give me all the characters"), hands it to the API Client, and the API Client delivers it to the server, waits for the reply, and brings it back.

---

## Why Does It Exist?

Without this file, every single part of the admin tool would need to write its own code for talking to the server. That means repeating the same auth handling, error handling, and URL encoding dozens of times. The API Client centralises all of that into one place. Change it here, it changes everywhere.

---

## What Does It Do?

### 1. Sends Requests to the Server

Five types of request, matching the five things you can do with data:

| Method | What It Does | Example |
|--------|-------------|---------|
| GET | Fetch data (read only) | Load the list of characters |
| POST | Create something new | Add a new character |
| PUT | Update something existing | Change a character's name |
| DELETE | Remove something | Delete a relationship link |
| UPLOAD | Send a file | Upload a character portrait |

### 2. Handles Hex ID Encoding

Every entity in The Expanse has a hex colour code ID like #700002. The problem is that the hash symbol has a special meaning in URLs (it marks a page anchor). So the API Client automatically converts every # to %23 before sending the URL to the server.

You never need to think about this. Just pass the hex ID as-is:
apiClient.get('/characters/#700002')

The client converts it to /api/admin/characters/%23700002 behind the scenes.

### 3. Handles Authentication

The admin tool uses cookie-based sessions. When you log in, the server sets a secure cookie in your browser. The API Client includes that cookie with every request automatically by setting credentials to same-origin. You never need to manage tokens or passwords in your code.

If your session expires (you have been idle too long), the server returns a 401 status code. The API Client catches this and redirects you to the login page automatically.

### 4. Handles Errors

Different errors get different treatment:

| Status Code | What It Means | What Happens |
|-------------|--------------|--------------|
| 401 | Session expired | Redirects to login page |
| 403 | Not authorised | Throws error with message |
| 400 | Bad request (your data was wrong) | Throws error with details from server |
| 500+ | Server crashed | Retries automatically (see below) |
| Timeout | Server took too long | Throws error after time limit |
| Abort | You navigated away | Returns null (silently cancelled) |

### 5. Retries Failed Requests

If the server returns a 500 error (it crashed or had a temporary problem), the API Client does not give up immediately. For safe requests (GET, PUT, DELETE), it waits and tries again:

- First retry: waits 1 second
- Second retry: waits 2 seconds
- If still failing after 2 retries: gives up and shows the error

POST and file uploads are NOT retried because they are not safe to repeat (you might create duplicate records).

### 6. Prevents Duplicate Requests

If two parts of the admin tool both request GET /characters at the exact same moment, the API Client only sends ONE request to the server. Both parts receive the same result. This prevents unnecessary server load and avoids race conditions.

### 7. Enforces Timeouts

Every request has a maximum time limit:

- Normal requests: 15 seconds
- File uploads: 120 seconds (2 minutes)

If the server does not respond within that time, the request is cancelled and an error is thrown. This prevents the admin tool from appearing to hang forever if the server is unresponsive.

### 8. Tracks Performance Metrics

The API Client silently records statistics about every request:

- Total number of requests made
- Total errors encountered
- Total retries attempted
- Total deduplicated requests
- Total timeouts
- Average and maximum response times
- Count of each HTTP status code received

These metrics are available via apiClient.getMetrics() and can be displayed in the system administration panel for diagnostics.

---

## How Other Files Use It

Every view module in the admin tool imports and uses the API Client the same way:
import apiClient from '../apiClient.js';
// Fetch a list
const characters = await apiClient.get('/characters');
// Fetch a single item
const claude = await apiClient.get('/characters/#700002');
// Create something new
await apiClient.post('/characters', { character_name: 'New Character' });
// Update something
await apiClient.put('/characters/#700002', { character_name: 'Claude' });
// Delete something
await apiClient.delete('/knowledge-relationships/#AB0001');
// Upload a file
await apiClient.upload('/assets/upload', fileObject, { description: 'Portrait' });
// Check diagnostics
const stats = apiClient.getMetrics();

---

## Key Concepts for Teaching

### Concept 1: Centralised Communication
All server communication goes through one file. This is called the Single Responsibility Principle — one file does one job.

### Concept 2: Hex ID Safety
The # in hex IDs must be encoded as %23 in URLs. The API Client does this automatically so callers never need to remember.

### Concept 3: Idempotent vs Non-Idempotent
GET, PUT, and DELETE are idempotent — doing them twice produces the same result. POST is not — doing it twice creates two records. This is why only idempotent requests are retried on failure.

### Concept 4: Request Deduplication
When identical requests happen simultaneously, sharing a single promise prevents wasted server resources and ensures consistent data across the UI.

### Concept 5: Exponential Backoff
When retrying, each wait is longer than the last (1s, 2s, 4s). This gives a struggling server time to recover instead of hammering it with immediate retries.

### Concept 6: AbortController
JavaScript built-in mechanism for cancelling fetch requests. The API Client uses it for both timeouts (internal cancellation) and view changes (external cancellation via signal).

---

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| API_BASE | /api/admin | Base URL for all admin API calls |
| DEFAULT_TIMEOUT_MS | 15000 | 15 second timeout for normal requests |
| UPLOAD_TIMEOUT_MS | 120000 | 2 minute timeout for file uploads |
| DEFAULT_RETRIES | 2 | Maximum retry attempts for idempotent requests |
| BACKOFF_BASE_MS | 1000 | Base delay between retries (doubles each time) |

---

## Troubleshooting

### Session expired redirect
Your login session timed out. Log in again. This is normal after extended idle periods.

### Insufficient privileges
Your account does not have access_level 11 (admin). Contact the system administrator.

### Request timed out
The server did not respond within the time limit. Check that the backend is running. Check the server logs for errors.

### HTTP 400 with details
The data you submitted was invalid. Read the error details — they will tell you which field failed validation and why.

### HTTP 500 after retries
The server encountered an internal error that persists across retries. Check the backend logs for stack traces.

---

## File Location
public/cms/js/apiClient.js

## Dependencies

None. This file has zero imports. It uses only browser-native APIs (fetch, FormData, AbortController, performance.now).

## Depended On By

Every view module in the admin tool:
- characterManager.js
- knowledgeManager.js
- narrativeManager.js
- curriculumManager.js
- dialogueManager.js
- assetManager.js
- worldManager.js
- tseManager.js
- psychicManager.js
- userManager.js
- systemManager.js

Also used by viewController.js which passes it to view handlers.

---

## Curriculum Metadata
guide_number: 001
file_path: public/cms/js/apiClient.js
title: API Client — The Admin Tool Messenger
belt_level: green_belt
domain: cms_infrastructure
concepts:

centralised_communication
hex_id_url_encoding
idempotent_vs_non_idempotent
request_deduplication
exponential_backoff
abort_controller
cookie_based_auth
request_timeout
performance_metrics
prerequisites:
what_is_an_api
http_request_methods
javascript_async_await
teaches:
how_admin_tool_talks_to_server
why_centralised_http_client
error_handling_patterns
retry_and_resilience

