BEGIN;

ALTER TABLE sessions
  ADD COLUMN ai_consent_version text,
  ADD COLUMN ai_consent_at timestamptz,
  ADD COLUMN voice_consent_version text,
  ADD COLUMN voice_consent_at timestamptz;

ALTER TABLE conversations
  ADD COLUMN kind text NOT NULL DEFAULT 'campus',
  ADD COLUMN mode text,
  ADD COLUMN scenario text;

ALTER TABLE conversations DROP CONSTRAINT conversations_session_id_key;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('campus', 'practice'));

ALTER TABLE conversations
  ADD CONSTRAINT conversations_mode_check CHECK (mode IS NULL OR mode IN ('teaching', 'freeChat'));

ALTER TABLE conversations
  ADD CONSTRAINT conversations_session_kind_unique UNIQUE (session_id, kind);

CREATE TABLE visit_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_turn_id uuid NOT NULL,
  source_text text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('yue_to_en', 'yue_to_zh', 'en_to_yue', 'zh_to_yue')),
  effective_direction text NOT NULL CHECK (effective_direction IN ('yue_to_en', 'yue_to_zh', 'en_to_yue', 'zh_to_yue')),
  user_job text,
  input_type text NOT NULL DEFAULT 'text',
  translated_text text NOT NULL,
  display_text text NOT NULL,
  romanization jsonb,
  auto_routed boolean NOT NULL DEFAULT false,
  route_reason text,
  needs_confirmation boolean NOT NULL DEFAULT false,
  provider text NOT NULL,
  suppress_tts boolean NOT NULL DEFAULT false,
  voice_draft_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, client_turn_id)
);

CREATE TABLE answer_reports (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid,
  conversation_kind text NOT NULL CHECK (conversation_kind IN ('campus', 'practice', 'visit')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO schema_migrations (version) VALUES (2);

COMMIT;
