BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS title (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cover_url TEXT,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_episode_count INTEGER NOT NULL DEFAULT 0,
  current_max_episode_no INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT check_title_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT check_title_total_episode_count_non_negative CHECK (total_episode_count >= 0),
  CONSTRAINT check_title_current_max_episode_no_non_negative CHECK (current_max_episode_no >= 0)
);

CREATE INDEX IF NOT EXISTS index_title_updated_at_name ON title (updated_at DESC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_updated_at_asc_name ON title (updated_at ASC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_first_ingested_at_name ON title (first_ingested_at DESC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_first_ingested_at_asc_name ON title (first_ingested_at ASC, name ASC);
CREATE INDEX IF NOT EXISTS index_title_name_lower_trgm ON title USING GIN (LOWER(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS episode (
  id BIGSERIAL PRIMARY KEY,
  title_id BIGINT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL,
  episode_url TEXT NOT NULL,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_episode_title_id_episode_no UNIQUE (title_id, episode_no),
  CONSTRAINT check_episode_episode_no_positive CHECK (episode_no > 0),
  CONSTRAINT check_episode_episode_url_not_blank CHECK (btrim(episode_url) <> '')
);

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

CREATE OR REPLACE FUNCTION function_set_updated_at_to_current_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION function_refresh_title_statistics_for_title_ids(target_title_ids BIGINT[])
RETURNS VOID AS $$
BEGIN
  IF COALESCE(array_length(target_title_ids, 1), 0) = 0 THEN
    RETURN;
  END IF;

  WITH affected_title_ids AS (
    SELECT DISTINCT UNNEST(target_title_ids) AS title_id
  ),
  episode_statistics AS (
    SELECT
      affected_title_ids.title_id,
      COUNT(episode.id)::int AS total_episode_count,
      COALESCE(MAX(episode.episode_no), 0) AS current_max_episode_no
    FROM affected_title_ids
    LEFT JOIN episode ON episode.title_id = affected_title_ids.title_id
    GROUP BY affected_title_ids.title_id
  )
  UPDATE title
  SET
    total_episode_count = episode_statistics.total_episode_count,
    current_max_episode_no = episode_statistics.current_max_episode_no,
    updated_at = NOW()
  FROM episode_statistics
  WHERE title.id = episode_statistics.title_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION function_synchronize_title_statistics_after_episode_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM function_refresh_title_statistics_for_title_ids(
    ARRAY(SELECT DISTINCT title_id FROM inserted_episode_rows)
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION function_synchronize_title_statistics_after_episode_update()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM function_refresh_title_statistics_for_title_ids(
    ARRAY(
      SELECT DISTINCT title_id
      FROM (
        SELECT title_id FROM new_episode_rows
        UNION
        SELECT title_id FROM old_episode_rows
      ) AS affected_episode_rows
    )
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION function_synchronize_title_statistics_after_episode_delete()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM function_refresh_title_statistics_for_title_ids(
    ARRAY(SELECT DISTINCT title_id FROM deleted_episode_rows)
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_updated_at_before_update_on_title
BEFORE UPDATE ON title FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

CREATE TRIGGER trigger_set_updated_at_before_update_on_episode
BEFORE UPDATE ON episode FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_insert
AFTER INSERT ON episode
REFERENCING NEW TABLE AS inserted_episode_rows
FOR EACH STATEMENT
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_insert();

CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_update
AFTER UPDATE ON episode
REFERENCING OLD TABLE AS old_episode_rows NEW TABLE AS new_episode_rows
FOR EACH STATEMENT
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_update();

CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_delete
AFTER DELETE ON episode
REFERENCING OLD TABLE AS deleted_episode_rows
FOR EACH STATEMENT
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_delete();

COMMIT;
