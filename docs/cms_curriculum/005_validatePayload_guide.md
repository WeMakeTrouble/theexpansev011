# CMS Admin Tool — User Guide: Validate Payload

**Guide Number:** 005
**File:** backend/utils/validatePayload.js
**Belt Level:** Blue Belt (intermediate backend)
**Prerequisite Knowledge:** What an API endpoint is, what a database column is, what data types are

---

## What Is This File?

The validation utility is airport security for the admin tool. Before any data from the browser gets written to the database, it passes through this file. Every field is checked: Is it the right type? Is it within the allowed range? Is it too long for the database column? If anything fails, the data is rejected with a clear explanation of what went wrong.

Think of it like a customs checkpoint. You arrive with a suitcase (the form data). The officer opens it and checks every item against the rules. If your hex ID is malformed, your belt level is not one of the five real belt levels, or your character name is 500 characters when the database only allows 100 — you get turned away with a list of everything that needs fixing.

---

## Why Does It Exist?

Without validation, bad data gets into the database. A character name could be empty. A PAD value could be 999 when it should be between -1.0 and 1.0. A belt level could be "banana" instead of one of the five real belt levels. Bad data causes crashes, corrupted displays, and broken game logic downstream.

Validation also protects against malicious input. If someone manipulates the browser request directly (bypassing the form), the validator still catches invalid data.

---

## What Does It Do?

### 1. Checks Every Field Against Its Rules

Each API endpoint defines a schema — a set of rules for what the data should look like. The validator walks through every rule and checks the submitted data against it.

For example, when editing a character:

| Field | Rule | What It Checks |
|-------|------|---------------|
| character_name | required, string, max 100 | Must be present, must be text, no longer than 100 characters |
| openness | bigFive | Must be a number between 0 and 100 |
| pad_baseline_p | padValue | Must be a number between -1.0 and 1.0 |
| belt_level | beltLevel | Must be one of: white_belt, blue_belt, purple_belt, brown_belt, black_belt |
| character_id | hexId | Must match the format #XXXXXX (6 uppercase hex digits) |

### 2. Collects All Errors Before Responding

If three fields are wrong, you get three error messages back at once. The validator does not stop at the first error. This means you can fix all problems in one go instead of fixing one, resubmitting, finding the next, fixing that, resubmitting again.

### 3. Returns Structured Errors

When validation fails, the error object contains:

- message: "Validation failed"
- statusCode: 400 (the HTTP code for "bad request")
- details: An array of human-readable error messages

The frontend can display these directly in the form, showing each field's error message next to the relevant input.

### 4. Logs Failures for Diagnostics

Every validation failure is logged via the structured logger with the count of errors and the specific messages. This helps diagnose patterns — if the same field keeps failing, there might be a frontend bug or a confusing form label.

---

## The 11 Validator Types

| Type | What It Checks | Example Valid Value |
|------|---------------|-------------------|
| hexId | Format #XXXXXX (6 uppercase hex digits) | #700002 |
| string | Text with maximum length | "Claude" (max 100) |
| text | Text with no length limit | A long description paragraph |
| number | Numeric value within min/max range | 0.85 (between 0 and 1) |
| integer | Whole number within min/max range | 7 (between 1 and 12) |
| boolean | Strictly true or false | true |
| beltLevel | One of the 5 canonical belt levels | "purple_belt" |
| jsonArray | Array where every item is a string | ["term1", "term2"] |
| jsonObject | A JSON object (not null, not array) | { "key": "value" } |
| padValue | Number between -1.0 and 1.0 | -0.35 |
| bigFive | Number between 0 and 100 | 72 |

---

## The Five Belt Levels

The Expanse uses five belt levels in this order:

1. white_belt (beginner)
2. blue_belt
3. purple_belt
4. brown_belt
5. black_belt (master)

These are enforced by CHECK constraints in the database on both knowledge_items.belt_level and user_belt_progression.current_belt. The validator uses the same list to reject invalid values before they reach the database.

---

## How API Endpoints Use It

Every route handler that accepts data calls validatePayload as the first thing:
import { validatePayload } from '../utils/validatePayload.js';
router.put('/characters/:id', async (req, res) => {
try {
validatePayload({
character_name: { required: true, type: 'string', maxLength: 100 },
category: { required: true, type: 'string', maxLength: 50 },
openness: { type: 'bigFive' },
pad_baseline_p: { type: 'padValue' },
is_active: { type: 'boolean' }
}, req.body);
// If we get here, data is valid — proceed with database update
} catch (error) {
return res.status(400).json({ error: error.message, details: error.details });
}
});

If validation passes, the code continues to the database query. If it fails, a 400 response is sent immediately with the error details.

---

## Key Concepts for Teaching

### Concept 1: Validation vs Sanitisation
Validation checks if data is correct. Sanitisation cleans data to make it safe. These are two different jobs. This file only validates — it never changes the data. Keeping them separate makes each one simpler and more predictable.

### Concept 2: Schema-Driven Validation
Instead of writing if/else checks for every field in every route, we define a schema (a set of rules) and let a generic function apply them. The same validator works for characters, knowledge items, narratives, and everything else. Only the schema changes.

### Concept 3: Collect-All vs Fail-Fast
Fail-fast stops on the first error. Collect-all finds every error before responding. For forms, collect-all is better because the user can fix everything at once instead of playing whack-a-mole one field at a time.

### Concept 4: Domain-Specific Types
Generic validators (string, number, boolean) work for any application. Domain-specific validators (hexId, beltLevel, padValue, bigFive) are built specifically for The Expanse. They encode business rules that are unique to our system.

### Concept 5: Defence in Depth
The database has CHECK constraints. The validator also checks. Why both? Because the validator gives friendly error messages before the query runs, while the database constraint is a last-resort safety net. Two layers of protection are better than one.

---

## Troubleshooting

### "Validation failed" with details
Read the details array. Each string tells you which field failed and why. Fix the data and resubmit.

### "Request body must be a JSON object"
The request body was empty, null, or not valid JSON. Check that the frontend is sending Content-Type: application/json and a properly formatted body.

### Belt level rejected
You used a belt level that is not in the canonical list of five. Valid values: white_belt, blue_belt, purple_belt, brown_belt, black_belt.

### Hex ID rejected
The hex ID must be exactly 7 characters: a # followed by 6 uppercase hex digits (0-9, A-F). Lowercase letters are rejected. Example: #700002 is valid, #70000a is not.

### PAD value rejected
PAD values must be between -1.0 and 1.0 inclusive. Values like 50 or -2.5 will be rejected. The sliders in the frontend should enforce this range, but the backend validates as a safety net.

---

## File Location
backend/utils/validatePayload.js

## Dependencies

- logger.js (for structured logging via createModuleLogger)

## Depended On By

- backend/routes/admin.js (every write endpoint uses this)

## Exports

- validatePayload (default export and named export) — the main validation function
- BELT_LEVELS — frozen array of the 5 canonical belt levels, for use by other modules

---

## Curriculum Metadata

- guide_number: 005
- file_path: backend/utils/validatePayload.js
- title: Validate Payload — Airport Security for the Database
- belt_level: blue_belt
- domain: cms_backend
- concepts: validation_vs_sanitisation, schema_driven_validation, collect_all_errors, domain_specific_types, defence_in_depth
- prerequisites: what_is_an_api_endpoint, what_is_a_database_column, data_types
- teaches: how_data_is_validated, why_validation_matters, belt_level_system, structured_error_handling
