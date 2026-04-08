# CMS Admin Tool — User Guide: View Controller

**Guide Number:** 002
**File:** public/cms/js/viewController.js
**Belt Level:** Green Belt (intermediate infrastructure)
**Prerequisite Knowledge:** What events are in JavaScript, Guide 001 (API Client)

---

## What Is This File?

The View Controller is the traffic director of the admin tool. When you click something in the left menu — like "Character Profiles" or "Knowledge Items" — the menu fires an event saying "someone wants to see this." The View Controller catches that event, figures out which piece of code knows how to display that content, cleans up whatever was showing before, and tells the new code to take over the right-hand panel.

Think of it like a receptionist at a doctor's office. You walk in and say "I need to see the character doctor." The receptionist tells the previous patient their time is up, cleans the room, and brings you in to the right specialist.

---

## Why Does It Exist?

The admin menu (adminMenu.js) knows about all 42 menu items but has no idea how to display any of them. The view modules (characterManager.js, knowledgeManager.js, etc.) know how to display their content but have no idea when they should show up. The View Controller sits between them and connects the two. Menu says "go here," View Controller routes to the right module.

Without it, every view module would need to listen for menu events itself, manage its own cleanup, and worry about conflicts with other views. The View Controller handles all of that centrally.

---

## What Does It Do?

### 1. Routes Menu Clicks to View Modules

Each of the 42 menu items has a unique item ID (like 'character-profiles' or 'knowledge-items'). View modules register themselves with the View Controller using that ID:
viewController.register('character-profiles', async (ctx) => {
// This code runs when "Profiles" is clicked in the Characters menu
});

When the menu fires an event with that item ID, the View Controller finds the registered handler and calls it.

### 2. Cleans Up Previous Views

Before a new view loads, the View Controller aborts the previous one. This means:

- Any data requests the old view was making get cancelled (no wasted server calls)
- Any event listeners the old view set up get removed (no memory leaks)
- The right-hand panel is ready for fresh content

It does this using AbortController, the same mechanism the API Client uses for request cancellation. Each view gets its own signal, and when a new view starts, the old signal is aborted.

### 3. Prevents Duplicate Navigation

If you click "Character Profiles" and then click it again while it is still loading, the View Controller notices you are already on that view and skips the second click. This prevents unnecessary abort-and-reload cycles.

### 4. Handles Missing Views Gracefully

Not every menu item has a view module built yet. When you click an item that has no registered handler, instead of crashing, the View Controller shows a friendly placeholder message: "View module not yet built. This feature is coming soon."

This means we can build the admin tool one section at a time without breaking anything.

### 5. Handles Errors Gracefully

If a view module crashes (the server is down, the data is corrupted, something unexpected happens), the View Controller catches the error and displays it in the panel instead of leaving a blank screen or freezing the interface. The error message is sanitised to prevent any security issues.

### 6. Enables Sub-Navigation

View modules sometimes need to navigate to each other. For example, clicking "Edit" on a character in the list view needs to open the edit view for that specific character. View modules do this using the navigateTo function that the View Controller provides:
ctx.navigateTo('characters', 'character-profiles', 'Edit Character', '#700002');

This dispatches the same admin:navigate event, keeping the whole system consistent.

### 7. Tracks Navigation History

Every navigation is recorded in an internal history stack (limited to 50 entries to prevent memory issues). This can be used for diagnostics and may support back/forward navigation in future phases.

### 8. Tracks Performance Metrics

Like the API Client, the View Controller records statistics:

- Total navigations performed
- Total errors encountered
- Total skipped (duplicate) navigations
- Total unregistered view attempts
- Average and maximum handler load times
- Per-item load counts
- Last error details

Access these via viewController.getMetrics() for the system diagnostics panel.

---

## How View Modules Connect to It

Every view module follows the same pattern:

Step 1: Import the view controller
Step 2: Write handler functions for each view
Step 3: Register handlers with their menu item IDs
import viewController from '../viewController.js';
async function handleList(ctx) {
const data = await ctx.api.get('/characters');
ctx.container.innerHTML = '...';
}
async function handleEdit(ctx) {
const character = await ctx.api.get('/characters/' + ctx.params.id);
ctx.container.innerHTML = '...';
}
viewController.register('character-profiles', handleList);
viewController.register('character-traits', handleEdit);

### The Context Object (ctx)

Every handler receives a context object with five properties:

| Property | Type | What It Is |
|----------|------|-----------|
| container | HTMLElement | The right-hand tools panel DOM element. Write your content here. |
| params | object | Navigation details: section, item, label, and optional id (hex ID for edit views) |
| signal | AbortSignal | Cancellation signal. Passed to API calls so they cancel if user navigates away. |
| api | apiClient | The API Client from Guide 001. Use this for all server requests. |
| navigateTo | function | Call this to navigate to another view programmatically. |

---

## The 42 Menu Item IDs

These are all the item IDs from adminMenu.js that view modules can register handlers for:

Characters: character-profiles, character-traits, character-personalities, character-inventory, character-belts
Knowledge: knowledge-domains, knowledge-items, knowledge-entities, knowledge-relationships, knowledge-mappings
Narratives: narrative-arcs, narrative-beats, narrative-paths, narrative-segments, narrative-story-arcs
Curricula: curricula-list, curricula-expectations, curricula-hints, curricula-misconceptions
Media: media-assets, media-attachments
World: world-locations, world-objects, world-events
Dialogue: dialogue-categories, dialogue-speech-acts, dialogue-narrative-fn, dialogue-outcome-intents, dialogue-emotion-registers
TSE: tse-cycles, tse-evaluations, tse-sessions, tse-tasks
Psychic: psychic-moods, psychic-frames, psychic-proximity, psychic-events, psychic-radar
Users: users-cotw-dossiers
System: system-hex-ranges, system-features, system-audit-log, system-counters

---

## Key Concepts for Teaching

### Concept 1: Registry Pattern
View modules register themselves by name. The controller does not know about specific modules — it just looks up whatever is registered. This means modules can be added or removed without changing the controller.

### Concept 2: Event-Driven Decoupling
The menu and the view modules never talk to each other directly. They communicate through events. The menu fires an event, the controller catches it, the controller calls the view. Nobody imports anybody else. This makes each piece independently testable and replaceable.

### Concept 3: AbortController Lifecycle
Each view gets its own AbortController. When a new view starts, the old one is aborted. This pattern prevents memory leaks (abandoned event listeners), wasted bandwidth (cancelled API calls), and stale UI updates (old view writing to the panel after a new view has taken over).

### Concept 4: Graceful Degradation
The system does not crash when something is missing or broken. Unregistered views show a placeholder. Crashed handlers show an error message. This is defensive programming — assume things will go wrong and handle it gracefully.

### Concept 5: Navigation Deduplication
Clicking the same button twice should not restart the entire loading process. The controller detects when you are already viewing the requested content and skips redundant work.

### Concept 6: HTML Sanitisation
Error messages from the server could theoretically contain malicious code. Before displaying any dynamic text in innerHTML, the controller escapes HTML entities (replacing < with &lt; etc.) to prevent cross-site scripting (XSS) attacks.

---

## Troubleshooting

### View module not yet built
You clicked a menu item that has no registered handler. This is normal during development. The view module for this section has not been built yet.

### Error loading [label]
The view handler crashed. Read the error message for details. Common causes: server not running, database error, invalid data.

### Panel stays on Loading...
The view handler started but never finished. Check the browser console for errors. The handler may have thrown before writing to the container, or an unhandled promise rejection occurred.

### Clicking has no effect
If the admin:navigate event is not firing, check that adminMenu.js initialised correctly. Open browser developer tools, go to Console, and look for initialisation errors.

---

## File Location
public/cms/js/viewController.js

## Dependencies

- apiClient.js (imported and passed to view handlers)

## Depended On By

Every view module imports and registers with the View Controller:
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

Also initialised by the main entry point in index.html.

---

## Curriculum Metadata

- guide_number: 002
- file_path: public/cms/js/viewController.js
- title: View Controller — The Admin Tool Traffic Director
- belt_level: green_belt
- domain: cms_infrastructure
- concepts: registry_pattern, event_driven_decoupling, abort_controller_lifecycle, graceful_degradation, navigation_deduplication, html_sanitisation, performance_metrics
- prerequisites: guide_001_api_client, javascript_events, javascript_async_await
- teaches: how_menu_connects_to_views, view_lifecycle_management, why_event_driven_architecture, error_handling_in_ui
