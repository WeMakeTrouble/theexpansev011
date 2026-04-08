# CMS Admin Tool — User Guide: Hex ID Display

**Guide Number:** 008
**File:** public/cms/js/components/hexIdDisplay.js
**Belt Level:** White Belt (foundational UI)
**Prerequisite Knowledge:** What hex colour codes are, basic JavaScript

---

## What Is This File?

Every entity in The Expanse has a unique hex colour code ID like #700002 for Claude or #D00006 for a user. This component turns those IDs into interactive badges — a coloured square showing the actual colour, the ID text in monospace font, and click-to-copy functionality. Instead of just seeing plain text, you see a visual identity marker.

Think of it like a name tag at a conference. The badge shows your colour (the swatch), your ID number (the hex code), and optionally your name (the label). Click it and the ID copies to your clipboard so you can paste it elsewhere.

---

## Why Does It Exist?

Hex IDs appear everywhere in the admin tool — character lists, knowledge items, narrative arcs, relationship links. Every time an ID is shown, it should look the same and behave the same. This component ensures consistent display across all 42 views without duplicating the badge-building code in each one.

---

## What Does It Do?

### 1. Displays a Colour Swatch

The actual hex value IS a colour. #700002 is a deep red. #00FF75 is our terminal green. The badge shows a small square filled with that colour, giving you a visual fingerprint for each entity.

### 2. Shows the ID in Monospace

The hex ID text is displayed in a monospace (fixed-width) font so all IDs align neatly in lists and tables. #700002 and #D00006 take up the same width.

### 3. Click to Copy

Click the badge (or press Enter/Space when focused) and the hex ID copies to your clipboard. The badge briefly shows "Copied!" as feedback, then reverts to showing the ID.

### 4. Handles Invalid IDs Gracefully

If an invalid hex ID is passed (wrong format, missing hash, lowercase when uppercase expected), the badge shows "(invalid)" with a grey swatch instead of crashing.

### 5. Supports Three Sizes

| Size | When To Use |
|------|-------------|
| small | Inline within text or table cells |
| medium | Default, used in most list views |
| large | Detail/edit views where the ID is a heading |

### 6. Supports Optional Labels

You can add an entity name alongside the ID:
hexIdDisplay.create('#700002', { label: 'Claude' })

This renders: [colour swatch] #700002 Claude

### 7. Accessible

The badge uses role="button" so screen readers know it is interactive. The aria-label says "Copy hex ID #700002 to clipboard." It is keyboard focusable via tabindex and responds to Enter and Space keys.

---

## How View Modules Use It
import hexIdDisplay from '../components/hexIdDisplay.js';
// Basic badge
const badge = hexIdDisplay.create('#700002');
row.appendChild(badge);
// Badge with label
const badge = hexIdDisplay.create('#700002', { label: 'Claude' });
header.appendChild(badge);
// Small badge for table cells
const badge = hexIdDisplay.create('#AF0001', { size: 'small' });
cell.appendChild(badge);
// Multiple badges at once
const fragment = hexIdDisplay.createList(['#700001', '#700002', '#700003']);
container.appendChild(fragment);

---

## Key Concepts for Teaching

### Concept 1: Hex Codes Are Both IDs and Colours
In most systems, IDs are just numbers with no visual meaning. In The Expanse, every ID is also a valid colour. This dual nature lets us create visual identity markers that are both functional (unique, sortable, copyable) and recognisable (you start to associate certain colours with certain entities).

### Concept 2: DOM Element Creation
This component builds HTML elements entirely in JavaScript using document.createElement rather than innerHTML strings. This is safer (no XSS risk), more performant for individual elements, and gives us direct references to attach event listeners.

### Concept 3: Clipboard API with Fallback
Modern browsers support navigator.clipboard.writeText for copying. Older browsers do not. The component tries the modern API first and falls back to the legacy document.execCommand('copy') technique with a temporary textarea element. This ensures copy works everywhere.

### Concept 4: Component Pattern
This is a factory pattern — you call create() and get back a fully configured DOM element. The component does not manage where elements go or when they appear. It just builds them. The caller decides where to put them. This separation makes the component reusable in any context.

### Concept 5: Visual Feedback
When you click to copy, the text changes to "Copied!" for 1.2 seconds. This is user feedback — it confirms the action worked without requiring a separate notification. Small interactions like this make tools feel responsive and trustworthy.

---

## Troubleshooting

### Badge shows (invalid)
The hex ID passed to create() does not match the format #XXXXXX (6 hex digits with leading hash). Check the value being passed. Common issues: missing hash, lowercase letters, wrong length.

### Copy not working
The Clipboard API requires a secure context (HTTPS or localhost). If running on plain HTTP, the modern API will fail but the fallback should work. Check the browser console for permission errors.

### Badge appears but no colour
The CSS classes hex-badge and hex-badge__swatch need to be defined in cms-styles.css. The inline backgroundColor is set, but the swatch needs width/height/display from CSS to be visible.

### Badges not aligned in tables
Ensure all badges in a column use the same size option. Mixed sizes will cause misalignment.

---

## File Location
public/cms/js/components/hexIdDisplay.js

## Dependencies

None. Uses only browser-native APIs (document.createElement, navigator.clipboard).

## Depended On By

Every view module that displays entity IDs (all 11 managers) and the dataTable component.

---

## Curriculum Metadata

- guide_number: 008
- file_path: public/cms/js/components/hexIdDisplay.js
- title: Hex ID Display — Colour-Coded Identity Badges
- belt_level: white_belt
- domain: cms_components
- concepts: hex_codes_as_ids_and_colours, dom_element_creation, clipboard_api_with_fallback, component_factory_pattern, visual_feedback
- prerequisites: what_are_hex_colours, basic_javascript
- teaches: how_ids_are_displayed, click_to_copy_pattern, accessible_interactive_elements, component_reuse
