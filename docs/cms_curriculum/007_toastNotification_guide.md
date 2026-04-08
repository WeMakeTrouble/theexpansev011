# CMS Admin Tool — User Guide: Toast Notification

**Guide Number:** 007
**File:** public/cms/js/components/toastNotification.js
**Belt Level:** White Belt (foundational UI)
**Prerequisite Knowledge:** What a web page is, basic JavaScript

---

## What Is This File?

Toast notifications are the quick popup messages that appear at the bottom of the screen when something happens. Saved a character? Green popup says "Character saved." Something broke? Red popup says "Failed to save." They appear, deliver the message, and disappear on their own — like toast popping up from a toaster.

Every view module in the admin tool uses toasts to tell you whether your action succeeded or failed. Instead of each module building its own popup system, they all share this one component.

---

## Why Does It Exist?

Without a shared toast system, every view module would need its own way of showing success and error messages. Some might use alert boxes, some might write text into the panel, some might do nothing. The toast component gives the entire admin tool a consistent, professional notification system. One import, one line of code, and your message appears.

---

## What Does It Do?

### 1. Shows Four Types of Messages

| Type | Colour | When To Use | Default Duration |
|------|--------|-------------|-----------------|
| success | Green (#00ff75) | Action completed successfully | 3 seconds |
| error | Red (#ff4444) | Action failed | 5 seconds |
| warn | Amber (#ffaa00) | Something needs attention but is not broken | 3 seconds |
| info | Blue (#4488ff) | Neutral information (loading status, counts) | 3 seconds |

### 2. Auto-Dismisses After a Timer

Each toast disappears automatically after its duration. Success messages vanish after 3 seconds. Error messages stay longer (5 seconds) because you need more time to read them. You can also set custom durations or make toasts persistent (they stay until you click the dismiss button).

### 3. Stacks Multiple Toasts

If several things happen at once (like saving multiple records), the toasts stack vertically. The oldest is at the top, the newest at the bottom. If more than 5 are visible at once, the oldest is dismissed to make room.

### 4. Provides a Dismiss Button

Every toast has an X button on the right side. Clicking it dismisses the toast immediately. You do not need to wait for the timer.

### 5. Supports Accessibility

Toasts use role="status" and aria-live="polite" so screen readers announce them. The dismiss button has an aria-label. The container in index.html uses role="alert" and aria-live="assertive" for high-priority notifications.

### 6. Sanitises Messages

All messages are sanitised before display. If a server error message contains HTML characters, they are escaped to prevent cross-site scripting. You can safely pass any string to a toast.

### 7. Tracks Metrics

The toast system records how many toasts have been shown, how many dismissed, and counts per type. Access these via toast.getMetrics() for the system diagnostics panel.

---

## How View Modules Use It

One import, one line:
import toast from '../components/toastNotification.js';
// After a successful save
toast.success('Character saved');
// After a failed request
toast.error('Failed to save: ' + error.message);
// Warning before destructive action
toast.warn('Unsaved changes will be lost');
// Loading status
toast.info('Loading 42 knowledge items...');

### Custom Options
// Longer display time
toast.success('All 15 items updated', { duration: 5000 });
// Stays until manually dismissed
toast.error('Critical error — see logs', { persistent: true });
// Dismiss all active toasts
toast.dismissAll();

---

## Key Concepts for Teaching

### Concept 1: Shared Components
Instead of every module building its own version of the same thing, shared components are built once and imported everywhere. This ensures consistency (all toasts look the same), reduces bugs (one implementation to test), and saves code (no duplication).

### Concept 2: Auto-Dismiss with Timer
setTimeout is used to automatically remove toasts after a delay. The exit animation uses a CSS class (toast--exiting) added before removal, with a short delay so the fade-out completes before the element is deleted from the page.

### Concept 3: Maximum Visible Limit
Allowing unlimited toasts would clutter the screen. The component enforces a maximum of 5 visible toasts. When a 6th arrives, the oldest is dismissed first. This is a bounded collection pattern — the same idea as the View Controller's history limit.

### Concept 4: Sanitisation in UI Components
Any text that comes from outside the component (server error messages, user input, database values) must be sanitised before putting it into innerHTML. The toast component uses the same textContent-to-innerHTML technique as the View Controller.

### Concept 5: Progressive Enhancement in CSS
The toast component adds CSS classes (toast, toast--success, toast--exiting) but does not define the styles. The styles live in cms-styles.css. If CSS fails to load, the toasts still appear as plain text. This separation of behaviour (JS) and presentation (CSS) is a core web development principle.

---

## Troubleshooting

### Toasts not appearing
Check that the toast-container element exists in index.html (id="toast-container"). Check the browser console for JavaScript errors.

### Toasts appear but look unstyled
The CSS classes (toast, toast--success, etc.) need to be defined in cms-styles.css. If they are missing, the toasts will appear as plain divs.

### Error toasts disappearing too quickly
Error toasts default to 5 seconds. Use persistent: true for critical errors that need manual dismissal.

### Too many toasts on screen
The component limits to 5 visible. If you see more, the limit may have been bypassed. Check that _enforceMax is being called.

---

## File Location
public/cms/js/components/toastNotification.js

## Dependencies

None. Uses only browser-native APIs (document.createElement, setTimeout).

## Depended On By

Every view module that needs to show user feedback:
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

---

## Curriculum Metadata

- guide_number: 007
- file_path: public/cms/js/components/toastNotification.js
- title: Toast Notification — Quick Popup Messages
- belt_level: white_belt
- domain: cms_components
- concepts: shared_components, auto_dismiss_timer, maximum_visible_limit, sanitisation_in_ui, progressive_enhancement_css
- prerequisites: what_is_a_web_page, basic_javascript
- teaches: how_notifications_work, why_shared_components, toast_patterns, ui_feedback
