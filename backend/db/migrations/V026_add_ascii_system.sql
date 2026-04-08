-- Migration: V026_add_ascii_system.sql
-- ASCII Art Engine and Character Animation System tables

BEGIN;

CREATE TABLE IF NOT EXISTS ascii_assets (
    ascii_asset_id VARCHAR(7) PRIMARY KEY
        CONSTRAINT chk_ascii_asset_id_format CHECK (ascii_asset_id ~ '^#[0-9A-F]{6}$'),
    source_asset_id VARCHAR(50) NOT NULL
        CONSTRAINT chk_source_asset_id_hex CHECK (source_asset_id ~ '^#[0-9A-F]{6}$'),
    resolution_mode VARCHAR(20) NOT NULL
        CONSTRAINT chk_resolution_mode CHECK (resolution_mode IN ('thumbnail', 'standard', 'detailed', 'high_detail')),
    char_set_mode VARCHAR(20) NOT NULL
        CONSTRAINT chk_char_set_mode CHECK (char_set_mode IN ('standard_ascii', 'extended_density', 'block_elements')),
    colour_mode VARCHAR(20) NOT NULL DEFAULT 'monochrome'
        CONSTRAINT chk_colour_mode CHECK (colour_mode IN ('monochrome', 'ansi', 'html_span')),
    edge_mode VARCHAR(20) NOT NULL DEFAULT 'none'
        CONSTRAINT chk_edge_mode CHECK (edge_mode IN ('none', 'edges_only', 'hybrid')),
    dithering_mode VARCHAR(20) NOT NULL DEFAULT 'none'
        CONSTRAINT chk_dithering_mode CHECK (dithering_mode IN ('none', 'bayer')),
    ascii_data TEXT NOT NULL
        CONSTRAINT chk_ascii_data_not_empty CHECK (LENGTH(ascii_data) > 0),
    width_chars INTEGER NOT NULL
        CONSTRAINT chk_width_chars_range CHECK (width_chars > 0 AND width_chars <= 200),
    height_chars INTEGER NOT NULL
        CONSTRAINT chk_height_chars_range CHECK (height_chars > 0 AND height_chars <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_ascii_assets_multimedia
        FOREIGN KEY (source_asset_id) REFERENCES multimedia_assets(asset_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ascii_assets_source ON ascii_assets(source_asset_id);
CREATE INDEX IF NOT EXISTS idx_ascii_assets_resolution ON ascii_assets(resolution_mode);

CREATE TABLE IF NOT EXISTS character_sprites (
    sprite_id VARCHAR(7) PRIMARY KEY
        CONSTRAINT chk_sprite_id_format CHECK (sprite_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL
        CONSTRAINT chk_sprite_character_id_format CHECK (character_id ~ '^#[0-9A-F]{6}$'),
    sprite_name VARCHAR(100) NOT NULL
        CONSTRAINT chk_sprite_name_length CHECK (LENGTH(sprite_name) >= 1),
    sprite_data TEXT NOT NULL
        CONSTRAINT chk_sprite_data_not_empty CHECK (LENGTH(sprite_data) > 0),
    width_chars INTEGER NOT NULL
        CONSTRAINT chk_sprite_width_range CHECK (width_chars > 0 AND width_chars <= 64),
    height_chars INTEGER NOT NULL
        CONSTRAINT chk_sprite_height_range CHECK (height_chars > 0 AND height_chars <= 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_sprites_character_profiles
        FOREIGN KEY (character_id) REFERENCES character_profiles(character_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sprites_character ON character_sprites(character_id);

CREATE TABLE IF NOT EXISTS animation_sequences (
    sequence_id VARCHAR(7) PRIMARY KEY
        CONSTRAINT chk_sequence_id_format CHECK (sequence_id ~ '^#[0-9A-F]{6}$'),
    character_id VARCHAR(7) NOT NULL
        CONSTRAINT chk_seq_character_id_format CHECK (character_id ~ '^#[0-9A-F]{6}$'),
    sequence_name VARCHAR(100) NOT NULL
        CONSTRAINT chk_sequence_name_length CHECK (LENGTH(sequence_name) >= 1),
    sequence_category VARCHAR(40) NOT NULL
        CONSTRAINT chk_sequence_category CHECK (sequence_category IN ('idle_breathe', 'idle_blink', 'idle_fidget', 'talk_start', 'talk_loop', 'talk_end', 'emotion_joy', 'emotion_distress', 'emotion_alert', 'surprise', 'sleep')),
    frame_rate INTEGER NOT NULL DEFAULT 12
        CONSTRAINT chk_frame_rate_range CHECK (frame_rate >= 1 AND frame_rate <= 30),
    loop BOOLEAN NOT NULL DEFAULT FALSE,
    total_frames INTEGER NOT NULL
        CONSTRAINT chk_total_frames_range CHECK (total_frames >= 1 AND total_frames <= 64),
    metadata JSONB DEFAULT '{}'::jsonb
        CONSTRAINT chk_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_sequences_character_profiles
        FOREIGN KEY (character_id) REFERENCES character_profiles(character_id)
        ON DELETE CASCADE,
    CONSTRAINT uq_sequence_character_name UNIQUE (character_id, sequence_name)
);

CREATE INDEX IF NOT EXISTS idx_sequences_character ON animation_sequences(character_id);
CREATE INDEX IF NOT EXISTS idx_sequences_category ON animation_sequences(sequence_category);
CREATE INDEX IF NOT EXISTS idx_sequences_character_category ON animation_sequences(character_id, sequence_category);

CREATE TABLE IF NOT EXISTS animation_frames (
    frame_id VARCHAR(7) PRIMARY KEY
        CONSTRAINT chk_frame_id_format CHECK (frame_id ~ '^#[0-9A-F]{6}$'),
    sequence_id VARCHAR(7) NOT NULL
        CONSTRAINT chk_frame_sequence_id_format CHECK (sequence_id ~ '^#[0-9A-F]{6}$'),
    frame_index INTEGER NOT NULL
        CONSTRAINT chk_frame_index_range CHECK (frame_index >= 0 AND frame_index <= 63),
    is_base BOOLEAN NOT NULL DEFAULT FALSE,
    frame_data TEXT,
    delta_data JSONB,
    duration_ms INTEGER
        CONSTRAINT chk_duration_range CHECK (duration_ms IS NULL OR (duration_ms >= 10 AND duration_ms <= 2000)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_frame_data_base CHECK (
        (is_base = TRUE AND frame_data IS NOT NULL AND delta_data IS NULL)
        OR
        (is_base = FALSE AND frame_data IS NULL AND delta_data IS NOT NULL AND jsonb_typeof(delta_data) = 'array')
    ),
    CONSTRAINT fk_frames_sequences
        FOREIGN KEY (sequence_id) REFERENCES animation_sequences(sequence_id)
        ON DELETE CASCADE,
    CONSTRAINT uq_frames_sequence_index UNIQUE (sequence_id, frame_index)
);

CREATE INDEX IF NOT EXISTS idx_frames_sequence ON animation_frames(sequence_id, frame_index);
CREATE INDEX IF NOT EXISTS idx_frames_base ON animation_frames(sequence_id, is_base) WHERE is_base = TRUE;

CREATE TABLE IF NOT EXISTS animation_transitions (
    transition_id VARCHAR(7) PRIMARY KEY
        CONSTRAINT chk_transition_id_format CHECK (transition_id ~ '^#[0-9A-F]{6}$'),
    from_sequence_id VARCHAR(7) NOT NULL
        CONSTRAINT chk_trans_from_id_format CHECK (from_sequence_id ~ '^#[0-9A-F]{6}$'),
    to_sequence_id VARCHAR(7) NOT NULL
        CONSTRAINT chk_trans_to_id_format CHECK (to_sequence_id ~ '^#[0-9A-F]{6}$'),
    trigger_type VARCHAR(40) NOT NULL
        CONSTRAINT chk_trigger_type CHECK (trigger_type IN ('on_speech_start', 'on_speech_end', 'on_emotion_joy', 'on_emotion_distress', 'on_emotion_alert', 'on_surprise', 'on_sleep', 'on_idle_timeout', 'on_blink_timer', 'on_fidget_timer', 'on_sequence_complete')),
    trigger_conditions JSONB DEFAULT NULL,
    priority INTEGER NOT NULL DEFAULT 0
        CONSTRAINT chk_priority_range CHECK (priority >= 0 AND priority <= 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_transitions_from_sequence
        FOREIGN KEY (from_sequence_id) REFERENCES animation_sequences(sequence_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_transitions_to_sequence
        FOREIGN KEY (to_sequence_id) REFERENCES animation_sequences(sequence_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_transitions_from ON animation_transitions(from_sequence_id);
CREATE INDEX IF NOT EXISTS idx_transitions_trigger ON animation_transitions(trigger_type, priority);
CREATE INDEX IF NOT EXISTS idx_transitions_lookup ON animation_transitions(from_sequence_id, trigger_type);

CREATE OR REPLACE FUNCTION update_ascii_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ascii_assets_updated_at ON ascii_assets;
CREATE TRIGGER trg_ascii_assets_updated_at 
    BEFORE UPDATE ON ascii_assets 
    FOR EACH ROW 
    EXECUTE FUNCTION update_ascii_updated_at();

DROP TRIGGER IF EXISTS trg_character_sprites_updated_at ON character_sprites;
CREATE TRIGGER trg_character_sprites_updated_at 
    BEFORE UPDATE ON character_sprites 
    FOR EACH ROW 
    EXECUTE FUNCTION update_ascii_updated_at();

DROP TRIGGER IF EXISTS trg_animation_sequences_updated_at ON animation_sequences;
CREATE TRIGGER trg_animation_sequences_updated_at 
    BEFORE UPDATE ON animation_sequences 
    FOR EACH ROW 
    EXECUTE FUNCTION update_ascii_updated_at();

COMMIT;
