/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MIGRATION 010 — FRACTURE ENGINE SCHEMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MIGRATION CREATES:
 * ---------------------------------------------------------------------------
 * Two tables supporting the Fracture Engine trauma algorithm:
 *
 *   1. fracture_events — Immutable record of every B-Roll birth trauma
 *      Stores the exact inputs/outputs of FractureEngine.computeFracture()
 *
 *   2. recovery_trajectories — Mutable state tracking emotional evolution
 *      Updated by the Psychic Engine tick system and Omiyage events
 *
 * DESIGN DECISIONS:
 * ---------------------------------------------------------------------------
 * • Event Sourcing: fracture_events is append-only, immutable audit trail
 * • Separation of Concerns: Static fracture data vs dynamic recovery state
 * • Deterministic Verification: seed column allows reproduction of any result
 * • Realm Isolation: All queries include realm_hex_id for data boundaries
 *
 * FOREIGN KEYS:
 * ---------------------------------------------------------------------------
 * • fracture_events.entity_id → entities(entity_id)
 * • fracture_events.object_id → objects(object_id)  
 * • fracture_events.broll_character_id → characters(character_id)
 * • recovery_trajectories.broll_character_id → characters(character_id)
 *
 * INDEX STRATEGY:
 * ---------------------------------------------------------------------------
 * High read frequency on Psychic Radar display → index broll_character_id
 * Time-series queries for recovery → index created_at and last_updated
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/*
 * ============================================================================
 * TABLE: fracture_events
 * ============================================================================
 * Immutable record of B-Roll character birth trauma.
 * One row per birth event. Never updated, never deleted.
 */

CREATE TABLE fracture_events (
    event_id VARCHAR(7) PRIMARY KEY CHECK (event_id ~ '^#[0-9A-F]{6}$'),
    entity_id VARCHAR(7) NOT NULL CHECK (entity_id ~ '^#[0-9A-F]{6}$'),
    object_id VARCHAR(7) NOT NULL CHECK (object_id ~ '^#[0-9A-F]{6}$'),
    broll_character_id VARCHAR(7) NOT NULL CHECK (broll_character_id ~ '^#[0-9A-F]{6}$'),
    
    -- Source entity state at moment of separation (PAD model)
    source_p numeric(4,3) NOT NULL CHECK (source_p >= -1.0 AND source_p <= 1.0),
    source_a numeric(4,3) NOT NULL CHECK (source_a >= -1.0 AND source_a <= 1.0),
    source_d numeric(4,3) NOT NULL CHECK (source_d >= -1.0 AND source_d <= 1.0),
    
    -- Attachment parameters
    attachment_strength numeric(3,2) NOT NULL CHECK (attachment_strength >= 0.0 AND attachment_strength <= 1.0),
    object_type VARCHAR(20) NOT NULL CHECK (object_type IN ('universal', 'confined_object', 'worn_object', 'consumed_object', 'companion_object')),
    
    -- Fracture Engine outputs
    fractured_p numeric(4,3) NOT NULL CHECK (fractured_p >= -1.0 AND fractured_p <= 1.0),
    fractured_a numeric(4,3) NOT NULL CHECK (fractured_a >= -1.0 AND fractured_a <= 1.0),
    fractured_d numeric(4,3) NOT NULL CHECK (fractured_d >= -1.0 AND fractured_d <= 1.0),
    severity_factor numeric(3,2) NOT NULL CHECK (severity_factor >= 0.0 AND severity_factor <= 1.0),
    predicted_trajectory VARCHAR(20) NOT NULL CHECK (predicted_trajectory IN ('resilient', 'recovery', 'chronic', 'depressed-improved')),
    recovery_rate numeric(4,3) NOT NULL,
    fight_triggered BOOLEAN DEFAULT FALSE,
    
    -- Target baseline for recovery (from OCEAN or default)
    target_p numeric(4,3) NOT NULL,
    target_a numeric(4,3) NOT NULL,
    target_d numeric(4,3) NOT NULL,
    
    -- Deterministic verification
    seed INTEGER NOT NULL,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    CONSTRAINT fk_fracture_entity FOREIGN KEY (entity_id) REFERENCES entities(entity_id),
    CONSTRAINT fk_fracture_object FOREIGN KEY (object_id) REFERENCES objects(object_id),
    CONSTRAINT fk_fracture_broll FOREIGN KEY (broll_character_id) REFERENCES characters(character_id)
);

/*
 * ============================================================================
 * TABLE: recovery_trajectories  
 * ============================================================================
 * Mutable state tracking B-Roll emotional evolution over time.
 * Updated every Psychic Engine tick and on Omiyage events.
 */

CREATE TABLE recovery_trajectories (
    trajectory_id VARCHAR(7) PRIMARY KEY CHECK (trajectory_id ~ '^#[0-9A-F]{6}$'),
    broll_character_id VARCHAR(7) NOT NULL CHECK (broll_character_id ~ '^#[0-9A-F]{6}$'),
    fracture_event_id VARCHAR(7) NOT NULL CHECK (fracture_event_id ~ '^#[0-9A-F]{6}$'),
    
    -- Current trajectory classification
    trajectory_type VARCHAR(20) NOT NULL CHECK (trajectory_type IN ('resilient', 'recovery', 'chronic', 'depressed-improved')),
    
    -- Current PAD state (updated by tick system)
    current_p numeric(4,3) CHECK (current_p >= -1.0 AND current_p <= 1.0),
    current_a numeric(4,3) CHECK (current_a >= -1.0 AND current_a <= 1.0),
    current_d numeric(4,3) CHECK (current_d >= -1.0 AND current_d <= 1.0),
    
    -- Birth timestamp (immutable after creation)
    birth_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Omiyage interaction tracking (Winnicott comfort)
    omiyage_given BOOLEAN DEFAULT FALSE,
    omiyage_comfort numeric(3,2) CHECK (omiyage_comfort >= 0.0 AND omiyage_comfort <= 1.0),
    omiyage_given_at TIMESTAMP WITH TIME ZONE,
    
    -- Last update timestamp (auto-updated)
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    CONSTRAINT fk_trajectory_broll FOREIGN KEY (broll_character_id) REFERENCES characters(character_id),
    CONSTRAINT fk_trajectory_fracture FOREIGN KEY (fracture_event_id) REFERENCES fracture_events(event_id)
);

/*
 * ============================================================================
 * INDEXES
 * ============================================================================
 */

-- Fracture events: lookup by entity (source), B-Roll (target), or time
CREATE INDEX idx_fracture_events_entity ON fracture_events(entity_id);
CREATE INDEX idx_fracture_events_broll ON fracture_events(broll_character_id);
CREATE INDEX idx_fracture_events_created ON fracture_events(created_at);

-- Recovery: primary lookup by B-Roll, type filtering, update ordering
CREATE INDEX idx_recovery_trajectories_broll ON recovery_trajectories(broll_character_id);
CREATE INDEX idx_recovery_trajectories_type ON recovery_trajectories(trajectory_type);
CREATE INDEX idx_recovery_trajectories_updated ON recovery_trajectories(last_updated);

/*
 * ============================================================================
 * TRIGGER: Auto-update last_updated
 * ============================================================================
 */

CREATE OR REPLACE FUNCTION update_recovery_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_recovery_timestamp
    BEFORE UPDATE ON recovery_trajectories
    FOR EACH ROW
    EXECUTE FUNCTION update_recovery_timestamp();

/*
 * ============================================================================
 * VIEWS
 * ============================================================================
 */

-- Active B-Roll characters with current PAD (for Psychic Radar)
CREATE VIEW active_broll_pad AS
SELECT 
    rt.broll_character_id,
    rt.current_p as p,
    rt.current_a as a,
    rt.current_d as d,
    rt.trajectory_type,
    fe.object_type,
    fe.severity_factor,
    rt.birth_at,
    rt.omiyage_given,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - rt.birth_at)) / 3600 as hours_alive
FROM recovery_trajectories rt
JOIN fracture_events fe ON rt.fracture_event_id = fe.event_id
WHERE rt.current_p IS NOT NULL;

-- Summary statistics for monitoring
CREATE VIEW fracture_statistics AS
SELECT 
    object_type,
    predicted_trajectory,
    COUNT(*) as count,
    AVG(severity_factor) as avg_severity,
    AVG(fractured_p) as avg_p,
    AVG(fractured_a) as avg_a,
    AVG(fractured_d) as avg_d
FROM fracture_events
GROUP BY object_type, predicted_trajectory;

/*
 * ============================================================================
 * COMMENTS (PostgreSQL documentation)
 * ============================================================================
 */

COMMENT ON TABLE fracture_events IS 'Immutable record of B-Roll birth trauma events. One row per birth. Never update, never delete.';
COMMENT ON TABLE recovery_trajectories IS 'Mutable state tracking B-Roll emotional evolution. Updated every Psychic Engine tick.';
COMMENT ON COLUMN fracture_events.seed IS 'Mulberry32 PRNG seed. Allows deterministic reproduction of fracture result for debugging.';
COMMENT ON COLUMN recovery_trajectories.omiyage_given IS 'Whether Claude has given a comfort gift (transitional object intervention).';
