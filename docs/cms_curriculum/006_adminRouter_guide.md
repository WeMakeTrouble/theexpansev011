# CMS Admin Tool — User Guide: Admin API Router

**Guide Number:** 006
**File:** backend/routes/admin.js
**Belt Level:** Blue Belt (intermediate backend)
**Prerequisite Knowledge:** What a web server is, Guide 005 (Validate Payload), what HTTP routes are

---

## What Is This File?

The Admin API Router is the front gate of the admin backend. When the API Client in the browser sends a request to /api/admin/anything, this is the file that receives it. It checks your security clearance (are you access_level 11?), counts the request for metrics, and sends you to the right department (characters, knowledge, narratives, etc.).

Think of it like the security desk at a restricted government building. You walk in, show your badge (session cookie), the guard checks you have top-level clearance (access_level 11), logs your visit (metrics), and directs you to the correct floor (sub-route).

---

## Why Does It Exist?

Without a central router, every phase's endpoints would need their own security check, their own error handling, and their own metrics. The admin router handles all of that once at the top level. Every sub-route inherits the protection automatically. A new phase cannot accidentally forget to add admin security because the router enforces it before the request ever reaches the phase's code.

---

## What Does It Do?

### 1. Enforces Admin Security on Every Request

The very first thing the router does is run requireAdmin() middleware. This checks that the request has a valid session AND the user has access_level 11 or higher. If not, the request is rejected before it goes any further:

- No session at all: 401 Unauthorized
- Session exists but access level too low: 403 Forbidden
- Session valid and level 11+: request continues

This happens once at the router level, not per-endpoint. Every current and future endpoint is protected automatically.

### 2. Counts Every Request

A lightweight counting middleware runs after the security check. It records:

- Total number of admin API requests
- Count per path (e.g., how many times GET /characters was called)

This helps identify which sections are used most and can reveal unusual patterns (like 1000 requests to the same endpoint in a minute).

### 3. Provides Health and Status Endpoints

Two built-in endpoints for diagnostics:

| Endpoint | What It Returns |
|----------|----------------|
| GET /api/admin/health | Confirms admin API is running, shows your username and access level, version, timestamp |
| GET /api/admin/status | Lists which phase sub-routes are mounted, plus full metrics snapshot |

The /status endpoint is especially useful during development. It tells the frontend exactly which phases are live, so unbuilt sections can show appropriate placeholder messages.

### 4. Routes to Phase Sub-Routers

As each phase is built, its sub-router is imported and mounted at a specific path:

| Phase | Path | What It Handles |
|-------|------|----------------|
| 1 | /characters | Character profiles, traits, personalities, inventory, belts |
| 2 | /knowledge | Domains, items, entities, relationships, mappings |
| 3 | /narratives | Arcs, beats, paths, segments, story arcs |
| 4 | /curricula | Curricula, expectations, hints, misconceptions |
| 5 | /dialogue | LTLM categories, speech acts, narrative functions, outcome intents, emotion registers |
| 6 | /assets | Multimedia assets, attachments, uploads |
| 7 | /world | Locations, objects, multiverse events |
| 8 | /tse | TSE cycles, evaluations, sessions, tasks |
| 9 | /psychic | Moods, frames, proximity, events, radar |
| 10 | /users | COTW dossiers, user data |
| 11 | /system | Hex ranges, features, audit log, ID counters |

All sub-routes are commented out initially and get uncommented one at a time as each phase is completed.

### 5. Catches Errors from Sub-Routes

At the bottom of the router is an error boundary — a special Express middleware with four arguments (err, req, res, next) that catches any unhandled errors thrown by sub-route handlers.

This guarantees:

- Every error response is JSON (never an HTML error page)
- Internal server details are hidden from the client (500 errors say "Internal server error" without stack traces)
- Client errors (400s) pass through the message and details so the frontend can display them
- Every error is logged with the request path, method, username, and correlation ID

Without this, a bug in a sub-route could crash the entire server or leak internal error details to the browser.

### 6. Tracks Metrics

The router records diagnostics accessible via /status or the exported getMetrics() function:

- Total requests received
- Total errors caught
- Time the router started
- Per-path request counts
- Last error details (message, path, method, timestamp)
- Number of mounted sub-routes
- Uptime in seconds

---

## How Sub-Routes Connect

Each phase builds its own Express Router file (e.g., adminCharacters.js). That file defines the specific endpoints (GET /list, PUT /:id, etc.). Then it gets mounted in admin.js with three lines:
import adminCharacters from './adminCharacters.js';
router.use('/characters', adminCharacters);
_mountedRoutes.push({ phase: 1, path: '/characters', name: 'Character Management' });

The sub-route does not need to import requireAdmin because the parent router already applied it. The sub-route does not need its own error handler because the parent router catches errors. The sub-route just focuses on its own logic.

---

## How This Connects to server.js

The admin router is mounted in server.js with one line:
app.use('/api/admin', adminRoutes);

This means all requests to /api/admin/* flow through this router. The /api/admin prefix is added by server.js, so the router internally defines paths like /health, /characters, etc. without repeating the prefix.

---

## Key Concepts for Teaching

### Concept 1: Router-Level Middleware
Middleware applied to a router affects every route on that router, including future ones. This is why requireAdmin() is applied once at the router level instead of on each individual endpoint. It is impossible to accidentally create an unprotected admin endpoint.

### Concept 2: Error Boundary
An error boundary catches errors from code below it. In Express, error-handling middleware has four arguments (err, req, res, next). It must be defined AFTER all routes. This pattern prevents one broken endpoint from crashing the whole server.

### Concept 3: Sub-Router Composition
Express lets you mount routers inside routers. The admin router is mounted in server.js. Phase sub-routers are mounted inside the admin router. This creates a clean hierarchy where each level handles its own concerns (server handles all routes, admin router handles security, sub-routers handle business logic).

### Concept 4: Runtime Introspection
The /status endpoint lets the frontend ask "what phases are available right now?" at runtime. This is better than hardcoding the list in the frontend because it always reflects the actual state of the backend. If Phase 3 is deployed but Phase 4 is not, the frontend knows immediately.

### Concept 5: Client Error vs Server Error
HTTP status codes 400-499 are client errors (the request was wrong). 500-599 are server errors (the server broke). The error boundary treats them differently: client error messages are passed through to the frontend, but server error details are hidden and replaced with a generic message. This prevents leaking internal implementation details.

---

## Troubleshooting

### /api/admin/health returns 401
You are not logged in, or your session expired. Log in first, then retry.

### /api/admin/health returns 403
You are logged in but your account does not have access_level 11. This endpoint requires admin access.

### /api/admin/status shows 0 mounted routes
No phase sub-routers have been uncommented yet. This is normal during early development. The health and status endpoints work regardless of mounted sub-routes.

### Sub-route returns "Internal server error"
The error boundary caught an unhandled error. Check the backend logs for the full error details including the path, method, and stack trace. The client only sees "Internal server error" for security.

### New endpoint not responding
Verify the sub-router is imported, mounted with router.use(), and added to _mountedRoutes in admin.js. Check that the sub-router exports a valid Express Router. Restart the server after changes.

---

## File Location
backend/routes/admin.js

## Dependencies

- express (Router)
- backend/middleware/requireAdmin.js (access_level 11 enforcement)
- backend/utils/logger.js (structured logging)

## Depended On By

- server.js (mounts this router at /api/admin)
- All phase sub-routers (mounted inside this router)

## Exports

- default: Express Router (for mounting in server.js)
- getMetrics: function returning admin API metrics snapshot

---

## Curriculum Metadata

- guide_number: 006
- file_path: backend/routes/admin.js
- title: Admin API Router — The Security Gate
- belt_level: blue_belt
- domain: cms_backend
- concepts: router_level_middleware, error_boundary, sub_router_composition, runtime_introspection, client_vs_server_errors, request_metrics
- prerequisites: what_is_a_web_server, guide_005_validate_payload, http_routes
- teaches: how_admin_api_is_protected, how_phases_connect, error_handling_in_express, admin_api_diagnostics
