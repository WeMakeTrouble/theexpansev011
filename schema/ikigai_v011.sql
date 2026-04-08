-- Ikigai Engine v011 Schema

ALTER TABLE ikigai_state
    ALTER COLUMN recorded_at TYPE TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS okinawan_confidence VARCHAR(10)
        CHECK (okinawan_confidence IN ('high', 'medium', 'low')),
    ADD CONSTRAINT ikigai_state_character_unique UNIQUE (character_id);

ALTER TABLE ikigai_history
    ALTER COLUMN recorded_at TYPE TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE conversation_states
    ADD COLUMN IF NOT EXISTS is_rewatch BOOLEAN NOT NULL DEFAULT false,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS character_sdt_state (
    sdt_state_id VARCHAR(7) PRIMARY KEY CHECK (sdt_state_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL CHECK (character_id ~ '^#[0-9A-F]{6}$')
        REFERENCES character_profiles(character_id),
    autonomy_satisfaction    NUMERIC(4,3) NOT NULL CHECK (autonomy_satisfaction    BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    autonomy_frustration     NUMERIC(4,3) NOT NULL CHECK (autonomy_frustration     BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    competence_satisfaction  NUMERIC(4,3) NOT NULL CHECK (competence_satisfaction  BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    competence_frustration   NUMERIC(4,3) NOT NULL CHECK (competence_frustration   BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    relatedness_satisfaction NUMERIC(4,3) NOT NULL CHECK (relatedness_satisfaction BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    relatedness_frustration  NUMERIC(4,3) NOT NULL CHECK (relatedness_frustration  BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    derived_from_personality_hash VARCHAR(64) NOT NULL,
    computation_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(character_id)
);

CREATE TABLE IF NOT EXISTS passion_state (
    passion_id VARCHAR(7) PRIMARY KEY CHECK (passion_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL CHECK (character_id ~ '^#[0-9A-F]{6}$')
        REFERENCES character_profiles(character_id),
    harmonious_passion NUMERIC(4,3) NOT NULL CHECK (harmonious_passion BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    obsessive_passion  NUMERIC(4,3) NOT NULL CHECK (obsessive_passion  BETWEEN 0.0 AND 1.0) DEFAULT 0.5,
    passion_ratio      NUMERIC(4,3) NOT NULL DEFAULT 0.5,
    trend_direction VARCHAR(10) CHECK (trend_direction IN ('improving', 'declining', 'stable')),
    trend_magnitude NUMERIC(4,3) CHECK (trend_magnitude BETWEEN 0.0 AND 1.0),
    source_domains JSONB NOT NULL DEFAULT '{}',
    last_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(character_id)
);

CREATE TABLE IF NOT EXISTS behavioral_baselines (
    baseline_id VARCHAR(7) PRIMARY KEY CHECK (baseline_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL CHECK (character_id ~ '^#[0-9A-F]{6}$')
        REFERENCES character_profiles(character_id),
    session_frequency_ema    NUMERIC(5,4) NOT NULL DEFAULT 0.5,
    session_duration_ema     NUMERIC(5,4) NOT NULL DEFAULT 0.5,
    inter_session_gap_ema    NUMERIC(5,4) NOT NULL DEFAULT 0.5,
    teaching_ratio_ema       NUMERIC(4,3) NOT NULL DEFAULT 0.0,
    reciprocal_proximity_ema NUMERIC(4,3) NOT NULL DEFAULT 0.5,
    reciprocal_proximity_samples INTEGER NOT NULL DEFAULT 0,
    current_alpha NUMERIC(3,2) NOT NULL DEFAULT 0.70,
    sample_count  INTEGER      NOT NULL DEFAULT 0,
    last_session_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(character_id)
);

CREATE TABLE IF NOT EXISTS ikigai_alerts (
    alert_id VARCHAR(7) PRIMARY KEY CHECK (alert_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL CHECK (character_id ~ '^#[0-9A-F]{6}$')
        REFERENCES character_profiles(character_id),
    alert_type VARCHAR(30) NOT NULL CHECK (
        alert_type IN ('maslach_critical', 'obsessive_extractive', 'ikigai_collapse', 'moai_rupture')
    ),
    severity VARCHAR(10) NOT NULL CHECK (severity IN ('warning', 'critical')),
    details JSONB NOT NULL DEFAULT '{}',
    handled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ikigai_alerts_unhandled
ON ikigai_alerts(character_id, handled) WHERE handled = false;

CREATE TABLE IF NOT EXISTS ikigai_policy_log (
    log_id VARCHAR(7) PRIMARY KEY CHECK (log_id ~ '^#[0-9A-F]{6}$'),
    mapping_version INTEGER NOT NULL,
    sdt_prior_hash  VARCHAR(64) NOT NULL,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
