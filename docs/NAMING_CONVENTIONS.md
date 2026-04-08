# The Expanse v010 — Naming Conventions & Style Guide

**Authority Date:** March 17, 2026
**Status:** CANONICAL (living document)
**Scope:** All new code in v010

---

## Core Principle

Consistency enables readability. Readability enables maintainability.

**All code must follow these conventions.**
Deviations require explicit approval.

---

## Philosophy: Why Multiple Styles?

### Industry Standards

JavaScript/Node.js community uses **semantic naming**:
- Different contexts = different conventions
- Each style signals intent and type
- Reduces cognitive load (you know what something is by how it's named)

### Our Multi-Style Approach

| Context | Style | Reason | Example |
|---------|-------|--------|---------|
| **JavaScript Classes** | PascalCase | OOP convention, Constructor pattern | `UserManager`, `OnboardingOrchestrator` |
| **JS Functions/Services** | camelCase | Functional programming convention | `getUserById()`, `omiyageService` |
| **Constants** | UPPER_SNAKE_CASE | Immutability signal, visibility | `MAX_PASSWORD_LENGTH`, `JWT_EXPIRY` |
| **Database Tables** | snake_case | SQL convention, universal DB standard | `user_onboarding_state`, `character_profiles` |
| **Database Columns** | snake_case | SQL convention, readability in queries | `user_id`, `access_level`, `created_at` |
| **URLs/Routes** | kebab-case OR camelCase | Web standard for URLs, consistency | `/api/character-knowledge` or `/api/characterKnowledge` |
| **Private Methods** | _camelCase | Visual distinction, encapsulation signal | `_sanitizeData()`, `_formatMessage()` |

**This is NOT arbitrary.** Each style choice communicates semantic meaning.

---

## File & Directory Naming

### Classes (PascalCase)
UserManager.js
OnboardingOrchestrator.js
TraitManager.js
- One class per file
- Export as `export default ClassName`
- File name matches class name exactly
- **Why:** Matches constructor/class syntax in JavaScript

### Services (camelCase)
omiyageService.js
cotwDossierService.js
ltlmUtteranceSelector.js
narrativeWelcomeService.js
- Export as `export default serviceName`
- Suffix: `Service` or `Selector` for clarity
- File name matches export name
- **Why:** Signals functional behavior, not object-oriented

### Utilities (camelCase + Util suffix)
hexIdGenerator.js
jwtUtil.js
emailSender.js
routeLogger.js
validator.js
- Pure functions, no state
- Export named functions + default
- File name matches primary export
- **Why:** Indicates stateless, reusable logic

### Middleware (camelCase)
auth.js
requireAdmin.js
rateLimiter.js
- Export named middleware function
- File name matches function name
- **Why:** Middleware is functional, not class-based

### Routes (camelCase OR kebab-case)
auth.js (preferred: camelCase for code consistency)
adminCharacters.js (preferred: camelCase for code consistency)
god-mode.js (acceptable: kebab-case for readability in URLs)
- Export as `export default router`
- Reflect endpoint purpose in name
- **Why:** Semantic clarity of purpose

### Config Files (camelCase)
session.js
constants.js
promptTemplates.js
- **Why:** Configuration objects are JavaScript, not databases

### Directories (camelCase)
backend/
routes/
services/
middleware/
utils/
auth/
db/
councilTerminal/
core/
config/
phases/
TSE/
- **Why:** Matches Node.js/npm conventions

---

## Code Naming Conventions

### Variables & Functions (camelCase)
```javascript
const userId = 42;
const userEmail = 'user@example.com';
let isActive = true;

function getUserById(id) { }
async function verifyUserCredentials(username, password) { }
```
- **Why:** Matches ECMAScript standard, readability

### Constants (UPPER_SNAKE_CASE)
```javascript
const MAX_PASSWORD_LENGTH = 128;
const JWT_EXPIRY = '24h';
const LONG_PROMPT_THRESHOLD = 4000;
const WORLD_BREAK_TYPES = Object.freeze({
  TRANSACTIONAL: 'transactional',
  EPISTEMIC: 'epistemic',
  DISCOVERY: 'discovery'
});
```
- **Why:** Visual signal = "don't reassign this" + readability in mixed code

### Private Methods (_camelCase)
```javascript
class MyClass {
  _sanitizeData(data) { }
  _formatMessage(level, module, message) { }
}
```
- **Why:** Underscore prefix signals "internal use only"

### Boolean Variables (is/has prefix)
```javascript
const isActive = true;
const hasPermission = false;
const isDossier = true;
const wasApproved = null;
```
- **Why:** Clarity in conditionals: `if (isActive)` reads better than `if (active)`

### Abbreviations (AVOID in variable names)
```javascript
// Bad
const usr = getUser();
const auth_lvl = 11;
const db_pool = pool;

// Good
const user = getUser();
const accessLevel = 11;
const dbPool = pool;
```
- **Why:** Full words = faster comprehension, no mental decode step

### Hex ID Variables
```javascript
const characterId = '#70000A';  // Always include # in value
const dossier_id = '#CA0001';  // Snake_case OK for DB columns
const hexId = generateHexId('character_id');
```
- **Why:** # is part of The Expanse canonical ID format

---

## Logging Standards

### Logger Creation
```javascript
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('ModuleName');
```

### Logger Usage
```javascript
logger.info('message', { context: data });
logger.warn('message', { context: data });
logger.error('message', error);
logger.debug('message', { context: data });
logger.success('message', { context: data });
```

**NO console.log / console.error** — use logger only.
- **Why:** Centralized logging, correlation IDs, observability

---

## Function Naming Patterns

### Getters
```javascript
getUserById(id)
getCharacterInventory(characterId)
getRecentLogs(count)
```

### Setters/Creators
```javascript
createUser(username, email, password)
createModuleLogger(moduleName)
generateHexId(idType)
```

### Validators
```javascript
validateHexId(id, type)
validateEmail(email)
validatePassword(password)
```

### Checkers
```javascript
checkEscalation(intent, userType, metadata)
isValidHex(id)
hasPermission(user, action)
```

### Handlers
```javascript
handleOnboardingFlow(socket)
handleCommandResponse(response)
requireAdmin()
```

---

## Database Naming

### Tables (snake_case)
```sql
user_onboarding_state
character_profiles
psychic_frames
tse_cycles
hex_id_counters
```
- **Why:** SQL standard, readability in queries

### Columns (snake_case)
```sql
user_id
character_name
is_active
access_level
created_at
last_login
password_hash
```
- **Why:** SQL convention, consistency with table naming

### Constraints (snake_case with prefix)
```sql
chk_b_roll_autonomy_by_category
fk_character_inventory_character_id
pk_users_user_id
```
- **Why:** Clarity of constraint type

---

## Socket Event Naming

### Event Names (kebab-case)
```javascript
socket.emit('terminal-command', { command });
socket.emit('omiyage:offer', { choiceId, narrative });
socket.emit('command-response', { output });
```

Reference: **CANONICAL_SOCKET_EVENTS.md**

- **Why:** Socket.io convention, consistency with web standards

---

## Frontend / CSS Standards

### Theme Color (The Expanse Brand)
Primary: #00ff75 (neon green on black — terminal aesthetic)
Secondary: #ff4444 (red for errors/warnings)
Background: #000000 (pure black)
Text: #00ff75 or #FFFFFF (high contrast)

### CSS Naming (BEM convention recommended)
```css
.cms-terminal { }
.cms-terminal__header { }
.cms-terminal__content { }
.cms-terminal__button--active { }
.cms-terminal__status--error { }
```
- **Why:** BEM scales, prevents naming collisions, clear hierarchy

### CSS File Organization
cms/css/
├── cms-styles.css (main stylesheet)
├── cms-theme.css (color/aesthetic overrides)
├── cms-responsive.css (media queries)

### Frontend JavaScript (Vanilla JS)
```javascript
const CharacterDisplay = {
  init() { },
  render(character) { },
  _buildDom(data) { }
};

document.addEventListener('click', (e) => {
  if (e.target.matches('.character-item')) {
    CharacterDisplay.render(e.target.dataset.characterId);
  }
});
```
- **Why:** No framework overhead, maintainable with vanilla JS

---

## Class & Object Structure

### Constructor Pattern
```javascript
class UserManager {
  constructor() {
    this.property = value;
  }

  static async createUser(username, email, password) { }
  async verifyUser(username, password) { }
  _validateInput(input) { }
}
```

### Export Pattern
```javascript
export default UserManager;
export const createModuleLogger = (name) => { };
export { verifyToken, generateToken };
```

---

## Comment Standards

### Block Comments
```javascript
/*
 * ============================================================================
 * SectionName — Purpose
 * ============================================================================
 */
```

### Inline Comments
```javascript
// Use sparingly — code should be self-documenting
// Only explain WHY, not WHAT
```

### JSDoc (for public methods)
```javascript
/**
 * Creates a new user account
 * @param {string} username - User's username
 * @param {string} email - User's email
 * @returns {Promise<{success: boolean, user: object}>}
 */
static async createUser(username, email, password) { }
```

---

## Error Handling

### Error Messages (user-friendly)
```javascript
// Bad
throw new Error('ECONNREFUSED');

// Good
throw new Error('Database connection failed. Please try again.');
```

### Error Logging
```javascript
logger.error('Operation failed', error, { context: data });
```

---

## Import/Export Standards

### Import Order
```javascript
// 1. External libraries
import express from 'express';
import bcrypt from 'bcryptjs';

// 2. Local utilities/services
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

// 3. Constants/config
import { STRENGTH_THRESHOLDS } from '../config/constants.js';
```

### Module Exports
```javascript
export default UserManager;
export const validateHexId = (id) => { };
export const generateHexId = (type) => { };
```

---

## Async/Await Standards

### Function Naming
```javascript
async function fetchUser(id) { }
async function verifyCredentials(username, password) { }
return async (req, res, next) => { };
```

### Error Handling
```javascript
try {
  const result = await operation();
  return { success: true, result };
} catch (error) {
  logger.error('Operation failed', error);
  return { success: false, error: error.message };
}
```

---

## Hex ID System (CRITICAL)

### Format
```javascript
const characterId = '#70000A';  // Always #XXXXXX (uppercase)
const dossierHex = '#CA0001';
```

### Generation
```javascript
import generateHexId from '../utils/hexIdGenerator.js';
const newId = await generateHexId('character_id');  // Returns #XXXXXX
```

### Never
```javascript
// NEVER hardcode
const id = '#70DEAD';

// NEVER use UUID
const id = '550e8400-e29b-41d4-a716-446655440000';

// NEVER use random strings
const id = Math.random().toString();
```

---

## UI Zone Rules (NON-NEGOTIABLE)

These rules apply to BOTH the admin CMS (public/cms/index.html) and the
COTW user terminal (public/cotw/cotw-dossier.html) without exception.
Every instrument must appear in both interfaces.

### The Five Zones

| Zone | CSS Class | Purpose | What Goes Here |
|------|-----------|---------|----------------|
| Left | `panel--menu` | Navigation only | Menu sections and drill-down items |
| Top | `panel--top` | Instruments only | Live gauges and instrument canvases |
| Centre | `panel--terminal` | Claude terminal only | Chat output and command input — never changes |
| Bottom | `panel--bottom` | Instruments only | Live gauges and instrument strips |
| Content | `panel--content` | Content views only | Data readouts, dossier views, edit forms |

### Instrument Panel Rules (NON-NEGOTIABLE)

1. **Instruments only ever open in `panel--top` or `panel--bottom`** — never in `panel--content`, never in `panel--terminal`, never in `panel--menu`

2. **Content views only ever open in `panel--content`** — never in `panel--top` or `panel--bottom`

3. **Images always open in `panel--top`**

4. **Each instrument has a fixed assigned panel** — top or bottom — decided at design time and never changed at runtime

5. **Only two instruments are active at any time** — one per slot (top and bottom)

6. **Displacement rule** — when a third instrument is activated, the oldest active instrument is displaced. The two most recently activated instruments always win

7. **State preservation** — instruments that accumulate session state (e.g. Danique Engine) must preserve their state in a module-level singleton so that displacement and reopening within the same session resumes exactly where it left off. Stateless instruments (e.g. Ockham's Razor) may reset on reopen.

8. **Available in both interfaces** — every instrument must be accessible from both the admin CMS and the COTW user terminal. No instrument is admin-only or user-only.

### Confirmed Instrument Panel Assignments

| Instrument | Fixed Panel | State | Notes |
|------------|-------------|-------|-------|
| Psychic Radar | `panel--top` | Stateless (live feed reconnects) | Canvas persists via module singleton |
| Images | `panel--top` | Stateless | Always top, displaces other top instrument if present |
| Ockham's Razor Engine | `panel--bottom` | Stateless | Resets on close — on-demand evaluation tool |
| Danique Engine | `panel--top` | Stateful | Must preserve session state on displacement |

### Adding a New Instrument

When a new instrument is created:
1. Assign it a fixed panel (`panel--top` or `panel--bottom`) in this document before writing any code
2. Decide whether it is stateful or stateless
3. If stateful — implement module-level singleton state preservation
4. Register it in both `adminMenu.js` and `cotwMenu.js`
5. Implement it in both `public/cms/js/modules/` and `public/cotw/js/` — same behaviour, same panel assignment
6. Update the Confirmed Instrument Panel Assignments table above

**No instrument may be built without a panel assignment recorded here first.**

---

## Deviations & Approvals

Any deviation from this guide requires:
1. Issue/ticket number
2. Justification
3. Code review approval
4. Update to this document

**No silent exceptions.**

---

## Living Document Updates

When new patterns emerge:
1. Document the pattern here
2. Update all existing code that uses old pattern (next sprint)
3. Notify team of change
4. Update this date

**Last Updated:** March 17, 2026
