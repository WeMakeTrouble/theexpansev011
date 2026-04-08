# CMS Admin Tool — User Guide: CMS Bootstrap

**Guide Number:** 004
**File:** public/cms/js/cmsBootstrap.js
**Belt Level:** Green Belt (intermediate infrastructure)
**Prerequisite Knowledge:** Guide 001 (API Client), Guide 002 (View Controller), Guide 003 (Index HTML)

---

## What Is This File?

The CMS Bootstrap is the person who opens the building in the morning. When index.html loads this file, it walks through a checklist: import the API Client, import the View Controller, start the View Controller listening for menu events, then load all the view modules that have been built so far.

Think of it like a stage manager at a theatre. Before the show starts, the stage manager checks that the lights work, the sound system is on, the props are in place, and the actors are ready. The Bootstrap does the same thing for the admin tool.

---

## Why Does It Exist?

We could have put all the initialisation logic directly inside index.html as an inline script. But that would violate our Content Security Policy (which bans inline scripts) and it would mix structure (HTML) with behaviour (JavaScript). The Bootstrap keeps initialisation in its own file where it can be tested, versioned, and modified independently.

It also solves a practical problem: as we build more view modules across 11 phases, each one needs to be imported and loaded. The Bootstrap gives us a single place to manage that growing list.

---

## What Does It Do?

### 1. Imports Core Infrastructure

The Bootstrap imports the View Controller. The API Client is not imported directly here because the View Controller already imports it and passes it to view handlers. The Bootstrap only needs the View Controller to call init().

### 2. Initialises the View Controller

It creates an AbortController (for lifecycle cleanup) and calls viewController.init() with that signal. From this moment on, the View Controller is listening for admin:navigate events from the menu.

### 3. Loads View Modules Dynamically

The Bootstrap has an array called VIEW_MODULES listing every view module file. It uses dynamic import() to load each one. This is different from a static import at the top of the file — dynamic imports happen at runtime and can fail without crashing the whole application.

Each module is loaded independently. If characterManager.js fails to load, knowledgeManager.js still loads fine. This is called error isolation.

### 4. Reports Boot Status

After everything loads, the Bootstrap logs a summary to the browser console:
[CMS Bootstrap] v010.1 ready in 47ms | 5 view handler(s) registered | 5/5 modules loaded

This tells you at a glance whether the admin tool started correctly, how fast it booted, and whether any modules failed.

### 5. Tracks Boot Metrics

The Bootstrap records detailed metrics about the boot process:

- Start and end time
- Number of modules attempted, loaded, and failed
- Details of any failures (module name, path, error message)
- Boot duration in milliseconds

These metrics are accessible via window.__CMS_BOOT_METRICS__() from the browser console for diagnostics.

---

## How New Modules Get Added

When you build a new view module (like characterManager.js in Phase 1), you add it to the VIEW_MODULES array by uncommenting the relevant line:

Before:
// { path: './modules/characterManager.js', name: 'Character Manager' },

After:
{ path: './modules/characterManager.js', name: 'Character Manager' },

That is the only change needed. The Bootstrap handles the rest — importing it, catching any errors, and reporting the result.

---

## The VIEW_MODULES Array

Listed in phase order matching the build plan:

| Phase | Module | File |
|-------|--------|------|
| 1 | Character Manager | modules/characterManager.js |
| 2 | Knowledge Manager | modules/knowledgeManager.js |
| 3 | Narrative Manager | modules/narrativeManager.js |
| 4 | Curriculum Manager | modules/curriculumManager.js |
| 5 | Dialogue Manager | modules/dialogueManager.js |
| 6 | Asset Manager | modules/assetManager.js |
| 7 | World Manager | modules/worldManager.js |
| 8 | TSE Manager | modules/tseManager.js |
| 8 | Psychic Manager | modules/psychicManager.js |
| 9 | User Manager | modules/userManager.js |
| 10 | System Manager | modules/systemManager.js |

All are commented out initially. Each gets uncommented when its phase is complete.

---

## Key Concepts for Teaching

### Concept 1: Dynamic Import
Static imports (import x from './x.js') happen before your code runs. Dynamic imports (await import('./x.js')) happen during your code and can be wrapped in try/catch for error handling. This lets us load modules that might not exist yet without crashing.

### Concept 2: Error Isolation
When loading multiple independent modules, each one should fail independently. A bug in the narrative manager should not prevent the character manager from loading. Promise.allSettled() helps with this — it waits for all promises to complete regardless of whether they succeeded or failed.

### Concept 3: Boot Metrics
Measuring how long initialisation takes and what succeeded or failed gives you diagnostics without needing to open every file. It is the difference between a car dashboard (tells you fuel, speed, engine status at a glance) and having to open the bonnet to check everything manually.

### Concept 4: Single Entry Point
All module loading goes through one file. If you need to change the load order, add a new module, or disable a broken module, you change one file. This is the same centralisation principle as the API Client (one place for HTTP) and View Controller (one place for navigation).

### Concept 5: AbortController Propagation
The Bootstrap creates an AbortController and passes its signal to the View Controller. If the Bootstrap ever needs to shut everything down (page unload, critical error), aborting this controller cascades through the entire system — the View Controller stops listening, active views cancel their requests, and everything cleans up.

---

## Troubleshooting

### Console says 0 view handlers registered
All modules in VIEW_MODULES are still commented out. This is normal until Phase 1 is built. The admin tool works — clicking menu items just shows the "View module not yet built" placeholder.

### Console warns Failed to load [module name]
That module file does not exist or has a syntax error. Check that the file exists at the path shown. Run node --check on the file to verify syntax.

### Console shows no Bootstrap message at all
cmsBootstrap.js failed to load entirely. Check the browser Network tab for 404 errors. Verify the file exists at public/cms/js/cmsBootstrap.js. Check for import errors in apiClient.js or viewController.js (if they fail, Bootstrap cannot start).

### Boot time is very slow (500ms+)
Too many modules loading at once, or a module is doing heavy work during import. View modules should register their handlers during import but defer data fetching until the handler is actually called.

---

## File Location
public/cms/js/cmsBootstrap.js

## Dependencies

- viewController.js (imported and initialised)
- apiClient.js (imported by viewController, not directly by bootstrap)
- All view modules listed in VIEW_MODULES array

## Depended On By

- index.html (loads this file via script tag)

This is the top of the JavaScript dependency chain. Nothing imports cmsBootstrap — it is the root.

---

## Curriculum Metadata

- guide_number: 004
- file_path: public/cms/js/cmsBootstrap.js
- title: CMS Bootstrap — The Stage Manager
- belt_level: green_belt
- domain: cms_infrastructure
- concepts: dynamic_import, error_isolation, boot_metrics, single_entry_point, abort_controller_propagation, promise_all_settled
- prerequisites: guide_001_api_client, guide_002_view_controller, guide_003_index_html
- teaches: how_modules_load, error_isolation_pattern, boot_diagnostics, adding_new_modules
