import math
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import psycopg
import requests
import tos
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row

flask_app = Flask(__name__, template_folder="templates", static_folder="static")
flask_app.config["JSON_AS_ASCII"] = False
ROOT_DIRECTORY = Path(__file__).resolve().parent  # 项目根目录
load_dotenv(ROOT_DIRECTORY / ".env")
SERIES_PAGE_CACHE_TTL_SECONDS = 3
SERIES_PAGE_CACHE_MAX_ENTRIES = 32
series_page_query_cache = {}


# def query_flat_episode_ingest_records():
#     """查询按剧集展开的导入记录列表
#
#     返回结果已经是管理视图可直接消费的扁平结构
#     """
#     with open_db_connection() as conn, conn.cursor() as cur:
#         cur.execute(
#             """
#             SELECT t.name,
#                    e.episode_no        AS episode,
#                    t.cover_url         AS poster,
#                    e.episode_url       AS "videoUrl",
#                    e.first_ingested_at AS "firstIngestedAt",
#                    e.updated_at        AS "updatedAt",
#                    COALESCE(
#                            ARRAY_AGG(g.tag_name ORDER BY g.sort_no, g.tag_name) FILTER(WHERE g.tag_name IS NOT NULL),
#                            ARRAY[] ::text[]
#                    )                   AS tags
#             FROM title t
#                      JOIN episode e ON e.title_id = t.id
#                      LEFT JOIN title_tag tt ON tt.title_id = t.id
#                      LEFT JOIN tag g ON g.id = tt.tag_id
#             GROUP BY t.id, e.id
#             ORDER BY t.name, e.episode_no
#             """
#         )
#         rows = cur.fetchall()
#     out = []
#     for row in rows:
#         # 这里按剧集逐条展开
#         # 前端管理视图可以直接按行渲染每一集的导入信息
#         out.append(
#             {
#                 "name": row["name"],
#                 "episode": int(row["episode"]),
#                 "poster": row["poster"],
#                 "videoUrl": row["videoUrl"],
#                 "firstIngestedAt": convert_to_iso_datetime(row["firstIngestedAt"]),
#                 "updatedAt": convert_to_iso_datetime(row["updatedAt"]),
#                 "tags": row.get("tags") or [],
#             }
#         )
#     return out
#
#
# @flask_app.route("/api/ingest-records", methods=["GET"])
# def api_ingest_records():
#     return build_json_response(200, data=query_flat_episode_ingest_records())


def get_normalized_environment_variable(environment_variable_name: str):
    """
    读取环境变量
    :param environment_variable_name: 环境变量名
    :return: None/strip后的环境变量值
    """
    value = os.getenv(environment_variable_name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def build_postgresql_connection_url() -> str:
    """
    从环境变量读取PostgreSQL连接信息，然后拼接成连接数据库用的DSN字符串
    :return: 配置了密码，return postgresql://user:password@host:port/database；没有配置密码，return postgresql://user@host:port/database
    """
    postgresql_host = get_normalized_environment_variable("POSTGRESQL_HOST")
    postgresql_port = get_normalized_environment_variable("POSTGRESQL_PORT")
    postgresql_user = get_normalized_environment_variable("POSTGRESQL_USER")
    postgresql_password = get_normalized_environment_variable("POSTGRESQL_PASSWORD")
    postgresql_database = get_normalized_environment_variable("POSTGRESQL_DATABASE")
    if postgresql_password:
        return f"postgresql://{postgresql_user}:{postgresql_password}@{postgresql_host}:{postgresql_port}/{postgresql_database}"
    return f"postgresql://{postgresql_user}@{postgresql_host}:{postgresql_port}/{postgresql_database}"


@contextmanager
def open_db_connection():
    """
    打开一个PostgreSQL数据库连接，这里会创建一个新的数据库连接，并把查询结果设置为字典行格式，使用结束后会自动关闭这个连接
    :return: psycopg.Connection: 当前打开的数据库连接对象
    """
    db_connection = psycopg.connect(build_postgresql_connection_url(), row_factory=dict_row, )
    try:
        yield db_connection
    finally:
        db_connection.close()


@contextmanager
def open_db_connection_in_transaction():
    """
    打开一个带事务的PostgreSQL数据库连接，这里会先创建数据库连接，然后在这个连接上开启事务

    with代码块里的数据库操作都会运行在同一个事务中:
    1. 如果代码块正常结束，这个事务会提交
    2. 如果代码块抛出异常，这个事务会回滚
    :return: psycopg.Connection: 当前处于事务中的数据库连接对象
    """
    with open_db_connection() as db_connection:
        with db_connection.transaction():
            yield db_connection


def get_required_oss_config():
    """
    读取必填的OSS相关环境变量

    Returns:
        tuple[str, str, str, str, str]:
            按顺序返回access_key、secret_key、endpoint、region、bucket_name

    Raises:
        Exception:
            当任意必填OSS环境变量缺失时抛出异常
    """
    access_key = get_normalized_environment_variable("OSS_ACCESS_KEY")
    secret_key = get_normalized_environment_variable("OSS_SECRET_KEY")
    endpoint = get_normalized_environment_variable("OSS_ENDPOINT")
    region = get_normalized_environment_variable("OSS_REGION")
    bucket_name = get_normalized_environment_variable("OSS_BUCKET_NAME")
    missing = [
        name
        for name, current in (
            ("OSS_ACCESS_KEY", access_key),
            ("OSS_SECRET_KEY", secret_key),
            ("OSS_ENDPOINT", endpoint),
            ("OSS_REGION", region),
            ("OSS_BUCKET_NAME", bucket_name),
        )
        if not current
    ]
    if missing:
        raise ValueError(f"缺少OSS配置: {'、'.join(missing)}")
    return access_key, secret_key, endpoint, region, bucket_name


def resolve_resource_to_url(value: str, name: str, local_path_kind: str = "any"):
    """
    把资源输入转换成可访问地址
    :param value: 资源输入
    :param name: 漫剧名
    :param local_path_kind: 文件类型
    :return: url/url_list
    """
    normalized = value.strip()
    if urlparse(normalized).scheme in {"http", "https"} and bool(urlparse(normalized).netloc):
        return normalized

    access_key, secret_key, endpoint, region, bucket_name = get_required_oss_config()
    access_key = (access_key or "").strip()
    secret_key = (secret_key or "").strip()
    endpoint = (endpoint or "").strip()
    region = (region or "").strip()
    bucket_name = (bucket_name or "").strip()

    try:
        path_object = Path(normalized).expanduser().resolve(strict=True)
    except FileNotFoundError:
        raise ValueError(f"Not Found: {normalized}")
    except Exception as path_error:
        raise ValueError(f"路径解析失败: {path_error}")

    client = tos.TosClientV2(access_key, secret_key, endpoint, region)

    if local_path_kind not in {"any", "file", "dir"}:
        raise ValueError(f"local_path_kind参数错误: {local_path_kind}")

    # 文件输入会上传一个对象并返回单个访问地址
    if path_object.is_file():
        if local_path_kind == "dir":
            raise Exception("本地路径必须是目录，不能是文件")
        # 上传前给文件名追加时间戳，这样多次导入同名文件时不会互相覆盖
        filename_with_timestamp = append_millisecond_timestamp_to_filename(path_object)
        key = f"{name}/{filename_with_timestamp}"
        response = client.put_object_from_file(bucket_name, key, str(path_object))
        if getattr(response, "status_code", None) != 200:
            raise ValueError(f"上传失败，status_code={getattr(response, 'status_code', 'unknown')}")
        return f"https://{bucket_name}.{endpoint}/{key}"

    # 目录输入会递归上传所有文件，返回值会是一组可直接访问的视频地址列表
    if path_object.is_dir():
        if local_path_kind == "file":
            raise Exception("本地路径必须是文件，不能是目录")
        url_list = []
        for file_path in sorted(path_object.rglob("*")):
            # 目录节点本身不上传
            if not file_path.is_file():
                continue

            # 记录相对路径可以把原目录层级带到对象存储里
            relative_path = file_path.relative_to(path_object)
            parent_dir = relative_path.parent.as_posix()
            filename_with_timestamp = append_millisecond_timestamp_to_filename(file_path)

            # 子目录结构会一起写进key，这样返回的URL仍然保留原始目录层级
            if parent_dir and parent_dir != ".":
                key = f"{name}/{parent_dir}/{filename_with_timestamp}"
            else:
                key = f"{name}/{filename_with_timestamp}"

            response = client.put_object_from_file(bucket_name, key, str(file_path))
            if getattr(response, "status_code", None) != 200:
                raise ValueError(f"上传失败: {file_path}，status_code={getattr(response, 'status_code', 'unknown')}")

            url_list.append(f"https://{bucket_name}.{endpoint}/{key}")

        if not url_list:
            raise Exception("目录为空或目录下没有可上传文件")

        return url_list

    raise Exception("输入路径既不是文件也不是目录")


def append_millisecond_timestamp_to_filename(path_object: Path) -> str:
    """给文件名追加毫秒时间戳，避免上传到对象存储时发生同名覆盖"""
    suffixes = "".join(path_object.suffixes)
    timestamp = int(time.time() * 1000)

    if suffixes:
        base_name = path_object.name[:-len(suffixes)]
        return f"{base_name}_{timestamp}{suffixes}"

    return f"{path_object.name}_{timestamp}"


def build_json_response(status: int, **payload):
    """构造统一的JSON响应对象并写入状态码"""
    if request.method != "GET" and 200 <= status < 400:
        # 成功的写操作会改变series列表结果，这里统一清空短TTL缓存
        invalidate_series_page_cache()
    response = jsonify(payload)
    response.status_code = status
    return response


@flask_app.errorhandler(Exception)
def handle_unexpected_error(error):
    """兜底异常处理器，把未捕获异常整理成统一的JSON错误响应"""
    message = str(error) or "Internal server error"
    if "connection failed: connection to server at" in message:
        return build_json_response(
            500,
            message="数据库认证失败: 当前PostgreSQL配置有误，请检查.env文件里的PostgreSQL配置",
        )
    return build_json_response(500, message=message)


def convert_to_iso_datetime(value):
    """把数据库时间值统一转换成ISO字符串"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


@flask_app.route("/api/health", methods=["GET"])
def api_health():
    """检查Flask接口是否能正常执行；检查数据库是否可用"""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT 1")
        db_cursor.fetchone()
    return build_json_response(200, result="ok")


def normalize_positive_int(value, default, max_value=None):
    """
    把输入值规范成正整数
    Args:
        value:
            需要解析的输入值
        default:
            解析失败或结果不是正整数时返回的默认值
        max_value:
            允许的最大值，不为None时，返回值不会超过这个上限
    Returns:
        int:
            规范化后的正整数结果
    """
    try:
        parsed = int(value)
    except Exception:
        return default
    if parsed <= 0:
        return default
    if max_value is not None:
        return min(parsed, max_value)
    return parsed


def build_series_order_by_sql(sort: str | None) -> str:
    """把排序参数映射成SQL的ORDER BY片段"""
    sort_map = {
        "updated_desc": "title.updated_at DESC, title.name ASC",
        "updated_asc": "title.updated_at ASC, title.name ASC",
        "ingested_asc": "title.first_ingested_at ASC, title.name ASC",
        "ingested_desc": "title.first_ingested_at DESC, title.name ASC",
        "name_asc": "title.name ASC",
        "name_desc": "title.name DESC",
    }
    return sort_map.get(sort or "", sort_map["updated_desc"])


def build_series_page_cache_key(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
    """把分页查询参数整理成稳定缓存键，命中后可以直接复用列表结果"""
    normalized_search = search.strip().lower() if isinstance(search, str) and search.strip() else None
    return tag, name, normalized_search, sort or "updated_desc", page, page_size


def get_cached_series_page_payload(cache_key):
    """读取仍在有效期内的列表缓存，过期项会顺手清掉"""
    cached_entry = series_page_query_cache.get(cache_key)
    if not cached_entry:
        return None

    expires_at, payload = cached_entry
    if expires_at <= time.monotonic():
        series_page_query_cache.pop(cache_key, None)
        return None
    return payload


def store_series_page_payload(cache_key, payload):
    """写入列表缓存前先清理过期项，再限制缓存条目数量"""
    current_time = time.monotonic()
    expired_keys = [key for key, (expires_at, _) in series_page_query_cache.items() if expires_at <= current_time]
    for expired_key in expired_keys:
        series_page_query_cache.pop(expired_key, None)

    while len(series_page_query_cache) >= SERIES_PAGE_CACHE_MAX_ENTRIES:
        oldest_key = next(iter(series_page_query_cache))
        series_page_query_cache.pop(oldest_key, None)

    series_page_query_cache[cache_key] = (current_time + SERIES_PAGE_CACHE_TTL_SECONDS, payload)


def invalidate_series_page_cache():
    """标题 标签 剧集发生写入后清空分页缓存，避免读到旧结果"""
    series_page_query_cache.clear()


def serialize_series_record(row):
    """把聚合后的漫剧记录转换成前端可直接渲染的结构"""
    episodes = row.get("episodes") or []
    return {
        "id": row["id"],
        "name": row["name"],
        "poster": row["poster"],
        "firstIngestedAt": convert_to_iso_datetime(row["firstIngestedAt"]),
        "updatedAt": convert_to_iso_datetime(row["updatedAt"]),
        "lastNewEpisodeAt": convert_to_iso_datetime(row["lastNewEpisodeAt"]),
        "tags": row.get("tags") or [],
        # 列表推导会把聚合结果里的每一集重新整理成统一字段
        "episodes": [
            {
                "episode": int(episode["episode"]),
                "firstIngestedAt": convert_to_iso_datetime(episode["firstIngestedAt"]),
                "updatedAt": convert_to_iso_datetime(episode["updatedAt"]),
                "videoUrl": episode["videoUrl"],
            }
            for episode in episodes
        ],
    }


def serialize_series_list_record(row):
    """把列表查询结果整理成首页卡片可直接消费的结构"""
    return {
        "id": row["id"],
        "name": row["name"],
        "poster": row["poster"],
        "firstIngestedAt": convert_to_iso_datetime(row["firstIngestedAt"]),
        "updatedAt": convert_to_iso_datetime(row["updatedAt"]),
        "lastNewEpisodeAt": convert_to_iso_datetime(row["lastNewEpisodeAt"]),
        "tags": row.get("tags") or [],
        "totalEpisodeCount": int(row.get("totalEpisodeCount") or 0),
        "currentMaxEpisodeNo": int(row.get("currentMaxEpisodeNo") or 0),
    }


def serialize_series_detail_record(row):
    """把详情查询结果整理成详情页可直接消费的结构"""
    payload = serialize_series_record(row)
    payload["totalEpisodeCount"] = int(row.get("totalEpisodeCount") or len(payload["episodes"]))
    payload["currentMaxEpisodeNo"] = int(row.get("currentMaxEpisodeNo") or 0)
    return payload


def query_series_page_data(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
    cache_key = build_series_page_cache_key(tag=tag, name=name, search=search, sort=sort, page=page, page_size=page_size)
    cached_payload = get_cached_series_page_payload(cache_key)
    if cached_payload is not None:
        return cached_payload
    """
    把前端传来的筛选条件转换成SQL:
    1. 分页选出当前页的漫剧
    2. 把每部漫剧关联的标签和剧集一起聚合出来
    3. 最后整理成前端直接能渲染的JSON结构
    """
    filters = []  # filters保存WHERE里的条件片段
    values = []  # values保存这些条件对应的参数值

    # 如果前端传了标签，就把标签值加入参数列表，后面会传给%s占位符
    if tag:
        values.append(tag)
        # 筛选出拥有指定标签的title
        filters.append("""EXISTS (SELECT 1 FROM title_tag JOIN tag ON tag.id = title_tag.tag_id WHERE title_tag.title_id = title.id AND tag.tag_name = %s)""")
    if name:
        values.append(name)
        filters.append("title.name = %s")
    if search:
        # 搜索关键字会先转成小写，再和LOWER(name)做模糊匹配
        values.append(f"%{search.strip().lower()}%")
        filters.append("LOWER(title.name) LIKE %s")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    order_by_clause = build_series_order_by_sql(sort)
    order_by_selected_titles = order_by_clause.replace("title.", "paged_titles.")

    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute(f"""SELECT COUNT(*)::int AS total FROM title {where_clause}""", values, )
        total = db_cursor.fetchone()["total"] or 0
        total_pages = max(1, math.ceil(total / page_size))
        safe_page = max(1, min(page, total_pages))
        offset = (safe_page - 1) * page_size

        # 先分页拿到当前页title，再分别按title聚合剧集和标签，避免episode和tag做JOIN后放大结果集
        db_cursor.execute(
            f"""
            WITH paged_titles AS (
              SELECT
                title.id,
                title.name,
                title.cover_url,
                title.first_ingested_at,
                title.last_new_episode_at,
                title.updated_at,
                title.total_episode_count,
                title.current_max_episode_no
              FROM title
              {where_clause}
              ORDER BY {order_by_clause}
              LIMIT %s OFFSET %s
            )
            SELECT
              paged_titles.id,
              paged_titles.name,
              paged_titles.cover_url AS poster,
              paged_titles.first_ingested_at AS firstIngestedAt,
              paged_titles.updated_at AS updatedAt,
              paged_titles.total_episode_count AS totalEpisodeCount,
              paged_titles.current_max_episode_no AS currentMaxEpisodeNo,
              paged_titles.last_new_episode_at AS lastNewEpisodeAt,
              COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags
            FROM paged_titles
            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  ARRAY_AGG(tag.tag_name ORDER BY tag.sort_no, tag.tag_name),
                  ARRAY[]::text[]
                ) AS tags
              FROM title_tag
              JOIN tag ON tag.id = title_tag.tag_id
              WHERE title_tag.title_id = paged_titles.id
            ) AS tag_summary ON TRUE
            ORDER BY {order_by_selected_titles}
            """,
            [*values, page_size, offset],
        )
        rows = db_cursor.fetchall()

    # 列表推导会把数据库行逐条转换成前端直接可消费的结构
    data = [serialize_series_list_record(row) for row in rows]
    payload = {
        "data": data,
        "pagination": {
            "total": total,
            "page": safe_page,
            "pageSize": page_size,
            "totalPages": total_pages,
        },
    }
    store_series_page_payload(cache_key, payload)
    return payload


def query_series_detail_data(title_name: str):
    """按标题名返回单个漫剧详情，包含完整剧集列表"""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute(
            """
            SELECT
              title.id,
              title.name,
              title.cover_url AS poster,
              title.first_ingested_at AS firstIngestedAt,
              title.last_new_episode_at AS lastNewEpisodeAt,
              title.updated_at AS updatedAt,
              title.total_episode_count AS totalEpisodeCount,
              title.current_max_episode_no AS currentMaxEpisodeNo,
              COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags,
              COALESCE(episode_summary.episodes, '[]'::json) AS episodes
            FROM title
            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  JSON_AGG(
                    JSON_BUILD_OBJECT(
                      'episode', episode.episode_no,
                      'firstIngestedAt', episode.first_ingested_at,
                      'updatedAt', episode.updated_at,
                      'videoUrl', episode.episode_url
                    )
                    ORDER BY episode.episode_no
                  ) FILTER (WHERE episode.id IS NOT NULL),
                  '[]'::json
                ) AS episodes
              FROM episode
              WHERE episode.title_id = title.id
            ) AS episode_summary ON TRUE
            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  ARRAY_AGG(tag.tag_name ORDER BY tag.sort_no, tag.tag_name),
                  ARRAY[]::text[]
                ) AS tags
              FROM title_tag
              JOIN tag ON tag.id = title_tag.tag_id
              WHERE title_tag.title_id = title.id
            ) AS tag_summary ON TRUE
            WHERE title.name = %s
            """,
            (title_name,),
        )
        row = db_cursor.fetchone()
    return serialize_series_detail_record(row) if row else None


@flask_app.route("/api/series", methods=["GET"])
def api_series():
    """根据前端传来的查询参数，返回"漫剧列表页"需要的数据，支持: 标签筛选、名称筛选、关键字搜索、排序、分页"""
    payload = query_series_page_data(
        tag=request.args.get("tag"),
        name=request.args.get("name"),
        search=request.args.get("search"),
        sort=request.args.get("sort"),
        page=normalize_positive_int(request.args.get("page"), 1),
        page_size=normalize_positive_int(request.args.get("pageSize"), 25, 100),
    )
    return build_json_response(200, **payload)


@flask_app.route("/api/series/<path:title_name>", methods=["GET"])
def api_series_detail(title_name):
    """按标题名返回单个漫剧详情"""
    payload = query_series_detail_data(unquote(title_name))
    if not payload:
        return build_json_response(404, message="漫剧不存在")
    return build_json_response(200, data=payload)


def is_non_empty_text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def serialize_episode_record(row):
    """把单条剧集记录转换成前端响应结构"""
    return {
        "episode": int(row["episode"]),
        "firstIngestedAt": convert_to_iso_datetime(row["firstIngestedAt"]),
        "updatedAt": convert_to_iso_datetime(row["updatedAt"]),
        "videoUrl": row["videoUrl"],
    }


def replace_title_tags(conn: psycopg.Connection, title_id: int, tags: list[str]):
    """用请求里的整组标签覆盖当前漫剧标签

    先清空旧关联再回填新关联
    这样可以保证数据库状态和本次请求完全一致
    """
    with conn.cursor() as cur:
        cur.execute("DELETE FROM title_tag WHERE title_id = %s", (title_id,))
        if not tags:
            return
        cur.execute(
            """
            INSERT INTO title_tag(title_id, tag_id)
            SELECT %s, tag.id
            FROM tag
            WHERE tag.tag_name = ANY (%s) ON CONFLICT DO NOTHING
            """,
            (title_id, tags),
        )


def parse_chinese_numeral(raw: str | None):
    """把中文数字或阿拉伯数字文本解析成正整数"""
    if raw is None:
        return None

    normalized_raw = str(raw).strip()
    if not normalized_raw:
        return None

    if normalized_raw.isdigit():
        value = int(normalized_raw)
        return value if value > 0 else None

    digit_map = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    unit_map = {
        "十": 10,
        "百": 100,
        "千": 1000,
    }

    total_value = 0
    current_digit = 0
    saw_chinese_numeral = False
    for char in normalized_raw:
        if char in digit_map:
            current_digit = digit_map[char]
            saw_chinese_numeral = True
            continue
        if char in unit_map:
            saw_chinese_numeral = True
            unit_value = unit_map[char]
            total_value += (current_digit or 1) * unit_value
            current_digit = 0
            continue
        return None

    if not saw_chinese_numeral:
        return None

    total_value += current_digit
    return total_value if total_value > 0 else None


def extract_episode_number_from_text(raw_text: str | None):
    """从文件名或路径片段里提取集号

    先按常见的 第1集 EP01 这类格式严格匹配
    都失败时再退回普通数字提取
    """
    text = str(raw_text or "")
    strict_patterns = [
        re.compile(r"第\s*([零〇一二两三四五六七八九十百千\d]+)\s*[集话話]", re.I),
        re.compile(r"(?:ep|episode|e)\s*[-_.]?[\s]*0*(\d{1,4})", re.I),
        re.compile(r"^(\d{1,4})(?:\D|$)", re.I),
    ]

    for pattern in strict_patterns:
        match = pattern.search(text)
        if not match:
            continue
        value = parse_chinese_numeral(match.group(1))
        if isinstance(value, int) and value > 0:
            return value

    fallback = re.search(r"(\d{1,4})", text)
    if not fallback:
        return None
    value = int(fallback.group(1))
    return value if value > 0 else None


# 判断字符串里是否包含常见视频扩展名，并且扩展名后面要么已经结束，要么后面接的是URL参数?或锚点#，同时忽略大小写
VIDEO_EXTENSION_RE = re.compile(
    r"\.(mp4|m3u8|mov|mkv|avi|flv|webm|ts|m4v|wmv|mpg|mpeg|3gp|rm|rmvb|vob|ogv|asf|f4v|mts|m2ts)(?:$|[?#])",
    re.I
)


def extract_episode_records_from_directory_html(html: str, directory_url: str):
    """从目录 HTML 中提取剧集记录

    结果会过滤非视频链接
    再按集号排序并去重
    """
    href_matches = re.findall(r'href\s*=\s*(["\'])(.*?)\1', str(html or ""), re.I | re.S)
    episode_records = []
    for _, raw_href in href_matches:
        raw_href = raw_href.strip()
        # 先过滤掉不会指向视频文件的锚点和脚本链接
        if not raw_href or raw_href.startswith("#") or raw_href.startswith("?"):
            continue
        if raw_href.lower().startswith(("mailto:", "javascript:")):
            continue

        absolute_video_url = urljoin(directory_url, raw_href)
        pathname = unquote(urlparse(absolute_video_url).path)
        if pathname.endswith("/"):
            continue
        if not VIDEO_EXTENSION_RE.search(pathname):
            continue

        filename = pathname.split("/")[-1] if pathname else ""
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        episode_records.append({"episodeNo": episode_no, "videoUrl": absolute_video_url, "filename": filename})

    episode_records.sort(key=lambda item: (item["episodeNo"], item["videoUrl"]))
    deduplicated_episode_records = {}
    # 排序后只保留同一集号最先出现的那条记录
    # 这样同一目录重复导入时结果顺序会更稳定
    for episode_record in episode_records:
        deduplicated_episode_records.setdefault(episode_record["episodeNo"], episode_record)
    return list(deduplicated_episode_records.values())


def extract_episode_records_from_url_list(video_urls: list[str]):
    """从一组视频 URL 中提取剧集记录并按集号去重"""
    episode_records = []
    for video_url in video_urls:
        pathname = unquote(urlparse(video_url).path)
        filename = pathname.split("/")[-1] if pathname else ""
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        episode_records.append({"episodeNo": episode_no, "videoUrl": video_url, "filename": filename})

    episode_records.sort(key=lambda item: (item["episodeNo"], item["videoUrl"]))
    deduplicated_episode_records = {}
    for episode_record in episode_records:
        deduplicated_episode_records.setdefault(episode_record["episodeNo"], episode_record)
    return list(deduplicated_episode_records.values())


@flask_app.route("/api/tags", methods=["GET"])
def api_tags_get():
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT tag_name FROM tag ORDER BY sort_no ASC, tag_name ASC")
        tag_rows = db_cursor.fetchall()
    return build_json_response(200, data=[tag_row["tag_name"] for tag_row in tag_rows])


@flask_app.route("/api/titles", methods=["GET"])
def api_titles_get():
    """返回管理面板和详情路由需要的轻量标题列表，不带剧集聚合结果"""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute(
            """
            SELECT
              title.name,
              title.cover_url AS poster,
              COALESCE(
                ARRAY_AGG(tag.tag_name ORDER BY tag.sort_no, tag.tag_name) FILTER (WHERE tag.tag_name IS NOT NULL),
                ARRAY[]::text[]
              ) AS tags
            FROM title
            LEFT JOIN title_tag ON title_tag.title_id = title.id
            LEFT JOIN tag ON tag.id = title_tag.tag_id
            GROUP BY title.id, title.name, title.cover_url
            ORDER BY title.name ASC
            """
        )
        title_rows = db_cursor.fetchall()
    return build_json_response(200, data=title_rows)


@flask_app.route("/api/tags", methods=["POST"])
def api_tags_post():
    """创建标签"""
    request_body = request.get_json(silent=True) or {}
    if not is_non_empty_text(request_body.get("tagName")):
        return build_json_response(400, message="tagName不能为空")
    created_tag_name = request_body["tagName"].strip()
    try:
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("INSERT INTO tag(tag_name) VALUES (%s)", (created_tag_name,))
    except UniqueViolation:
        return build_json_response(409, message=f"<{created_tag_name}>标签已存在")
    return build_json_response(201, message=f"<{created_tag_name}>标签已创建，请为剧集分配此标签", data=created_tag_name)


@flask_app.route("/api/tags/<path:tag_name>", methods=["PATCH"])
def api_tags_patch(tag_name):
    """重命名标签"""
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get("newTagName")):
        return build_json_response(400, message="newTagName 不能为空")
    new_tag_name = body["newTagName"].strip()
    try:
        with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
            cur.execute("UPDATE tag SET tag_name = %s WHERE tag_name = %s", (new_tag_name, tag_name))
            if cur.rowcount == 0:
                return build_json_response(404, message="标签不存在")
    except UniqueViolation:
        return build_json_response(409, message="标签已存在")
    return build_json_response(200, message="标签改名成功")


@flask_app.route("/api/tags/<path:tag_name>", methods=["DELETE"])
def api_tags_delete(tag_name):
    """删除标签"""
    with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM tag WHERE tag_name = %s", (tag_name,))
        if cur.rowcount == 0:
            return build_json_response(404, message="标签不存在")
    return build_json_response(200, message="标签已删除")


@flask_app.route("/api/titles", methods=["POST"])
def api_titles_post():
    """创建漫剧基础信息

    会同时写入名称 封面和标签关联
    """
    request_json = request.get_json(silent=True) or {}
    if not is_non_empty_text(request_json.get("name")):
        return build_json_response(400, message="name不能为空")
    if not is_non_empty_text(request_json.get("poster")):
        return build_json_response(400, message="poster不能为空")

    title_name = request_json["name"].strip()
    # 列表推导会先过滤空白标签
    # 再把保留下来的标签统一裁剪首尾空格
    selected_tags = [tag_name.strip() for tag_name in request_json.get("tags", []) if is_non_empty_text(tag_name)]

    try:
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id", (title_name, "__pending__"))
            created_title_id = db_cursor.fetchone()["id"]
            poster_url = resolve_resource_to_url(
                request_json["poster"],
                str(created_title_id),
                local_path_kind="file",
            )
            db_cursor.execute("UPDATE title SET cover_url = %s WHERE id = %s", (poster_url, created_title_id))
            replace_title_tags(db_connection, created_title_id, selected_tags)
    except ValueError as resolve_error:
        return build_json_response(400, message=str(resolve_error))
    except UniqueViolation:
        return build_json_response(409, message=f"<{title_name}>漫剧名称已存在")
    return build_json_response(201, message=f"<{title_name}>漫剧已创建")


@flask_app.route("/api/titles/<path:title_name>", methods=["PATCH"])
def api_titles_patch(title_name):
    """修改漫剧名称 封面和标签"""
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get("newName")) or not is_non_empty_text(body.get("poster")) or not isinstance(body.get("tags"), list):
        return build_json_response(400, message="newName、poster、tags 参数不完整")

    new_name = body["newName"].strip()
    tags = [tag.strip() for tag in body["tags"] if is_non_empty_text(tag)]
    if not tags:
        return build_json_response(400, message="tags 至少需要一个标签")

    try:
        with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM title WHERE name = %s", (title_name,))
            row = cur.fetchone()
            if not row:
                return build_json_response(404, message="漫剧不存在")
            title_id = row["id"]
            poster = resolve_resource_to_url(body["poster"], str(title_id), local_path_kind="file")
            cur.execute("UPDATE title SET name = %s, cover_url = %s WHERE id = %s", (new_name, poster, title_id))
            replace_title_tags(conn, title_id, tags)
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    except UniqueViolation:
        return build_json_response(409, message="目标名称已存在")
    return build_json_response(200, message="漫剧信息修改成功")


@flask_app.route("/api/titles/<path:title_name>", methods=["DELETE"])
def api_titles_delete(title_name):
    """删除漫剧"""
    with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM title WHERE name = %s", (title_name,))
        if cur.rowcount == 0:
            return build_json_response(404, message="漫剧不存在")
    return build_json_response(200, message="漫剧删除成功")


@flask_app.route("/api/episodes/batch-directory", methods=["POST"])
def api_episodes_batch_directory():
    """按目录批量导入剧集

    支持目录 URL
    也支持本地目录上传后再解析
    """
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    poster = str(body.get("poster") or "").strip()
    directory_url = str(body.get("directoryUrl") or "").strip()
    # 列表推导会先过滤空标签
    # 再把保留下来的标签名裁掉首尾空白
    tags = [tag.strip() for tag in body.get("tags", []) if is_non_empty_text(tag)]

    if not name or not poster or not directory_url:
        return build_json_response(400, message="name、poster、directoryUrl 不能为空")
    if not tags:
        return build_json_response(400, message="tags 至少需要一个标签")

    try:
        with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM title WHERE name = %s", (name,))
            existing_title_row = cur.fetchone()
            if existing_title_row:
                title_id = existing_title_row["id"]
            else:
                cur.execute("INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id", (name, "__pending__"))
                title_id = cur.fetchone()["id"]

            # 先把封面和目录输入都转换成可访问资源
            # 目录输入如果来自本地目录 这里会直接得到一组已上传的视频 URL
            title_storage_prefix = str(title_id)
            poster = resolve_resource_to_url(poster, title_storage_prefix, local_path_kind="file")
            resolved_directory_resource = resolve_resource_to_url(directory_url, title_storage_prefix, local_path_kind="dir")
            if isinstance(resolved_directory_resource, list):
                parsed_episode_records = extract_episode_records_from_url_list(resolved_directory_resource)
            else:
                parsed = urlparse(resolved_directory_resource)
                if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                    raise ValueError("directoryUrl 不是合法 URL")

                # 目录 URL 场景会先拉取 HTML
                # 再从页面里的链接中筛出可导入视频
                response = requests.get(resolved_directory_resource, timeout=20)
                if response.status_code >= 400:
                    raise ValueError(f"读取目录失败：HTTP {response.status_code}")
                content_type = response.headers.get("content-type", "")
                if not re.search(r"text/html|application/xhtml\+xml", content_type, re.I):
                    raise ValueError("目录地址返回的不是 HTML 页面，无法解析视频列表")

                parsed_episode_records = extract_episode_records_from_directory_html(response.text, resolved_directory_resource)
            if not parsed_episode_records:
                raise ValueError("目录中未识别到可导入的视频文件。请确认链接可直接访问且文件名包含集号（如第1集/第一集/EP01）。")

            cur.execute("UPDATE title SET cover_url = %s WHERE id = %s", (poster, title_id))

            cur.execute("SELECT id, tag_name FROM tag WHERE tag_name = ANY(%s)", (tags,))
            tag_rows = cur.fetchall()
            if not tag_rows:
                raise ValueError("所选标签不存在，请先创建标签")

            replace_title_tags(conn, title_id, tags)

            # 两个列表推导会把解析结果拆成并行数组
            # 后面的 UNNEST 会把它们重新展开成 SQL 临时输入表
            episode_numbers = [item["episodeNo"] for item in parsed_episode_records]
            episode_urls = [item["videoUrl"] for item in parsed_episode_records]
            cur.execute(
                """
                WITH input AS (SELECT *
                               FROM UNNEST(%s::int[], %s::text[]) AS u(episode_no, episode_url)),
                     inserted AS (
                INSERT
                INTO episode(title_id, episode_no, episode_url)
                SELECT %s, i.episode_no, i.episode_url
                FROM input i ON CONFLICT (title_id, episode_no) DO NOTHING
                  RETURNING episode_no
                ),
                updated AS (
                UPDATE episode e
                SET episode_url = i.episode_url
                FROM input i
                WHERE e.title_id = %s
                  AND e.episode_no = i.episode_no
                  AND NOT EXISTS (SELECT 1 FROM inserted ins WHERE ins.episode_no = i.episode_no)
                    RETURNING e.episode_no
                    )
                SELECT (SELECT COUNT(*) ::int FROM inserted) AS inserted,
                       (SELECT COUNT(*) ::int FROM updated)  AS updated
                """,
                (episode_numbers, episode_urls, title_id, title_id),
            )
            upsert_stats = cur.fetchone()
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    except UniqueViolation:
        return build_json_response(409, message="漫剧名称冲突，请更换名称")

    return build_json_response(
        201,
        message=f"批量导入完成，共识别 {len(parsed_episode_records)} 集",
        data={
            "total": len(parsed_episode_records),
            "inserted": upsert_stats["inserted"] if upsert_stats else 0,
            "updated": upsert_stats["updated"] if upsert_stats else 0,
            "episodes": [{"episodeNo": item["episodeNo"], "videoUrl": item["videoUrl"]} for item in parsed_episode_records],
        },
    )


@flask_app.route("/api/episodes", methods=["POST"])
def api_episodes_post():
    """新增单集内容"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get("titleName") or "").strip()
    try:
        episode_no = int(body.get("episodeNo"))
    except (TypeError, ValueError):
        episode_no = None
    raw_video_url = str(body.get("videoUrl") or "").strip()

    if not title_name or episode_no is None or not raw_video_url:
        return build_json_response(400, message="参数不完整")

    if episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")

    with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM title WHERE name = %s", (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return build_json_response(404, message="漫剧不存在")
        try:
            video_url = resolve_resource_to_url(
                raw_video_url,
                str(title_row["id"]),
                local_path_kind="file",
            )
        except ValueError as exc:
            return build_json_response(400, message=str(exc))
        if isinstance(video_url, list):
            return build_json_response(400, message="videoUrl 必须是单个视频资源地址，不能是目录")
        try:
            cur.execute("INSERT INTO episode(title_id, episode_no, episode_url) VALUES (%s, %s, %s)", (title_row["id"], episode_no, video_url))
        except UniqueViolation:
            return build_json_response(409, message="目标集号已存在")
    return build_json_response(201, message="剧集新增成功")


@flask_app.route("/api/episodes", methods=["PATCH"])
def api_episodes_patch():
    """修改单集集号与视频地址"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get("titleName") or "").strip()
    raw_video_url = str(body.get("videoUrl") or "").strip()
    try:
        current_episode_no = int(body.get("episodeNo"))
        new_episode_no = int(body.get("newEpisodeNo"))
    except (TypeError, ValueError):
        current_episode_no = None
        new_episode_no = None

    if not title_name or current_episode_no is None or new_episode_no is None or not raw_video_url:
        return build_json_response(400, message="参数不完整")
    if current_episode_no <= 0 or new_episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")

    with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM title WHERE name = %s", (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return build_json_response(404, message="漫剧不存在")
        try:
            video_url = resolve_resource_to_url(
                raw_video_url,
                str(title_row["id"]),
                local_path_kind="file",
            )
        except ValueError as exc:
            return build_json_response(400, message=str(exc))
        # 单集接口只接受单个视频资源
        # 如果这里拿到列表 说明用户传入的是目录而不是文件
        if isinstance(video_url, list):
            return build_json_response(400, message="videoUrl 必须是单个视频资源地址，不能是目录")
        try:
            cur.execute(
                """
                UPDATE episode e
                SET episode_no  = %s,
                    episode_url = %s FROM title t
                WHERE e.title_id = t.id
                  AND t.name = %s
                  AND e.episode_no = %s
                """,
                (new_episode_no, video_url, title_name, current_episode_no),
            )
        except UniqueViolation:
            return build_json_response(409, message="目标集号已存在")
        if cur.rowcount == 0:
            return build_json_response(404, message="剧集不存在")
    return build_json_response(200, message="剧集信息修改成功")


@flask_app.route("/api/episodes", methods=["DELETE"])
def api_episodes_delete():
    """删除单集内容"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get("titleName") or "").strip()
    try:
        episode_no = int(body.get("episodeNo"))
    except (TypeError, ValueError):
        episode_no = None

    if not title_name or episode_no is None:
        return build_json_response(400, message="参数不完整")
    if episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")

    with open_db_connection_in_transaction() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE
            FROM episode e USING title t
            WHERE e.title_id = t.id
              AND t.name = %s
              AND e.episode_no = %s
            """,
            (title_name, episode_no),
        )
        if cur.rowcount == 0:
            return build_json_response(404, message="剧集不存在")
    return build_json_response(200, message="剧集删除成功")


@flask_app.route("/", defaults={"path": ""})
@flask_app.route("/<path:path>")
def spa(path: str):
    """SPA 兜底路由

    非 API 请求统一交给前端入口页面
    """
    if path.startswith("api/"):
        return build_json_response(404, message="API endpoint not found.")
    return render_template("index.html")


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "4173"))
    flask_app.run(host=host, port=port, debug=False)
