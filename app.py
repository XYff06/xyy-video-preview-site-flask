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


def get_normalized_env_var(name: str):
    """读取环境变量并做strip，空字符串按None处理"""
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def build_database_dsn() -> str:
    """构建 PostgreSQL DSN，优先使用 DATABASE_URL。"""
    database_url = get_normalized_env_var('DATABASE_URL')
    if database_url:
        return database_url

    host = get_normalized_env_var('PGHOST') or '127.0.0.1'
    port = get_normalized_env_var('PGPORT') or '5432'
    user = get_normalized_env_var('PGUSER') or 'postgres'
    password = get_normalized_env_var('PGPASSWORD') or get_normalized_env_var('POSTGRES_PASSWORD') or ''
    database = get_normalized_env_var('PGDATABASE') or 'video_preview'

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
    """读取OSS配置并校验必填项，返回创建客户端所需的参数"""
    access_key = get_normalized_env_var('OSS_ACCESS_KEY')
    secret_key = get_normalized_env_var('OSS_SECRET_KEY')
    endpoint = get_normalized_env_var('OSS_ENDPOINT')
    region = get_normalized_env_var('OSS_REGION')
    bucket_name = get_normalized_env_var('OSS_BUCKET_NAME')

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
    """给文件名追加毫秒时间戳，避免上传到对象存储时发生同名覆盖"""
    suffixes = ''.join(path_obj.suffixes)
    timestamp = int(time.time() * 1000)

    if suffixes:
        base_name = path_obj.name[:-len(suffixes)]
        return f'{base_name}_{timestamp}{suffixes}'

    return f'{path_obj.name}_{timestamp}'


def resolve_resource_to_url(value: str, name: str, local_path_kind: str = 'any'):
    """
    将资源输入规范化为可访问URL
    支持两类输入:
    - 远程URL: 直接返回
    - 本地文件/目录: 上传到对象存储后返回URL(目录会返回URL列表)
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

    try:
        # 把用户输入的本地路径转换成绝对Path对象，expanduser()会展开"~"，resolve(strict=True)会要求路径必须真实存在
        path_object = Path(normalized).expanduser().resolve(strict=True)
    except FileNotFoundError:
        # 路径不存在时，转成统一的业务错误给上层接口处理
        raise ValueError(f'<{normalized}>本地路径不存在')
    except Exception as e:
        # 兜底捕获其他路径解析错误，例如非法路径格式或系统层异常
        raise ValueError(f'路径解析失败: {e}')

    client = tos.TosClientV2(access_key, secret_key, endpoint, region)

    # 限制当前场景允许的路径类型，any=文件或目录都可以，file=只允许文件，dir=只允许目录
    if local_path_kind not in {'any', 'file', 'dir'}:
        raise ValueError('local_path_kind 参数非法')

    # 单文件上传分支
    if path_object.is_file():
        if local_path_kind == 'dir':
            raise ValueError('本地路径必须是目录，不能是文件')
        # 给文件名追加时间戳，避免上传到对象存储时重名覆盖
        filename_with_timestamp = append_millisecond_timestamp_to_filename(path_object)
        # 对象存储中的目标key
        key = f'{name}/{filename_with_timestamp}'
        response = client.put_object_from_file(bucket_name, key, str(path_object))
        if getattr(response, 'status_code', None) != 200:
            raise ValueError(f'上传失败，status_code={getattr(response, "status_code", "unknown")}')
        # 返回上传后可访问的完整URL
        return f'https://{bucket_name}.{endpoint}/{key}'

    # 目录批量上传分支
    if path_object.is_dir():
        if local_path_kind == 'file':
            raise ValueError('本地路径必须是文件，不能是目录')
        # 收集目录下所有成功上传文件的访问地址
        url_list = []
        for file_path in sorted(path_object.rglob('*')):
            # 只上传文件，跳过目录节点
            if not file_path.is_file():
                continue

            # relative_path用于保留原目录结构，parent_dir是相对父目录路径
            relative_path = file_path.relative_to(path_object)
            parent_dir = relative_path.parent.as_posix()
            filename_with_timestamp = append_millisecond_timestamp_to_filename(file_path)

            # 如果文件位于子目录下，就把子目录结构一并带到对象存储key中
            if parent_dir and parent_dir != '.':
                key = f'{name}/{parent_dir}/{filename_with_timestamp}'
            else:
                key = f'{name}/{filename_with_timestamp}'

            resp = client.put_object_from_file(bucket_name, key, str(file_path))
            if getattr(resp, 'status_code', None) != 200:
                raise ValueError(f'上传失败: {file_path}, status_code={getattr(resp, "status_code", "unknown")}')

            url_list.append(f'https://{bucket_name}.{endpoint}/{key}')

        # 目录存在但没有任何可上传文件时，视为无效输入
        if not url_list:
            raise ValueError('目录为空，或目录下没有可上传文件')

        return url_list

    # 路径存在，但既不是普通文件也不是普通目录
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
    """把数据库中的datetime统一转成ISO字符串，便于前端稳定消费"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def serialize_episode_record(row):
    """把单条剧集记录转换成前端使用的响应结构"""
    return {
        'episode': int(row['episode']),
        'firstIngestedAt': convert_to_iso_datetime(row['firstIngestedAt']),
        'updatedAt': convert_to_iso_datetime(row['updatedAt']),
        'videoUrl': row['videoUrl'],
    }


def serialize_series_record(row):
    """把聚合后的漫剧记录转换成前端可直接渲染的结构"""
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


def replace_title_tags(conn: psycopg.Connection, title_id: int, tags: list[str]):
    """用请求中的整组标签覆盖当前漫剧标签，避免残留旧关联"""
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


def build_series_order_by_sql(sort: str | None) -> str:
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
    """把中文数字片段解析成整数，供剧集号识别逻辑复用"""
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    total = 0
    current = 0
    for ch in raw:
        # 先记录当前数字位，后面遇到十/百/千时再按单位累加到total
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
    """优先按常见剧集格式提取集号，严格匹配失败后再退回普通数字提取"""
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


def extract_episode_records_from_directory_html(html: str, directory_url: str):
    """从目录HTML中提取剧集记录，并按集号去重后返回"""
    href_matches = re.findall(r'href\s*=\s*(["\'])(.*?)\1', str(html or ''), re.I | re.S)
    episode_records = []
    for _, raw_href in href_matches:
        raw_href = raw_href.strip()
        # 先过滤掉不会指向视频文件的锚点和脚本链接
        if not raw_href or raw_href.startswith('#') or raw_href.startswith('?'):
            continue
        if raw_href.lower().startswith(('mailto:', 'javascript:')):
            continue

        absolute_video_url = urljoin(directory_url, raw_href)
        pathname = unquote(urlparse(absolute_video_url).path)
        if pathname.endswith('/'):
            continue
        if not VIDEO_EXTENSION_RE.search(pathname):
            continue

        filename = pathname.split('/')[-1] if pathname else ''
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        episode_records.append({'episodeNo': episode_no, 'videoUrl': absolute_video_url, 'filename': filename})

    episode_records.sort(key=lambda item: (item['episodeNo'], item['videoUrl']))
    deduplicated_episode_records = {}
    # 排序后只保留同一集号最先出现的那条记录，保证结果稳定
    for episode_record in episode_records:
        deduplicated_episode_records.setdefault(episode_record['episodeNo'], episode_record)
    return list(deduplicated_episode_records.values())


def extract_episode_records_from_url_list(video_urls: list[str]):
    """从一组视频URL中提取剧集记录，并按集号去重后返回"""
    episode_records = []
    for video_url in video_urls:
        pathname = unquote(urlparse(video_url).path)
        filename = pathname.split('/')[-1] if pathname else ''
        episode_no = extract_episode_number_from_text(filename) or extract_episode_number_from_text(pathname)
        if not episode_no:
            continue
        episode_records.append({'episodeNo': episode_no, 'videoUrl': video_url, 'filename': filename})

    episode_records.sort(key=lambda item: (item['episodeNo'], item['videoUrl']))
    deduplicated_episode_records = {}
    for episode_record in episode_records:
        deduplicated_episode_records.setdefault(episode_record['episodeNo'], episode_record)
    return list(deduplicated_episode_records.values())


def query_series_page_data(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
    """按筛选条件查询漫剧分页数据，并聚合标签与剧集信息。"""
    filters = []
    values = []

    if tag:
        values.append(tag)
        # 标签筛选用EXISTS子查询，结果上只要求当前漫剧至少命中过一次该标签
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
        # 搜索场景会先把关键字转成小写，再和LOWER(name)做模糊匹配
        values.append(f"%{search.strip().lower()}%")
        filters.append('LOWER(t.name) LIKE %s')

    # 没有任何筛选条件时不拼WHERE，从而复用同一套SQL模板
    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ''
    order_by_clause = build_series_order_by_sql(sort)
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

        # 先用selected_titles选出当前页标题，再聚合标签和剧集，避免分页落在聚合后的结果上
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

    # 列表推导会把每一行数据库结果都转换成前端直接可消费的漫剧结构
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


def query_flat_episode_ingest_records():
    """查询按剧集展开的导入记录列表，供管理视图直接消费"""
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
        # 这里按剧集逐条展开，方便前端管理视图直接显示每一集对应的导入信息
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
    return build_json_response(200, data=query_flat_episode_ingest_records())


@flask_app.route('/api/series', methods=['GET'])
def api_series():
    """漫剧列表接口：支持标签/关键字/排序/分页查询。"""
    payload = query_series_page_data(
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
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute('SELECT tag_name FROM tag ORDER BY sort_no ASC, tag_name ASC')
        tag_rows = db_cursor.fetchall()
    return build_json_response(200, data=[tag_row['tag_name'] for tag_row in tag_rows])


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
    """创建漫剧基础信息(名称、封面、标签)"""
    request_json = request.get_json(silent=True) or {}
    if not is_non_empty_text(request_json.get('name')):
        return build_json_response(400, message='name不能为空')
    if not is_non_empty_text(request_json.get('poster')):
        return build_json_response(400, message='poster不能为空')

    title_name = request_json['name'].strip()
    # 列表推导会过滤空白标签，并把其余标签统一裁剪空格后再入库
    selected_tags = [tag_name.strip() for tag_name in request_json.get('tags', []) if is_non_empty_text(tag_name)]

    try:
        with open_db_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute('INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id', (title_name, '__pending__'))
            created_title_id = db_cursor.fetchone()['id']
            poster_url = resolve_resource_to_url(
                request_json['poster'],
                str(created_title_id),
                local_path_kind='file',
            )
            db_cursor.execute('UPDATE title SET cover_url = %s WHERE id = %s', (poster_url, created_title_id))
            replace_title_tags(db_connection, created_title_id, selected_tags)
    except ValueError as resolve_error:
        return build_json_response(400, message=str(resolve_error))
    except UniqueViolation:
        return build_json_response(409, message=f'<{title_name}>漫剧名称已存在')
    return build_json_response(201, message=f'<{title_name}>漫剧已创建')


@flask_app.route('/api/titles/<path:title_name>', methods=['PATCH'])
def api_titles_patch(title_name):
    body = request.get_json(silent=True) or {}
    if not is_non_empty_text(body.get('newName')) or not is_non_empty_text(body.get('poster')) or not isinstance(body.get('tags'), list):
        return build_json_response(400, message='newName、poster、tags 参数不完整')

    new_name = body['newName'].strip()
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
            poster = resolve_resource_to_url(body['poster'], str(title_id), local_path_kind='file')
            cur.execute('UPDATE title SET name = %s, cover_url = %s WHERE id = %s', (new_name, poster, title_id))
            replace_title_tags(conn, title_id, tags)
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
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
    # 列表推导会先过滤空标签，再把保留下来的标签名裁掉首尾空白
    tags = [tag.strip() for tag in body.get('tags', []) if is_non_empty_text(tag)]

    if not name or not poster or not directory_url:
        return build_json_response(400, message='name、poster、directoryUrl 不能为空')
    if not tags:
        return build_json_response(400, message='tags 至少需要一个标签')

    try:
        with open_db_transaction() as conn, conn.cursor() as cur:
            cur.execute('SELECT id FROM title WHERE name = %s', (name,))
            existing_title_row = cur.fetchone()
            if existing_title_row:
                title_id = existing_title_row['id']
            else:
                cur.execute('INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id', (name, '__pending__'))
                title_id = cur.fetchone()['id']

            # 先把封面和目录资源解析成可访问地址
            # 目录输入如果来自本地目录，最终可能直接得到一组已上传的视频URL
            title_storage_prefix = str(title_id)
            poster = resolve_resource_to_url(poster, title_storage_prefix, local_path_kind='file')
            resolved_directory_resource = resolve_resource_to_url(directory_url, title_storage_prefix, local_path_kind='dir')
            if isinstance(resolved_directory_resource, list):
                parsed_episode_records = extract_episode_records_from_url_list(resolved_directory_resource)
            else:
                parsed = urlparse(resolved_directory_resource)
                if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
                    raise ValueError('directoryUrl 不是合法 URL')

                # 目录URL场景会先拉取HTML，再从页面里筛出视频链接
                response = requests.get(resolved_directory_resource, timeout=20)
                if response.status_code >= 400:
                    raise ValueError(f'读取目录失败：HTTP {response.status_code}')
                content_type = response.headers.get('content-type', '')
                if not re.search(r'text/html|application/xhtml\+xml', content_type, re.I):
                    raise ValueError('目录地址返回的不是 HTML 页面，无法解析视频列表')

                parsed_episode_records = extract_episode_records_from_directory_html(response.text, resolved_directory_resource)
            if not parsed_episode_records:
                raise ValueError('目录中未识别到可导入的视频文件。请确认链接可直接访问且文件名包含集号（如第1集/第一集/EP01）。')

            cur.execute('UPDATE title SET cover_url = %s WHERE id = %s', (poster, title_id))

            cur.execute('SELECT id, tag_name FROM tag WHERE tag_name = ANY(%s)', (tags,))
            tag_rows = cur.fetchall()
            if not tag_rows:
                raise ValueError('所选标签不存在，请先创建标签')

            replace_title_tags(conn, title_id, tags)

            # 两个列表推导会把解析结果拆成并行数组
            # 后面的UNNEST会把这两个数组重新展开成SQL里的临时输入表
            episode_numbers = [item['episodeNo'] for item in parsed_episode_records]
            episode_urls = [item['videoUrl'] for item in parsed_episode_records]
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
                (episode_numbers, episode_urls, title_id, title_id),
            )
            upsert_stats = cur.fetchone()
    except ValueError as exc:
        return build_json_response(400, message=str(exc))
    except UniqueViolation:
        return build_json_response(409, message='漫剧名称冲突，请更换名称')

    return build_json_response(
        201,
        message=f'批量导入完成，共识别 {len(parsed_episode_records)} 集',
        data={
            'total': len(parsed_episode_records),
            'inserted': upsert_stats['inserted'] if upsert_stats else 0,
            'updated': upsert_stats['updated'] if upsert_stats else 0,
            'episodes': [{'episodeNo': item['episodeNo'], 'videoUrl': item['videoUrl']} for item in parsed_episode_records],
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

    if episode_no <= 0:
        return build_json_response(400, message='集号必须大于0')

    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return build_json_response(404, message='漫剧不存在')
        try:
            video_url = resolve_resource_to_url(
                raw_video_url,
                str(title_row['id']),
                local_path_kind='file',
            )
        except ValueError as exc:
            return build_json_response(400, message=str(exc))
        if isinstance(video_url, list):
            return build_json_response(400, message='videoUrl 必须是单个视频资源地址，不能是目录')
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
        current_episode_no = int(body.get('episodeNo'))
        new_episode_no = int(body.get('newEpisodeNo'))
    except (TypeError, ValueError):
        current_episode_no = None
        new_episode_no = None

    if not title_name or current_episode_no is None or new_episode_no is None or not raw_video_url:
        return build_json_response(400, message='参数不完整')
    if current_episode_no <= 0 or new_episode_no <= 0:
        return build_json_response(400, message='集号必须大于0')

    with open_db_transaction() as conn, conn.cursor() as cur:
        cur.execute('SELECT id FROM title WHERE name = %s', (title_name,))
        title_row = cur.fetchone()
        if not title_row:
            return build_json_response(404, message='漫剧不存在')
        try:
            video_url = resolve_resource_to_url(
                raw_video_url,
                str(title_row['id']),
                local_path_kind='file',
            )
        except ValueError as exc:
            return build_json_response(400, message=str(exc))
        # 单集接口只接受单个视频资源；如果得到列表，说明用户传入的是目录而不是文件
        if isinstance(video_url, list):
            return build_json_response(400, message='videoUrl 必须是单个视频资源地址，不能是目录')
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
                (new_episode_no, video_url, title_name, current_episode_no),
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
