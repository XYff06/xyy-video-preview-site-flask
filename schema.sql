BEGIN;

/*
初始化数据库扩展
pg_trgm 用于支持标题模糊搜索
*/
CREATE EXTENSION IF NOT EXISTS pg_trgm;

/*
核心漫剧表
保存标题、封面和聚合统计字段
*/
CREATE TABLE IF NOT EXISTS title (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cover_url TEXT NOT NULL,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_episode_count INTEGER NOT NULL DEFAULT 0,
  current_max_episode_no INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT check_title_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT check_title_cover_url_not_blank CHECK (btrim(cover_url) <> ''),
  CONSTRAINT check_title_total_episode_count_non_negative CHECK (total_episode_count >= 0),
  CONSTRAINT check_title_current_max_episode_no_non_negative CHECK (current_max_episode_no >= 0)
);

/*
标题列表常用索引
分别服务于更新时间排序和名称模糊搜索
*/
CREATE INDEX IF NOT EXISTS index_title_updated_at ON title (updated_at DESC);
CREATE INDEX IF NOT EXISTS index_title_name_lower_trgm ON title USING GIN (LOWER(name) gin_trgm_ops);

/*
剧集表
每条记录表示某个漫剧下的一集视频
*/
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

/* 按标题查询剧集时会命中这个索引 */
CREATE INDEX IF NOT EXISTS index_episode_title_id ON episode (title_id);

/*
标签表
维护标签名称和展示顺序
*/
CREATE TABLE IF NOT EXISTS tag (
  id BIGSERIAL PRIMARY KEY,
  tag_name TEXT NOT NULL UNIQUE,
  sort_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_tag_name_not_blank CHECK (btrim(tag_name) <> '')
);

/*
漫剧与标签的关联表
一条记录表示某个漫剧绑定了一个标签
*/
CREATE TABLE IF NOT EXISTS title_tag (
  title_id BIGINT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, tag_id)
);

/* 这组索引用于标签筛选和漫剧详情回查 */
CREATE INDEX IF NOT EXISTS index_title_tag_tag_id_title_id ON title_tag (tag_id, title_id);
CREATE INDEX IF NOT EXISTS index_title_tag_title_id ON title_tag (title_id);

/*
统一维护 updated_at
任意更新 title 或 episode 时都会把时间刷新到当前时刻
*/
CREATE OR REPLACE FUNCTION function_set_updated_at_to_current_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/* title 更新前自动刷新 updated_at */
DROP TRIGGER IF EXISTS trigger_set_updated_at_before_update_on_title ON title;
CREATE TRIGGER trigger_set_updated_at_before_update_on_title
BEFORE UPDATE ON title FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

/* episode 更新前自动刷新 updated_at */
DROP TRIGGER IF EXISTS trigger_set_updated_at_before_update_on_episode ON episode;
CREATE TRIGGER trigger_set_updated_at_before_update_on_episode
BEFORE UPDATE ON episode FOR EACH ROW
EXECUTE FUNCTION function_set_updated_at_to_current_timestamp();

/*
剧集变更后同步漫剧统计字段
会刷新总集数、最大集号和标题更新时间
*/
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
    updated_at = NOW()
  WHERE id = target_title_id;

  IF TG_OP = 'UPDATE' AND NEW.title_id <> OLD.title_id THEN
    UPDATE title
    SET
      total_episode_count = (SELECT COUNT(*) FROM episode WHERE title_id = OLD.title_id),
      current_max_episode_no = (SELECT COALESCE(MAX(episode_no), 0) FROM episode WHERE title_id = OLD.title_id),
      updated_at = NOW()
    WHERE id = OLD.title_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

/* 新增剧集后回写所属漫剧统计 */
DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_insert ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_insert
AFTER INSERT ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

/* 修改剧集后回写所属漫剧统计 */
DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_update ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_update
AFTER UPDATE ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

/* 删除剧集后回写所属漫剧统计 */
DROP TRIGGER IF EXISTS trigger_synchronize_title_statistics_after_episode_delete ON episode;
CREATE TRIGGER trigger_synchronize_title_statistics_after_episode_delete
AFTER DELETE ON episode FOR EACH ROW
EXECUTE FUNCTION function_synchronize_title_statistics_after_episode_change();

COMMIT;
