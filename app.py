"""视频预览站点后端入口。

该模块负责：
1. 初始化 Flask 应用与数据库连接。
2. 处理标签、漫剧、剧集相关 REST API。
3. 解析目录链接/文件名中的集号并执行批量导入。
4. 统一返回 JSON 响应，便于前端稳定消费。
"""

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

# 项目根目录（用于定位 .env 及模板/静态资源）。
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')

flask_app = Flask(__name__, template_folder='templates', static_folder='static')
flask_app.config['JSON_AS_ASCII'] = False

# 可识别的视频文件扩展名（用于目录批量导入时过滤候选链接）。
VIDEO_EXTENSION_RE = re.compile(r"\.(mp4|m3u8|mov|mkv|avi|flv|webm|ts|m4v)(?:$|[?#])", re.I)
# 中文数字映射表（用于“第一集/第十集”等文本解析）。
CHINESE_DIGIT_MAP = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}


def read_optional_env_var(name: str):
    """读取环境变量并做 strip；空字符串按 None 处理。"""
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def build_database_dsn() -> str:
    """构建 PostgreSQL DSN，优先使用 DATABASE_URL。"""
    database_url = read_optional_env_var('DATABASE_URL')
    if database_url:
        return database_url

    host = read_optional_env_var('PGHOST') or '127.0.0.1'
    port = read_optional_env_var('PGPORT') or '5432'
    user = read_optional_env_var('PGUSER') or 'postgres'
    password = read_optional_env_var('PGPASSWORD') or read_optional_env_var('POSTGRES_PASSWORD') or ''
    database = read_optional_env_var('PGDATABASE') or 'video_preview'

    if password:
        return f"postgresql://{user}:{password}@{host}:{port}/{database}"
    return f"postgresql://{user}@{host}:{port}/{database}"


DATABASE_DSN = build_database_dsn()


@contextmanager
def open_db_connection():
    """获取数据库连接并在退出时自动关闭。"""
    conn = psycopg.connect(DATABASE_DSN, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def open_db_transaction():
    """打开事务上下文，异常时自动回滚。"""
    with open_db_connection() as conn:
        with conn.transaction():
            yield conn


def build_json_response(status: int, **payload):
    """统一构造JSON响应对象并设置HTTP状态码"""
    response = jsonify(payload)
    response.status_code = status
    return response


@flask_app.errorhandler(Exception)
def handle_unexpected_error(error):
    """兜底异常处理器：将异常规范化为可读错误消息。"""
    message = str(error) or 'Internal server error'
    if 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string' in message:
        return build_json_response(
            500,
            message='数据库认证失败：当前 PostgreSQL 使用 SCRAM 且未提供有效密码。请设置 PGPASSWORD（或 POSTGRES_PASSWORD / DATABASE_URL）后重启服务。',
        )
    return build_json_response(500, message=message)


def is_non_empty_text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_http_or_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)


def load_oss_credentials():
    access_key = read_optional_env_var('OSS_ACCESS_KEY')
    secret_key = read_optional_env_var('OSS_SECRET_KEY')
    endpoint = read_optional_env_var('OSS_ENDPOINT')
    region = read_optional_env_var('OSS_REGION')
    bucket_name = read_optional_env_var('OSS_BUCKET_NAME')

    missing = [
        name
        for name, current in (
            ('OSS_ACCESS_KEY', access_key),
            ('OSS_SECRET_KEY', secret_key),
            ('OSS_ENDPOINT', endpoint),
            ('OSS_REGION', region),
            ('OSS_BUCKET_NAME', bucket_name),
        )
        if not current
    ]
    if missing:
        raise ValueError(f'缺少OSS配置: {", ".join(missing)}')

    return access_key, secret_key, endpoint, region, bucket_name


def append_millisecond_timestamp_to_filename(path_obj: Path) -> str:
    suffixes = ''.join(path_obj.suffixes)
    timestamp = int(time.time() * 1000)

    if suffixes:
        base_name = path_obj.name[:-len(suffixes)]
        return f'{base_name}_{timestamp}{suffixes}'

    return f'{path_obj.name}_{timestamp}'


def resolve_resource_to_url(value: str, name: str, local_path_kind: str = 'any'):
    """将资源输入规范化为可访问 URL。

    支持两类输入：
    - 远程 URL：直接返回。
    - 本地文件/目录：上传到对象存储后返回 URL（目录会返回 URL 列表）。
    """
    normalized = value.strip()
    if is_http_or_https_url(normalized):
        return normalized

    access_key, secret_key, endpoint, region, bucket_name = load_oss_credentials()
    access_key = (access_key or "").strip()
    secret_key = (secret_key or "").strip()
    endpoint = (endpoint or "").strip()
    region = (region or "").strip()
    bucket_name = (bucket_name or "").strip()

    if not access_key:
        raise ValueError("access_key 不能为空")
    if not secret_key:
        raise ValueError("secret_key 不能为空")
    if not endpoint:
        raise ValueError("endpoint 不能为空")
    if not region:
        raise ValueError("region 不能为空")
    if not bucket_name:
        raise ValueError("bucket_name 不能为空")

    try:
        path_obj = Path(normalized).expanduser().resolve(strict=True)
    except FileNotFoundError:
        raise ValueError('本地路径不存在')
    except Exception as e:
        raise ValueError(f'路径解析失败: {e}')

    client = tos.TosClientV2(access_key, secret_key, endpoint, region)

    if local_path_kind not in {'any', 'file', 'dir'}:
        raise ValueError('local_path_kind 参数非法')

    if path_obj.is_file():
        if local_path_kind == 'dir':
            raise ValueError('本地路径必须是目录，不能是文件')
        filename_with_ts = append_millisecond_timestamp_to_filename(path_obj)
        key = f'{name}/{filename_with_ts}'
        resp = client.put_object_from_file(bucket_name, key, str(path_obj))
        if getattr(resp, 'status_code', None) != 200:
            raise ValueError(f'上传失败, status_code={getattr(resp, "status_code", "unknown")}')
        return f'https://{bucket_name}.{endpoint}/{key}'

    if path_obj.is_dir():
        if local_path_kind == 'file':
            raise ValueError('本地路径必须是文件，不能是目录')
        url_list = []
        for file_path in sorted(path_obj.rglob('*')):
            if not file_path.is_file():
                continue

            relative_path = file_path.relative_to(path_obj)
            parent_dir = relative_path.parent.as_posix()
            filename_with_ts = append_millisecond_timestamp_to_filename(file_path)

            if parent_dir and parent_dir != '.':
                key = f'{name}/{parent_dir}/{filename_with_ts}'
            else:
                key = f'{name}/{filename_with_ts}'

            resp = client.put_object_from_file(bucket_name, key, str(file_path))
            if getattr(resp, 'status_code', None) != 200:
                raise ValueError(f'上传失败: {file_path}, status_code={getattr(resp, "status_code", "unknown")}')

            url_list.append(f'https://{bucket_name}.{endpoint}/{key}')

        if not url_list:
            raise ValueError('目录为空，或目录下没有可上传文件')

        return url_list

    raise ValueError('输入路径既不是文件也不是目录')


def parse_positive_integer_or_default(value, default: int, max_value: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed <= 0:
        return default
    if max_value is not None:
        return min(parsed, max_value)
    return parsed


def convert_to_iso_datetime(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def serialize_episode_record(row):
    return {
        'episode': int(row['episode']),
        'firstIngestedAt': convert_to_iso_datetime(row['firstIngestedAt']),
        'updatedAt': convert_to_iso_datetime(row['updatedAt']),
        'videoUrl': row['videoUrl'],
    }


def serialize_series_record(row):
    episodes = row.get('episodes') or []
    return {
        'id': row['id'],
        'name': row['name'],
        'poster': row['poster'],
        'firstIngestedAt': convert_to_iso_datetime(row['firstIngestedAt']),
        'updatedAt': convert_to_iso_datetime(row['updatedAt']),
        'lastNewEpisodeAt': convert_to_iso_datetime(row['lastNewEpisodeAt']),
        'tags': row.get('tags') or [],
        'episodes': [
            {
                'episode': int(ep['episode']),
                'firstIngestedAt': convert_to_iso_datetime(ep['firstIngestedAt']),
                'updatedAt': convert_to_iso_datetime(ep['updatedAt']),
                'videoUrl': ep['videoUrl'],
            }
            for ep in episodes
        ],
    }


def bind_tags_to_title(conn: psycopg.Connection, title_id: int, tags: list[str]):
    with conn.cursor() as cur:
        cur.execute('DELETE FROM title_tag WHERE title_id = %s', (title_id,))
        if not tags:
            return
        cur.execute(
            '''
            INSERT INTO title_tag(title_id, tag_id)
            SELECT %s, tag.id
            FROM tag
            WHERE tag.tag_name = ANY (%s) ON CONFLICT DO NOTHING
            ''',
            (title_id, tags),
        )


def resolve_series_sort_sql(sort: str | None) -> str:
    sort_map = {
        'updated_desc': 't.updated_at DESC, t.name ASC',
        'updated_asc': 't.updated_at ASC, t.name ASC',
        'ingested_asc': 't.first_ingested_at ASC, t.name ASC',
        'ingested_desc': 't.first_ingested_at DESC, t.name ASC',
        'name_asc': 't.name ASC',
        'name_desc': 't.name DESC',
    }
    return sort_map.get(sort or '', sort_map['updated_desc'])


def parse_chinese_numeral(raw: str | None):
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    total = 0
    current = 0
    for ch in raw:
        if ch in CHINESE_DIGIT_MAP:
            current = CHINESE_DIGIT_MAP[ch]
            continue
        if ch == '十':
            total += (current or 1) * 10
            current = 0
            continue
        if ch == '百':
            total += (current or 1) * 100
            current = 0
            continue
        if ch == '千':
            total += (current or 1) * 1000
            current = 0
            continue
        return None
    return total + current


def extract_episode_number_from_text(raw_text: str | None):
    text = str(raw_text or '')
    strict_patterns = [
        re.compile(r'第\s*([零〇一二两三四五六七八九十百千\d]+)\s*[集话話]', re.I),
        re.compile(r'(?:ep|episode|e)\s*[-_.]?[\s]*0*(\d{1,4})', re.I),
        re.compile(r'^(\d{1,4})(?:\D|$)', re.I),
    ]

    for pattern in strict_patterns:
        match = pattern.search(text)
        if not match:
            continue
        value = parse_chinese_numeral(match.group(1))
        if isinstance(value, int) and value > 0:
            return value

    fallback = re.search(r'(\d{1,4})', text)
    if not fallback:
        return None
    value = int(fallback.group(1))
    return value if value > 0 else None


def extract_episode_links_from_directory_html(html: str, directory_url: str):
    href_matches = re.findall(r'href\s*=\s*(["\'])(.*?)\1', str(html or ''), re.I | re.S)
    files = []
    for _, raw_href in href_matches:
        raw_href = raw_href.strip()
        if not raw_href or raw_href.startswith('#') or raw_href.startswith('?'):
            continue
        if raw_href.lower().startswith(('mailto:', 'javascript:')):
            continue

        absolute = urljoin(directory_url, raw_href)
        pathname = unquote(urlparse(absolute).path)
        if pathname.endswith('/'):
            continue
        if not VIDEO_EXTENSION_RE.search(pathname):
            continue

        filename = pathname.split('/')[-1] if pathname else ''
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        files.append({'episodeNo': episode_no, 'videoUrl': absolute, 'filename': filename})

    files.sort(key=lambda item: (item['episodeNo'], item['videoUrl']))
    unique = {}
    for item in files:
        unique.setdefault(item['episodeNo'], item)
    return list(unique.values())


def extract_episode_links_from_url_list(video_urls: list[str]):
    files = []
    for video_url in video_urls:
        pathname = unquote(urlparse(video_url).path)
        filename = pathname.split('/')[-1] if pathname else ''
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        files.append({'episodeNo': episode_no, 'videoUrl': video_url, 'filename': filename})

    files.sort(key=lambda item: (item['episodeNo'], item['videoUrl']))
    unique = {}
    for item in files:
        unique.setdefault(item['episodeNo'], item)
    return list(unique.values())


def query_series_page(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
    """按筛选条件查询漫剧分页数据，并聚合标签与剧集信息。"""
    filters = []
    values = []

    if tag:
        values.append(tag)
        filters.append(
            f'''EXISTS (
                SELECT 1 FROM title_tag tt
                JOIN tag g ON g.id = tt.tag_id
                WHERE tt.title_id = t.id AND g.tag_name = %s
            )'''
        )
    if name:
        values.append(name)
        filters.append('t.name = %s')
    if search:
        values.append(f"%{search.strip().lower()}%")
        filters.append('LOWER(t.name) LIKE %s')

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ''
    order_by_clause = resolve_series_sort_sql(sort)
    order_by_selected_titles = order_by_clause.replace('t.', 'st.')

    with open_db_connection() as conn, conn.cursor() as cur:
        cur.execute(
            f'''
            SELECT COUNT(*)::int AS total
            FROM title t
            {where_clause}
            ''',
            values,
        )
        total = cur.fetchone()['total'] or 0
        total_pages = max(1, (total + page_size - 1) // page_size)
        safe_page = min(page, total_pages)
        offset = (safe_page - 1) * page_size

        cur.execute(
            f'''
            WITH selected_titles AS (
              SELECT t.id, t.name, t.cover_url, t.first_ingested_at, t.updated_at
              FROM title t
              {where_clause}
              ORDER BY {order_by_clause}
              LIMIT %s OFFSET %s
            )
            SELECT
              st.id,
              st.name,
              st.cover_url AS poster,
              st.first_ingested_at AS "firstIngestedAt",
              st.updated_at AS "updatedAt",
              COALESCE(MAX(e.first_ingested_at), st.first_ingested_at) AS "lastNewEpisodeAt",
              COALESCE(ARRAY_AGG(DISTINCT g.tag_name) FILTER (WHERE g.tag_name IS NOT NULL), ARRAY[]::text[]) AS tags,
              COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'episode', e.episode_no,
                    'firstIngestedAt', e.first_ingested_at,
                    'updatedAt', e.updated_at,
                    'videoUrl', e.episode_url
                  ) ORDER BY e.episode_no
                ) FILTER (WHERE e.id IS NOT NULL),
                '[]'::json
              ) AS episodes
            FROM selected_titles st
            LEFT JOIN episode e ON e.title_id = st.id
            LEFT JOIN title_tag tt ON tt.title_id = st.id
            LEFT JOIN tag g ON g.id = tt.tag_id
            GROUP BY st.id, st.name, st.cover_url, st.first_ingested_at, st.updated_at
            ORDER BY {order_by_selected_titles}
            ''',
            [*values, page_size, offset],
        )
        rows = cur.fetchall()

    data = [serialize_series_record(row) for row in rows]
    return {
        'data': data,
        'pagination': {
            'total': total,
            'page': safe_page,
            'pageSize': page_size,
            'totalPages': total_pages,
        },
    }


def query_flat_ingest_records():
    with open_db_connection() as conn, conn.cursor() as cur:
        cur.execute(
            '''
            SELECT t.name,
                   e.episode_no        AS episode,
                   t.cover_url         AS poster,
                   e.episode_url       AS "videoUrl",
                   e.first_ingested_at AS "firstIngestedAt",
                   e.updated_at        AS "updatedAt",
                   COALESCE(
                           ARRAY_AGG(g.tag_name ORDER BY g.sort_no, g.tag_name) FILTER(WHERE g.tag_name IS NOT NULL),
                           ARRAY[] ::text[]
                   )                   AS tags
            FROM title t
                     JOIN episode e ON e.title_id = t.id
                     LEFT JOIN title_tag tt ON tt.title_id = t.id
                     LEFT JOIN tag g ON g.id = tt.tag_id
            GROUP BY t.id, e.id
            ORDER BY t.name, e.episode_no
            '''
        )
        rows = cur.fetchall()
    out = []
    for row in rows:
        out.append(
            {
                'name': row['name'],
                'episode': int(row['episode']),
                'poster': row['poster'],
                'videoUrl': row['videoUrl'],
                'firstIngestedAt': convert_to_iso_datetime(row['firstIngestedAt']),
                'updatedAt': convert_to_iso_datetime(row['updatedAt']),
                'tags': row.get('tags') or [],
            }
        )
    return out


@flask_app.route('/api/health', methods=['GET'])
def api_health():
    """健康检查接口：用于探测服务与数据库连通性。"""
    with open_db_connection() as conn, conn.cursor() as cur:
        cur.execute('SELECT 1')
        cur.fetchone()
    return build_json_response(200, status='ok')


@flask_app.route('/api/ingest-records', methods=['GET'])
def api_ingest_records():
    return build_json_response(200, data=query_flat_ingest_records())


@flask_app.route('/api/series', methods=['GET'])
def api_series():
    """漫剧列表接口：支持标签/关键字/排序/分页查询。"""
    payload = query_series_page(
        tag=request.args.get('tag'),
        name=request.args.get('name'),
        search=request.args.get('search'),
        sort=request.args.get('sort'),
        page=parse_positive_integer_or_default(request.args.get('page'), 1),
        page_size=parse_positive_integer_or_default(request.args.get('pageSize'), 25, 100),
    )
    return build_json_response(200, **payload)


@flask_app.route('/api/tags', methods=['GET'])
def api_tags_get():
    with open_db_connection() as conn, conn.cursor() as cur:
        cur.execute('SELECT tag_name FROM tag ORDER BY sort_no ASC, tag_name ASC')
        rows = cur.fetchall()
    return build_json_response(200, data=[row['tag_name'] for row in rows])


@flask_app.route('/api/tags', methods=['POST'])
def api_tags_post():
    """创建标签"""
    request_body = request.get_json(silent=True) or {}
    if not is_non_empty_text(request_body.get('tagName')):
        return build_json_response(400, message='tagName不能为空')
    created_tag_name = request_body['tagName'].strip()
    try:
        with open_db_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute('INSERT INTO tag(tag_name) VALUES (%s)', (created_tag_name,))
    except UniqueViolation:
        return build_json_response(409, message=f'<{created_tag_name}>标签已存在')
    return build_json_response(201, message=f'<{created_tag_name}>标签已创建，请为剧集分配此标签', data=created_tag_name)


@flask_app.route('/api/tags/<path:tag_name>', methods=['PATCH'])
def api_tags_patch(tag_name):
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get('newTagName')):
        return build_json_response(400, message='newTagName 不能为空')
    new_tag_name = body['newTagName'].strip()
    try:
        with open_db_transaction() as conn, conn.cursor() as cur:
            cur.execute('UPDATE tag SET tag_name = %s WHERE tag_name = %s', (new_tag_name, tag_name))
            if cur.rowcount == 0:
                return build_json_response(404, message='标签不存在')
    except UniqueViolation:
        return build_json_response(409, message='标签已存在')
    return build_json_response(200, message='标签改名成功')


@flask_app.route('/api/tags/<path:tag_name>', methods=['DELETE'])
def api_tags_delete(tag_name):
    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute('DELETE FROM tag WHERE tag_name = %s', (tag_name,))
        if cur.rowcount == 0:
            return build_json_response(404, message='标签不存在')
    return build_json_response(200, message='标签已删除')


@flask_app.route('/api/titles', methods=['POST'])
def api_titles_post():
    """创建漫剧基础信息（名称、封面、标签）。"""
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get('name')) or not is_non_empty_text(body.get('poster')):
        return build_json_response(400, message='name 和 poster 不能为空')

    name = body['name'].strip()
    try:
        poster = resolve_resource_to_url(body['poster'], 'posters', local_path_kind='file')
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    tags = [tag.strip() for tag in body.get('tags', []) if is_non_empty_text(tag)]

    try:
        with open_db_transaction() as conn, conn.cursor() as cur:
            cur.execute('INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id', (name, poster))
            title_id = cur.fetchone()['id']
            bind_tags_to_title(conn, title_id, tags)
    except UniqueViolation:
        return build_json_response(409, message='漫剧名称已存在')
    return build_json_response(201, message='漫剧已创建')


@flask_app.route('/api/titles/<path:title_name>', methods=['PATCH'])
def api_titles_patch(title_name):
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get('newName')) or not is_non_empty_text(body.get('poster')) or not isinstance(body.get('tags'), list):
        return build_json_response(400, message='newName、poster、tags 参数不完整')

    new_name = body['newName'].strip()
    try:
        poster = resolve_resource_to_url(body['poster'], 'posters', local_path_kind='file')
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    tags = [tag.strip() for tag in body['tags'] if is_non_empty_text(tag)]
    if not tags:
        return build_json_response(400, message='tags 至少需要一个标签')

    try:
        with open_db_transaction() as conn, conn.cursor() as cur:
            cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
            row = cur.fetchone()
            if not row:
                return build_json_response(404, message='漫剧不存在')
            title_id = row['id']
            cur.execute('UPDATE title SET name = %s, cover_url = %s WHERE id = %s', (new_name, poster, title_id))
            bind_tags_to_title(conn, title_id, tags)
    except UniqueViolation:
        return build_json_response(409, message='目标名称已存在')
    return build_json_response(200, message='漫剧信息修改成功')


@flask_app.route('/api/titles/<path:title_name>', methods=['DELETE'])
def api_titles_delete(title_name):
    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute('DELETE FROM title WHERE name = %s', (title_name,))
        if cur.rowcount == 0:
            return build_json_response(404, message='漫剧不存在')
    return build_json_response(200, message='漫剧删除成功')


@flask_app.route('/api/episodes/batch-directory', methods=['POST'])
def api_episodes_batch_directory():
    """批量导入：支持目录 URL 或本地目录（自动上传后解析）。"""
    body = request.get_json(silent=True) or {}
    name = str(body.get('name') or '').strip()
    poster = str(body.get('poster') or '').strip()
    directory_url = str(body.get('directoryUrl') or '').strip()
    tags = [tag.strip() for tag in body.get('tags', []) if is_non_empty_text(tag)]

    if not name or not poster or not directory_url:
        return build_json_response(400, message='name、poster、directoryUrl 不能为空')
    if not tags:
        return build_json_response(400, message='tags 至少需要一个标签')

    try:
        poster = resolve_resource_to_url(poster, f'episodes/{name}/poster', local_path_kind='file')
        normalized_directory = resolve_resource_to_url(directory_url, f'episodes/{name}/directory', local_path_kind='dir')
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    if isinstance(normalized_directory, list):
        parsed_episodes = extract_episode_links_from_url_list(normalized_directory)
    else:
        parsed = urlparse(normalized_directory)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
            return build_json_response(400, message='directoryUrl 不是合法 URL')

        response = requests.get(normalized_directory, timeout=20)
        if response.status_code >= 400:
            return build_json_response(400, message=f'读取目录失败：HTTP {response.status_code}')
        content_type = response.headers.get('content-type', '')
        if not re.search(r'text/html|application/xhtml\+xml', content_type, re.I):
            return build_json_response(400, message='目录地址返回的不是 HTML 页面，无法解析视频列表')

        parsed_episodes = extract_episode_links_from_directory_html(response.text, normalized_directory)
    if not parsed_episodes:
        return build_json_response(400, message='目录中未识别到可导入的视频文件。请确认链接可直接访问且文件名包含集号（如第1集/第一集/EP01）。')

    try:
        with open_db_transaction() as conn, conn.cursor() as cur:
            cur.execute('SELECT id FROM title WHERE name = %s', (name,))
            existing = cur.fetchone()
            if existing:
                title_id = existing['id']
                cur.execute('UPDATE title SET cover_url = %s WHERE id = %s', (poster, title_id))
            else:
                cur.execute('INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id', (name, poster))
                title_id = cur.fetchone()['id']

            cur.execute('SELECT id, tag_name FROM tag WHERE tag_name = ANY(%s)', (tags,))
            tag_rows = cur.fetchall()
            if not tag_rows:
                return build_json_response(400, message='所选标签不存在，请先创建标签')

            bind_tags_to_title(conn, title_id, tags)

            episode_nos = [item['episodeNo'] for item in parsed_episodes]
            episode_urls = [item['videoUrl'] for item in parsed_episodes]
            cur.execute(
                '''
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
                ''',
                (episode_nos, episode_urls, title_id, title_id),
            )
            stats = cur.fetchone()
    except UniqueViolation:
        return build_json_response(409, message='漫剧名称冲突，请更换名称')

    return build_json_response(
        201,
        message=f'批量导入完成，共识别 {len(parsed_episodes)} 集',
        data={
            'total': len(parsed_episodes),
            'inserted': stats['inserted'] if stats else 0,
            'updated': stats['updated'] if stats else 0,
            'episodes': [{'episodeNo': item['episodeNo'], 'videoUrl': item['videoUrl']} for item in parsed_episodes],
        },
    )


@flask_app.route('/api/episodes', methods=['POST'])
def api_episodes_post():
    """新增单集内容。"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    try:
        episode_no = int(body.get('episodeNo'))
    except (TypeError, ValueError):
        episode_no = None
    raw_video_url = str(body.get('videoUrl') or '').strip()

    if not title_name or episode_no is None or not raw_video_url:
        return build_json_response(400, message='参数不完整')
    try:
        video_url = resolve_resource_to_url(raw_video_url, f'episodes/{title_name}', local_path_kind='file')
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    if isinstance(video_url, list):
        return build_json_response(400, message='videoUrl 必须是单个视频资源地址，不能是目录')

    if episode_no <= 0:
        return build_json_response(400, message='集号必须大于0')

    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return build_json_response(404, message='漫剧不存在')
        try:
            cur.execute('INSERT INTO episode(title_id, episode_no, episode_url) VALUES (%s, %s, %s)', (title_row['id'], episode_no, video_url))
        except UniqueViolation:
            return build_json_response(409, message='目标集号已存在')
    return build_json_response(201, message='剧集新增成功')


@flask_app.route('/api/episodes', methods=['PATCH'])
def api_episodes_patch():
    """修改单集集号与视频地址。"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    raw_video_url = str(body.get('videoUrl') or '').strip()
    try:
        source_no = int(body.get('episodeNo'))
        target_no = int(body.get('newEpisodeNo'))
    except (TypeError, ValueError):
        source_no = None
        target_no = None

    if not title_name or source_no is None or target_no is None or not raw_video_url:
        return build_json_response(400, message='参数不完整')
    try:
        video_url = resolve_resource_to_url(raw_video_url, f'episodes/{title_name}', local_path_kind='file')
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    if isinstance(video_url, list):
        return build_json_response(400, message='videoUrl 必须是单个视频资源地址，不能是目录')
    if source_no <= 0 or target_no <= 0:
        return build_json_response(400, message='集号必须大于0')

    with open_db_transaction() as conn, conn.cursor() as cur:
        try:
            cur.execute(
                '''
                UPDATE episode e
                SET episode_no  = %s,
                    episode_url = %s FROM title t
                WHERE e.title_id = t.id
                  AND t.name = %s
                  AND e.episode_no = %s
                ''',
                (target_no, video_url, title_name, source_no),
            )
        except UniqueViolation:
            return build_json_response(409, message='目标集号已存在')
        if cur.rowcount == 0:
            return build_json_response(404, message='剧集不存在')
    return build_json_response(200, message='剧集信息修改成功')


@flask_app.route('/api/episodes', methods=['DELETE'])
def api_episodes_delete():
    """删除单集内容。"""
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    try:
        episode_no = int(body.get('episodeNo'))
    except (TypeError, ValueError):
        episode_no = None

    if not title_name or episode_no is None:
        return build_json_response(400, message='参数不完整')
    if episode_no <= 0:
        return build_json_response(400, message='集号必须大于0')

    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute(
            '''
            DELETE
            FROM episode e USING title t
            WHERE e.title_id = t.id
              AND t.name = %s
              AND e.episode_no = %s
            ''',
            (title_name, episode_no),
        )
        if cur.rowcount == 0:
            return build_json_response(404, message='剧集不存在')
    return build_json_response(200, message='剧集删除成功')


@flask_app.route('/', defaults={'path': ''})
@flask_app.route('/<path:path>')
def spa(path: str):
    """SPA 兜底路由：非 API 请求统一交给前端入口页面。"""
    if path.startswith('api/'):
        return build_json_response(404, message='API endpoint not found.')
    return render_template('index.html')


if __name__ == '__main__':
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', '4173'))
    flask_app.run(host=host, port=port, debug=False)
