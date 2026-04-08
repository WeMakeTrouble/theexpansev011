# CMS Admin Tool — User Guide: Data Table

**Guide Number:** 009
**File:** public/cms/js/components/dataTable.js
**Belt Level:** Blue Belt (intermediate UI)
**Prerequisite Knowledge:** Guide 008 (Hex ID Display), what HTML tables are, basic JavaScript

---

## What Is This File?

The data table is the workhorse of the admin tool. Every section starts with a list — characters, knowledge items, narrative arcs, TSE cycles. This component takes an array of data and a set of column definitions and builds a complete sortable, accessible, interactive table. Click a column header to sort. Click a row to open its detail view.

Think of it like a spreadsheet that builds itself. You hand it the data and tell it which columns to show, and it does everything else — headers, rows, sorting, click handling, empty states, record counts, and cleanup.

---

## Why Does It Exist?

Without a shared table component, every view module would build its own table from scratch. That means duplicated sorting logic, duplicated click handlers, duplicated accessibility attributes, and inconsistent behaviour across views. The data table builds once, works everywhere, and guarantees every list in the admin tool looks and behaves identically.

---

## What Does It Do?

### 1. Renders Data as a Proper HTML Table

Uses semantic HTML — thead, tbody, th, td — not divs pretending to be a table. Screen readers understand the structure. Keyboard users can navigate between cells.

### 2. Sorts by Column Click

Click a sortable column header and the data sorts ascending (A-Z, 0-9). Click again for descending (Z-A, 9-0). Click a third time to return to the original order. An arrow indicator shows the current sort state. Only one column sorts at a time.

### 3. Uses Built-In Renderers

Different data types need different display. The table includes five built-in renderers:

| Renderer | What It Does | Example Output |
|----------|-------------|---------------|
| hexId | Renders a colour-coded badge with click-to-copy | [swatch] #700002 |
| boolean | Shows Yes/No with colour styling | Yes (green) or No (red) |
| date | Formats timestamps as human-readable dates | 22 Feb 2026 |
| json | Summarises arrays and objects | [3 items] or {5 keys} |
| number | Right-aligns numeric values | 42 |

You can also pass a custom function as a renderer for any column.

### 4. Handles Row Clicks

Pass an onRowClick function and rows become clickable. Click a character row and it navigates to that character's edit view. The table uses event delegation on the tbody — one listener handles all rows, even after sorting rebuilds them.

### 5. Shows Empty State

When the data array is empty, the table shows a configurable message like "No characters found" instead of a confusing blank space.

### 6. Displays Record Count

A footer below the table shows "42 records" (or "1 record" for singular). This confirms how much data loaded and helps spot issues (expected 50 but seeing 3 means something filtered wrong).

### 7. Announces Sort Changes to Screen Readers

A hidden live region announces sort state changes — "Sorted by Name, ascending" or "Sort removed, original order restored." Sighted users see the arrow change; screen reader users hear the announcement.

### 8. Cleans Up After Itself

The returned wrapper element has a cleanup() method. When the view changes, calling cleanup() removes all event listeners. This prevents memory leaks from abandoned tables.

---

## How View Modules Use It
import dataTable from '../components/dataTable.js';
const table = dataTable.create({
columns: [
{ key: 'character_id', label: 'ID', renderer: 'hexId' },
{ key: 'character_name', label: 'Name' },
{ key: 'category', label: 'Category' },
{ key: 'is_active', label: 'Active', renderer: 'boolean' },
{ key: 'updated_at', label: 'Updated', renderer: 'date' }
],
data: characterArray,
onRowClick: (row) => {
ctx.navigateTo('characters', 'character-profiles', 'Edit', row.character_id);
},
emptyMessage: 'No characters found'
});
container.appendChild(table);
// Later, when view changes:
table.cleanup();

### Custom Renderer Example
{
key: 'omiyage_giving_affinity',
label: 'Gift Affinity',
renderer: (value) => {
const span = document.createElement('span');
span.textContent = value !== null ? value.toFixed(1) + '%' : 'N/A';
return span;
}
}

---

## Event Delegation

Instead of attaching click listeners to every row and every header, the table attaches just four listeners total — click and keydown on thead, click and keydown on tbody. When you click a row, the listener checks which row was clicked and looks up the corresponding data. This means:

- Sorting can rebuild all rows without creating new listeners
- 1000 rows still have only 4 listeners (not 2004)
- Cleanup removes exactly 4 listeners to free everything

This is called event delegation — one parent listener handles events that bubble up from its children.

---

## Config Validation

The table validates your column configuration before building anything. It checks:

- columns is a non-empty array
- Every column has a string key property
- Every column has a string label property
- No duplicate keys exist
- Renderer (if provided) is a string or function

If validation fails, the table throws immediately with a clear message telling you exactly which column is wrong. This catches configuration bugs at development time instead of producing broken tables at runtime.

---

## Key Concepts for Teaching

### Concept 1: Event Delegation
Instead of one listener per interactive element, one listener on a parent element catches events that bubble up. You check which child was clicked using e.target.closest(). This is more memory-efficient and works even when children are added or replaced after the listener was attached.

### Concept 2: Three-State Sort
Most basic sorts toggle between ascending and descending. This table adds a third state — original order. This lets users return to the default view without refreshing. The cycle is: unsorted -> ascending -> descending -> unsorted.

### Concept 3: Renderer Pattern
Different data types need different display logic. Instead of if/else chains inside the table builder, renderers are isolated functions looked up by name. Adding a new renderer means adding one function to the _renderers object. This is the strategy pattern — swappable algorithms selected at runtime.

### Concept 4: Non-Mutating Data
The table copies the input array immediately (originalData = [...data]). Sorting never changes the original. This prevents the caller's data from being scrambled by sort operations. It also means the third sort state (original order) always works correctly.

### Concept 5: Cleanup Lifecycle
DOM elements with event listeners should be cleaned up when they are no longer needed. The cleanup() method removes all listeners in one call. The View Controller calls this automatically when navigating away from a view, preventing memory leaks from accumulated abandoned tables.

---

## Troubleshooting

### Table not appearing
Check that the data array is not null or undefined (use empty array [] for no data). Check that columns are properly defined with key and label properties.

### Column throws "requires a string key property"
One of your column definitions is missing the key field or it is not a string. Every column needs { key: 'fieldName', label: 'Display Name' } at minimum.

### Sorting does not work on a column
Check that sortable is not explicitly set to false on that column. By default all columns are sortable.

### Row clicks not firing
Verify that onRowClick is a function in the config. If omitted, rows are not interactive. Check the browser console for errors in your click handler.

### Hex ID column shows dashes
The data value for that row is null or undefined. Check that the data objects have the correct property name matching the column key.

---

## File Location
public/cms/js/components/dataTable.js

## Dependencies

- hexIdDisplay.js (for the hexId renderer)

## Depended On By

Every view module's list view (all 11 managers).

## Exports

- default: frozen object with create(), getMetrics(), resetMetrics()

---

## Curriculum Metadata

- guide_number: 009
- file_path: public/cms/js/components/dataTable.js
- title: Data Table — The List View Workhorse
- belt_level: blue_belt
- domain: cms_components
- concepts: event_delegation, three_state_sort, renderer_pattern, non_mutating_data, cleanup_lifecycle, config_validation, aria_live_region
- prerequisites: guide_008_hex_id_display, html_tables, basic_javascript
- teaches: how_list_views_work, sorting_patterns, event_delegation, accessible_tables, memory_management
