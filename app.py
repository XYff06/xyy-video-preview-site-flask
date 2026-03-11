import os
import re
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urljoin, urlparse

import psycopg
import requests
import tos
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['JSON_AS_ASCII'] = False

VIDEO_EXTENSION_RE = re.compile(r"\.(mp4|m3u8|mov|mkv|avi|flv|webm|ts|m4v)(?:$|[?#])", re.I)
CHINESE_DIGIT_MAP = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}


def optional_env(name: str):
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def build_dsn() -> str:
    database_url = optional_env('DATABASE_URL')
    if database_url:
        return database_url

    host = optional_env('PGHOST') or '127.0.0.1'
    port = optional_env('PGPORT') or '5432'
    user = optional_env('PGUSER') or 'postgres'
    password = optional_env('PGPASSWORD') or optional_env('POSTGRES_PASSWORD') or ''
    database = optional_env('PGDATABASE') or 'video_preview'

    if password:
        return f"postgresql://{user}:{password}@{host}:{port}/{database}"
    return f"postgresql://{user}@{host}:{port}/{database}"


DB_DSN = build_dsn()


@contextmanager
def get_conn():
    conn = psycopg.connect(DB_DSN, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def get_tx():
    with get_conn() as conn:
        with conn.transaction():
            yield conn


def json_response(status: int, **payload):
    response = jsonify(payload)
    response.status_code = status
    return response


@app.errorhandler(Exception)
def handle_error(error):
    message = str(error) or 'Internal server error'
    if 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string' in message:
        return json_response(
            500,
            message='数据库认证失败：当前 PostgreSQL 使用 SCRAM 且未提供有效密码。请设置 PGPASSWORD（或 POSTGRES_PASSWORD / DATABASE_URL）后重启服务。',
        )
    return json_response(500, message=message)


def validate_non_empty_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)


def build_oss_bucket():
    access_key = optional_env('OSS_ACCESS_KEY')
    secret_key = optional_env('OSS_SECRET_KEY')
    endpoint = optional_env('OSS_ENDPOINT')
    region = optional_env('OSS_REGION')
    bucket_name = optional_env('OSS_BUCKET_NAME')

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


def append_timestamp_to_filename(path_obj: Path) -> str:
    suffixes = ''.join(path_obj.suffixes)
    timestamp = int(time.time() * 1000)

    if suffixes:
        base_name = path_obj.name[:-len(suffixes)]
        return f'{base_name}_{timestamp}{suffixes}'

    return f'{path_obj.name}_{timestamp}'


def normalize_resource_value(value: str, name: str):
    normalized = value.strip()
    if is_http_url(normalized):
        return normalized

    access_key, secret_key, endpoint, region, bucket_name = build_oss_bucket()
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

    if path_obj.is_file():
        filename_with_ts = append_timestamp_to_filename(path_obj)
        key = f'{name}/{filename_with_ts}'
        resp = client.put_object_from_file(bucket_name, key, str(path_obj))
        if getattr(resp, 'status_code', None) != 200:
            raise ValueError(f'上传失败, status_code={getattr(resp, "status_code", "unknown")}')
        return f'https://{bucket_name}.{endpoint}/{key}'

    if path_obj.is_dir():
        url_list = []
        for file_path in sorted(path_obj.rglob('*')):
            if not file_path.is_file():
                continue

            relative_path = file_path.relative_to(path_obj)
            parent_dir = relative_path.parent.as_posix()
            filename_with_ts = append_timestamp_to_filename(file_path)

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


def parse_positive_int(value, default: int, max_value: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed <= 0:
        return default
    if max_value is not None:
        return min(parsed, max_value)
    return parsed


def to_iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def serialize_episode_row(row):
    return {
        'episode': int(row['episode']),
        'firstIngestedAt': to_iso(row['firstIngestedAt']),
        'updatedAt': to_iso(row['updatedAt']),
        'videoUrl': row['videoUrl'],
    }


def serialize_series_row(row):
    episodes = row.get('episodes') or []
    return {
        'id': row['id'],
        'name': row['name'],
        'poster': row['poster'],
        'firstIngestedAt': to_iso(row['firstIngestedAt']),
        'updatedAt': to_iso(row['updatedAt']),
        'lastNewEpisodeAt': to_iso(row['lastNewEpisodeAt']),
        'tags': row.get('tags') or [],
        'episodes': [
            {
                'episode': int(ep['episode']),
                'firstIngestedAt': to_iso(ep['firstIngestedAt']),
                'updatedAt': to_iso(ep['updatedAt']),
                'videoUrl': ep['videoUrl'],
            }
            for ep in episodes
        ],
    }


def assign_title_tags(conn: psycopg.Connection, title_id: int, tags: list[str]):
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


def resolve_sort(sort: str | None) -> str:
    sort_map = {
        'updated_desc': 't.updated_at DESC, t.name ASC',
        'updated_asc': 't.updated_at ASC, t.name ASC',
        'ingested_asc': 't.first_ingested_at ASC, t.name ASC',
        'ingested_desc': 't.first_ingested_at DESC, t.name ASC',
        'name_asc': 't.name ASC',
        'name_desc': 't.name DESC',
    }
    return sort_map.get(sort or '', sort_map['updated_desc'])


def parse_chinese_number(raw: str | None):
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


def extract_episode_no_by_text(raw_text: str | None):
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
        value = parse_chinese_number(match.group(1))
        if isinstance(value, int) and value > 0:
            return value

    fallback = re.search(r'(\d{1,4})', text)
    if not fallback:
        return None
    value = int(fallback.group(1))
    return value if value > 0 else None


def parse_directory_links(html: str, directory_url: str):
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
        episode_no = extract_episode_no_by_text(filename) or extract_episode_no_by_text(pathname)
        if not episode_no:
            continue
        files.append({'episodeNo': episode_no, 'videoUrl': absolute, 'filename': filename})

    files.sort(key=lambda item: (item['episodeNo'], item['videoUrl']))
    unique = {}
    for item in files:
        unique.setdefault(item['episodeNo'], item)
    return list(unique.values())


def query_series(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
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
    order_by_clause = resolve_sort(sort)
    order_by_selected_titles = order_by_clause.replace('t.', 'st.')

    with get_conn() as conn, conn.cursor() as cur:
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

    data = [serialize_series_row(row) for row in rows]
    return {
        'data': data,
        'pagination': {
            'total': total,
            'page': safe_page,
            'pageSize': page_size,
            'totalPages': total_pages,
        },
    }


def get_flat_ingest_records():
    with get_conn() as conn, conn.cursor() as cur:
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
                'firstIngestedAt': to_iso(row['firstIngestedAt']),
                'updatedAt': to_iso(row['updatedAt']),
                'tags': row.get('tags') or [],
            }
        )
    return out


@app.route('/api/health', methods=['GET'])
def api_health():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute('SELECT 1')
        cur.fetchone()
    return json_response(200, status='ok')


@app.route('/api/ingest-records', methods=['GET'])
def api_ingest_records():
    return json_response(200, data=get_flat_ingest_records())


@app.route('/api/series', methods=['GET'])
def api_series():
    payload = query_series(
        tag=request.args.get('tag'),
        name=request.args.get('name'),
        search=request.args.get('search'),
        sort=request.args.get('sort'),
        page=parse_positive_int(request.args.get('page'), 1),
        page_size=parse_positive_int(request.args.get('pageSize'), 25, 100),
    )
    return json_response(200, **payload)


@app.route('/api/tags', methods=['GET'])
def api_tags_get():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute('SELECT tag_name FROM tag ORDER BY sort_no ASC, tag_name ASC')
        rows = cur.fetchall()
    return json_response(200, data=[row['tag_name'] for row in rows])


@app.route('/api/tags', methods=['POST'])
def api_tags_post():
    body = request.get_json(silent=True) or {}
    if not validate_non_empty_string(body.get('tagName')):
        return json_response(400, message='tagName 不能为空')
    tag_name = body['tagName'].strip()
    try:
        with get_tx() as conn, conn.cursor() as cur:
            cur.execute('INSERT INTO tag(tag_name) VALUES (%s)', (tag_name,))
    except UniqueViolation:
        return json_response(409, message='标签已存在')
    return json_response(201, message='标签已创建，请为剧集分配此标签', data=tag_name)


@app.route('/api/tags/<path:tag_name>', methods=['PATCH'])
def api_tags_patch(tag_name):
    body = request.get_json(silent=True) or {}
    if not validate_non_empty_string(body.get('newTagName')):
        return json_response(400, message='newTagName 不能为空')
    new_tag_name = body['newTagName'].strip()
    try:
        with get_tx() as conn, conn.cursor() as cur:
            cur.execute('UPDATE tag SET tag_name = %s WHERE tag_name = %s', (new_tag_name, tag_name))
            if cur.rowcount == 0:
                return json_response(404, message='标签不存在')
    except UniqueViolation:
        return json_response(409, message='标签已存在')
    return json_response(200, message='标签改名成功')


@app.route('/api/tags/<path:tag_name>', methods=['DELETE'])
def api_tags_delete(tag_name):
    with get_tx() as conn, conn.cursor() as cur:
        cur.execute('DELETE FROM tag WHERE tag_name = %s', (tag_name,))
        if cur.rowcount == 0:
            return json_response(404, message='标签不存在')
    return json_response(200, message='标签已删除')


@app.route('/api/titles', methods=['POST'])
def api_titles_post():
    body = request.get_json(silent=True) or {}
    if not validate_non_empty_string(body.get('name')) or not validate_non_empty_string(body.get('poster')):
        return json_response(400, message='name 和 poster 不能为空')

    name = body['name'].strip()
    poster = body['poster'].strip()
    tags = [tag.strip() for tag in body.get('tags', []) if validate_non_empty_string(tag)]

    try:
        with get_tx() as conn, conn.cursor() as cur:
            cur.execute('INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id', (name, poster))
            title_id = cur.fetchone()['id']
            assign_title_tags(conn, title_id, tags)
    except UniqueViolation:
        return json_response(409, message='漫剧名称已存在')
    return json_response(201, message='漫剧已创建')


@app.route('/api/titles/<path:title_name>', methods=['PATCH'])
def api_titles_patch(title_name):
    body = request.get_json(silent=True) or {}
    if not validate_non_empty_string(body.get('newName')) or not validate_non_empty_string(body.get('poster')) or not isinstance(body.get('tags'), list):
        return json_response(400, message='newName、poster、tags 参数不完整')

    new_name = body['newName'].strip()
    poster = body['poster'].strip()
    tags = [tag.strip() for tag in body['tags'] if validate_non_empty_string(tag)]
    if not tags:
        return json_response(400, message='tags 至少需要一个标签')

    try:
        with get_tx() as conn, conn.cursor() as cur:
            cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
            row = cur.fetchone()
            if not row:
                return json_response(404, message='漫剧不存在')
            title_id = row['id']
            cur.execute('UPDATE title SET name = %s, cover_url = %s WHERE id = %s', (new_name, poster, title_id))
            assign_title_tags(conn, title_id, tags)
    except UniqueViolation:
        return json_response(409, message='目标名称已存在')
    return json_response(200, message='漫剧信息修改成功')


@app.route('/api/titles/<path:title_name>', methods=['DELETE'])
def api_titles_delete(title_name):
    with get_tx() as conn, conn.cursor() as cur:
        cur.execute('DELETE FROM title WHERE name = %s', (title_name,))
        if cur.rowcount == 0:
            return json_response(404, message='漫剧不存在')
    return json_response(200, message='漫剧删除成功')


@app.route('/api/episodes/batch-directory', methods=['POST'])
def api_episodes_batch_directory():
    body = request.get_json(silent=True) or {}
    name = str(body.get('name') or '').strip()
    poster = str(body.get('poster') or '').strip()
    directory_url = str(body.get('directoryUrl') or '').strip()
    tags = [tag.strip() for tag in body.get('tags', []) if validate_non_empty_string(tag)]

    if not name or not poster or not directory_url:
        return json_response(400, message='name、poster、directoryUrl 不能为空')
    if not tags:
        return json_response(400, message='tags 至少需要一个标签')

    parsed = urlparse(directory_url)
    if parsed.scheme not in {'http', 'https'}:
        return json_response(400, message='directoryUrl 只支持 http/https')
    if not parsed.netloc:
        return json_response(400, message='directoryUrl 不是合法 URL')

    response = requests.get(directory_url, timeout=20)
    if response.status_code >= 400:
        return json_response(400, message=f'读取目录失败：HTTP {response.status_code}')
    content_type = response.headers.get('content-type', '')
    if not re.search(r'text/html|application/xhtml\+xml', content_type, re.I):
        return json_response(400, message='目录地址返回的不是 HTML 页面，无法解析视频列表')

    parsed_episodes = parse_directory_links(response.text, directory_url)
    if not parsed_episodes:
        return json_response(400, message='目录中未识别到可导入的视频文件。请确认链接可直接访问且文件名包含集号（如第1集/第一集/EP01）。')

    try:
        with get_tx() as conn, conn.cursor() as cur:
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
                return json_response(400, message='所选标签不存在，请先创建标签')

            assign_title_tags(conn, title_id, tags)

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
        return json_response(409, message='漫剧名称冲突，请更换名称')

    return json_response(
        201,
        message=f'批量导入完成，共识别 {len(parsed_episodes)} 集',
        data={
            'total': len(parsed_episodes),
            'inserted': stats['inserted'] if stats else 0,
            'updated': stats['updated'] if stats else 0,
            'episodes': [{'episodeNo': item['episodeNo'], 'videoUrl': item['videoUrl']} for item in parsed_episodes],
        },
    )


@app.route('/api/episodes', methods=['POST'])
def api_episodes_post():
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    try:
        episode_no = int(body.get('episodeNo'))
    except (TypeError, ValueError):
        episode_no = None
    video_url = str(body.get('videoUrl') or '').strip()

    if not title_name or episode_no is None or not video_url:
        return json_response(400, message='参数不完整')
    if episode_no <= 0:
        return json_response(400, message='集号必须大于0')

    with get_tx() as conn, conn.cursor() as cur:
        cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return json_response(404, message='漫剧不存在')
        try:
            cur.execute('INSERT INTO episode(title_id, episode_no, episode_url) VALUES (%s, %s, %s)', (title_row['id'], episode_no, video_url))
        except UniqueViolation:
            return json_response(409, message='目标集号已存在')
    return json_response(201, message='剧集新增成功')


@app.route('/api/episodes', methods=['PATCH'])
def api_episodes_patch():
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    video_url = str(body.get('videoUrl') or '').strip()
    try:
        source_no = int(body.get('episodeNo'))
        target_no = int(body.get('newEpisodeNo'))
    except (TypeError, ValueError):
        source_no = None
        target_no = None

    if not title_name or source_no is None or target_no is None or not video_url:
        return json_response(400, message='参数不完整')
    if source_no <= 0 or target_no <= 0:
        return json_response(400, message='集号必须大于0')

    with get_tx() as conn, conn.cursor() as cur:
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
            return json_response(409, message='目标集号已存在')
        if cur.rowcount == 0:
            return json_response(404, message='剧集不存在')
    return json_response(200, message='剧集信息修改成功')


@app.route('/api/episodes', methods=['DELETE'])
def api_episodes_delete():
    body = request.get_json(silent=True) or {}
    title_name = str(body.get('titleName') or '').strip()
    try:
        episode_no = int(body.get('episodeNo'))
    except (TypeError, ValueError):
        episode_no = None

    if not title_name or episode_no is None:
        return json_response(400, message='参数不完整')
    if episode_no <= 0:
        return json_response(400, message='集号必须大于0')

    with get_tx() as conn, conn.cursor() as cur:
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
            return json_response(404, message='剧集不存在')
    return json_response(200, message='剧集删除成功')


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def spa(path: str):
    if path.startswith('api/'):
        return json_response(404, message='API endpoint not found.')
    return render_template('index.html')


if __name__ == '__main__':
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', '4173'))
    app.run(host=host, port=port, debug=False)
