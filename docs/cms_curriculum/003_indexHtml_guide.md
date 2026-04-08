# CMS Admin Tool — User Guide: Index HTML

**Guide Number:** 003
**File:** public/cms/index.html
**Belt Level:** White Belt (foundational structure)
**Prerequisite Knowledge:** What HTML is, what a web page is

---

## What Is This File?

This is the front door of the admin tool. It is the single HTML page that your browser loads when you visit the CMS. Everything you see on screen — the menu on the left, the Claude terminal in the centre, the tools panel on the right — is defined here as a skeleton. The actual content inside each panel is filled in by JavaScript modules after the page loads.

Think of it like the floor plan of a building. The HTML defines the rooms (three panels), the doors (buttons, inputs), the signs (labels, headings), and the safety features (security policies, accessibility landmarks). The furniture and people (data, interactivity) arrive later via JavaScript.

---

## Why Does It Exist?

Every web application needs a single HTML file as its entry point. The browser loads this file first, then follows the instructions inside it to load CSS (how things look) and JavaScript (how things behave). Without this file, nothing renders.

---

## What Does It Do?

### 1. Defines the Three-Panel Layout

The page has three main areas arranged side by side:

| Panel | Location | HTML Element | Purpose |
|-------|----------|-------------|---------|
| Admin Menu | Left | nav with id admin-menu | Lists all 42 menu items across 11 sections |
| Claude Terminal | Centre | main with id chat-output | Chat interface for Claude the Tanuki |
| Tools Panel | Right | aside with id tools-display | Where view modules render entity data |

The CSS file (cms-styles.css) uses CSS Grid to arrange these three panels. On mobile screens they stack vertically instead of sitting side by side.

### 2. Enforces Security

The Content Security Policy (CSP) meta tag on lines 64-75 tells the browser exactly what is allowed to run on this page:

| Directive | Value | What It Means |
|-----------|-------|--------------|
| default-src | 'self' | Only load resources from our own server |
| script-src | 'self' | Only run JavaScript files from our server (no CDN, no inline) |
| style-src | 'self' | Only load CSS from our server (no inline styles) |
| connect-src | 'self' ws: wss: | HTTP and WebSocket connections to our server only |
| img-src | 'self' data: | Images from our server or base64 data URIs |
| object-src | 'none' | No Flash, no Java applets, no plugins |
| frame-ancestors | 'none' | This page cannot be loaded inside an iframe |
| form-action | 'self' | Forms can only submit to our own server |

This is a hardened security posture. No external scripts, no inline code, no third-party resources. If an attacker somehow injected malicious code, the CSP would block it from executing.

### 3. Provides Accessibility

The page follows WCAG 2.2 AA+ accessibility standards:

- Skip link (line 99): Keyboard users can jump straight to the command input
- ARIA landmarks: nav, main, and aside elements with descriptive aria-label attributes
- Screen reader hints: role="log" on chat output, role="status" on connection indicators, aria-live regions for dynamic content updates
- Keyboard navigation: Tab order flows logically through panels
- aria-describedby on the command input links to usage instructions

### 4. Loads JavaScript in the Right Order

Two script tags at the bottom of the page load the JavaScript modules:

| Script | Priority | What It Does |
|--------|----------|-------------|
| adminMenu.js | High (fetchpriority="high") | Renders the left menu immediately so the user sees navigation first |
| cmsBootstrap.js | Normal | Imports apiClient and viewController, loads view modules, wires everything together |

Both use type="module" which means the browser treats them as ES modules. This enables import/export syntax and ensures they run after the HTML is fully parsed (modules are deferred by default).

### 5. Preloads Critical Resources

The modulepreload links in the head (lines 83-87) tell the browser to start downloading JavaScript files early, before they are actually needed. This is a performance optimisation — by the time cmsBootstrap.js runs and tries to import apiClient.js, the file is already downloaded and cached.

| Preloaded File | Why |
|---------------|-----|
| adminMenu.js | Renders menu, needed immediately |
| cmsBootstrap.js | Initialises everything, needed immediately |
| apiClient.js | Required by every view module, used constantly |
| viewController.js | Routes all navigation, used on every click |

### 6. Provides Fallbacks

The noscript block (lines 101-106) shows a message if JavaScript is disabled. The loading placeholder in the menu (line 118) and the tools panel (lines 169-176) show content while JavaScript initialises. These ensure the page is never completely blank.

### 7. Contains the Toast Container

The toast container (line 183) is an empty div where success and error notifications appear. It uses aria-live="assertive" so screen readers announce toast messages immediately when they appear.

---

## The Boot Sequence

When a browser loads this page, here is the exact order of events:

1. Browser downloads and parses the HTML
2. Browser sees the preload/modulepreload hints and starts downloading CSS and JS files
3. Browser applies cms-styles.css (the page gets its terminal aesthetic)
4. Browser executes adminMenu.js (the left menu renders with 42 items)
5. Browser executes cmsBootstrap.js which:
   a. Imports apiClient.js (the HTTP messenger)
   b. Imports viewController.js (the navigation router)
   c. Calls viewController.init() to start listening for menu events
   d. Dynamically imports any available view modules
6. Page is fully interactive — clicking a menu item fires admin:navigate, viewController routes it, the view module renders in the tools panel

---

## Key Concepts for Teaching

### Concept 1: Single Page Application (SPA)
The entire admin tool is one HTML page. When you navigate between sections, the page does not reload. Instead, JavaScript swaps the content in the tools panel. This is faster and preserves state (like unsaved form data).

### Concept 2: Content Security Policy
CSP is a security layer that prevents entire categories of attacks by telling the browser what is allowed to run. It is like a guest list at a club — if your script is not on the list, it does not get in.

### Concept 3: Progressive Enhancement
The page works in stages. First the HTML structure appears (skeleton). Then CSS makes it look right (styling). Then JavaScript makes it interactive (behaviour). If any layer fails, the layers below it still work.

### Concept 4: Module Preloading
Telling the browser about files it will need in advance (via modulepreload) is like pre-ordering ingredients for a recipe. When it is time to cook, everything is already on the counter instead of having to run to the shop mid-recipe.

### Concept 5: Semantic HTML
Using nav, main, and aside instead of generic div elements tells browsers and screen readers what each section IS, not just what it looks like. A nav is navigation. A main is the primary content. An aside is supplementary. This is meaningful structure.

### Concept 6: ARIA Landmarks
Attributes like aria-label, aria-live, and role tell assistive technologies (screen readers, voice control) how to interpret and announce content. A sighted user sees the panel layout. A screen reader user hears "Admin navigation" and "Claude terminal" because of these attributes.

---

## Troubleshooting

### Blank page with no panels
CSS failed to load. Check that css/cms-styles.css exists and the server is running. Open browser dev tools, Network tab, and look for 404 errors.

### Menu says Initialising... and never changes
adminMenu.js failed to load or threw an error during init. Check browser console for errors. Verify the file exists at public/cms/js/adminMenu.js.

### Tools panel says Loading... permanently
cmsBootstrap.js or viewController.js failed to load. Check browser console. Verify both files exist in public/cms/js/.

### Console shows CSP violation
You tried to load a script or resource from an external source. The CSP blocks this by design. All resources must be served from the same origin (our server). If you need an external library, it must be vendored (downloaded and placed in our public directory).

### Page works but no terminal connection
Socket.io is not connected yet. The connection-status indicator says "Disconnected." This is expected until Phase 11 when we build the admin Socket.io handlers.

---

## File Location
public/cms/index.html

## Dependencies

- css/cms-styles.css (visual styling)
- js/adminMenu.js (left panel menu)
- js/cmsBootstrap.js (module loader and initialiser)

## Depended On By

This is the root file. Everything depends on it. It is the entry point for the entire CMS admin tool.

---

## Curriculum Metadata

- guide_number: 003
- file_path: public/cms/index.html
- title: Index HTML — The Front Door of the Admin Tool
- belt_level: white_belt
- domain: cms_infrastructure
- concepts: single_page_application, content_security_policy, progressive_enhancement, module_preloading, semantic_html, aria_landmarks
- prerequisites: what_is_html, what_is_a_web_page
- teaches: how_the_admin_tool_loads, security_via_csp, accessibility_fundamentals, boot_sequence, three_panel_layout
