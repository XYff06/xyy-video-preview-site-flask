BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS title (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cover_url TEXT,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_new_episode_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_episode_count INTEGER NOT NULL DEFAULT 0,
  current_max_episode_no INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT check_title_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT check_title_total_episode_count_non_negative CHECK (total_episode_count >= 0),
  CONSTRAINT check_title_current_max_episode_no_non_negative CHECK (current_max_episode_no >= 0)
);

CREATE INDEX IF NOT EXISTS index_title_updated_at ON title (updated_at DESC);
CREATE INDEX IF NOT EXISTS index_title_updated_at_name ON title (updated_at DESC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_first_ingested_at_name ON title (first_ingested_at DESC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_last_new_episode_at ON title (last_new_episode_at DESC);
CREATE INDEX IF NOT EXISTS index_title_name ON title (name ASC);
CREATE INDEX IF NOT EXISTS index_title_name_lower_trgm ON title USING GIN (LOWER(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS episode (
  id BIGSERIAL PRIMARY KEY,
  title_id BIGINT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL,
  episode_name TEXT NOT NULL DEFAULT '',
  episode_url TEXT NOT NULL,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_episode_title_id_episode_no UNIQUE (title_id, episode_no),
  CONSTRAINT check_episode_episode_no_positive CHECK (episode_no > 0),
  CONSTRAINT check_episode_episode_url_not_blank CHECK (btrim(episode_url) <> '')
);

CREATE INDEX IF NOT EXISTS index_episode_title_id ON episode (title_id);
CREATE INDEX IF NOT EXISTS index_episode_title_id_episode_no ON episode (title_id, episode_no);
CREATE INDEX IF NOT EXISTS index_episode_title_id_first_ingested_at ON episode (title_id, first_ingested_at DESC);

CREATE TABLE IF NOT EXISTS tag (
  id BIGSERIAL PRIMARY KEY,
  tag_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_tag_name_not_blank CHECK (btrim(tag_name) <> '')
);

CREATE TABLE IF NOT EXISTS title_tag (
  title_id BIGINT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, tag_id)
);

CREATE INDEX IF NOT EXISTS index_title_tag_tag_id_title_id ON title_tag (tag_id, title_id);
CREATE INDEX IF NOT EXISTS index_title_tag_title_id ON title_tag (title_id);

CREATE OR REPLACE FUNCTION function_set_updated_at_to_current_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_updated_at_before_update_on_title ON title;
CREATE TRIGGER trigger_set_updated_at_before_update_on_title
BEFORE UPDATE ON title FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

DROP TRIGGER IF EXISTS trigger_set_updated_at_before_update_on_episode ON episode;
CREATE TRIGGER trigger_set_updated_at_before_update_on_episode
BEFORE UPDATE ON episode FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

CREATE OR REPLACE FUNCTION function_synchronize_title_statistics_after_episode_change()
RETURNS TRIGGER AS $$
DECLARE
  target_title_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_title_id := OLD.title_id;
  ELSE
    target_title_id := NEW.title_id;
  END IF;

  UPDATE title
  SET
    total_episode_count = (SELECT COUNT(*) FROM episode WHERE title_id = target_title_id),
    current_max_episode_no = (SELECT COALESCE(MAX(episode_no), 0) FROM episode WHERE title_id = target_title_id),
    last_new_episode_at = COALESCE(
      (SELECT MAX(first_ingested_at) FROM episode WHERE title_id = target_title_id),
      (SELECT first_ingested_at FROM title WHERE id = target_title_id)
    ),
    updated_at = NOW()
  WHERE id = target_title_id;

  IF TG_OP = 'UPDATE' AND NEW.title_id <> OLD.title_id THEN
    UPDATE title
    SET
      total_episode_count = (SELECT COUNT(*) FROM episode WHERE title_id = OLD.title_id),
      current_max_episode_no = (SELECT COALESCE(MAX(episode_no), 0) FROM episode WHERE title_id = OLD.title_id),
      last_new_episode_at = COALESCE(
        (SELECT MAX(first_ingested_at) FROM episode WHERE title_id = OLD.title_id),
        (SELECT first_ingested_at FROM title WHERE id = OLD.title_id)
      ),
      updated_at = NOW()
    WHERE id = OLD.title_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_insert ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_insert
AFTER INSERT ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_update ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_update
AFTER UPDATE ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_delete ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_delete
AFTER DELETE ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

COMMIT;
