import math
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import chinese2digits
import psycopg
import requests
import tos
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row

flask_app = Flask(__name__, template_folder="templates", static_folder="static")
flask_app.config["JSON_AS_ASCII"] = False

"""load_dotenv"""
ROOT_DIRECTORY = Path(__file__).resolve().parent
load_dotenv(ROOT_DIRECTORY / ".env")
# 判断字符串里是否包含常见视频扩展名，并且扩展名后面要么已经结束，要么后面接的是URL参数?或锚点#，同时忽略大小写
VIDEO_EXTENSION_RE = re.compile(
    r"\.(mp4|m3u8|mov|mkv|avi|flv|webm|ts|m4v|wmv|mpg|mpeg|3gp|rm|rmvb|vob|ogv|asf|f4v|mts|m2ts)(?:$|[?#])",
    re.I
)
EPISODE_SUFFIX_RE = r"(?:集|话|話|回|篇|章|节|卷)"
EPISODE_PATTERNS = [
    re.compile(rf"^第(?P<raw>.+?){EPISODE_SUFFIX_RE}(?:.*)?$", re.I),
    re.compile(rf"^EP(?P<raw>[^_ \-.]+)(?:.*)?$", re.I),
    re.compile(rf"^(?P<raw>.+?){EPISODE_SUFFIX_RE}(?:.*)?$", re.I),
]


def get_normalized_environment_variable(environment_variable_name: str):
    """
    读取环境变量
    :param environment_variable_name: 环境变量名
    :return: os.getenv(environment_variable_name).strip() or None
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


def build_json_response(status: int, **payload):
    """构造统一的JSON响应对象并写入状态码"""
    response = jsonify(payload)
    response.status_code = status
    return response


@flask_app.route("/api/health", methods=["GET"])
def api_health():
    """检查Flask接口是否能正常执行；检查数据库是否可用"""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT 1")
        db_cursor.fetchone()
    return build_json_response(200, result="ok")


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


def is_valid_text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


@flask_app.route("/api/tags", methods=["GET"])
def api_tags_get():
    """查询全部标签，从tag表里查出所有tag_name，按tag_name升序排序，把查询结果整理成纯字符串列表返回给前端"""
    # 打开数据库连接并创建游标对象，with结束后连接和游标都会自动关闭
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT tag_name FROM tag ORDER BY tag_name ASC")
        tag_rows = db_cursor.fetchall()
    return build_json_response(200, data=[tag_row["tag_name"] for tag_row in tag_rows])


@flask_app.route("/api/tags", methods=["POST"])
def api_tags_post():
    """创建标签"""
    # 尝试把请求体解析成JSON，如果解析失败、请求体为空或者不是合法JSON，就用空字典兜底
    request_body = request.get_json(silent=True) or {}
    # 校验tagName是否有效
    if not is_valid_text(request_body.get("tagName")):
        return build_json_response(400, message="无效tagName")
    tag_name = request_body["tagName"].strip()
    try:
        # 开启事务执行创建，创建成功会提交，失败会回滚
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("INSERT INTO tag(tag_name) VALUES (%s)", (tag_name,))
    except UniqueViolation:
        return build_json_response(409, message=f"标签创建失败: 目标标签名<{tag_name}>已存在")
    # 标签创建成功，返回201
    return build_json_response(201, message=f"标签创建成功: 目标标签名<{tag_name}>已创建")


@flask_app.route("/api/tags/<path:tag_name>", methods=["PATCH"])
def api_tags_patch(tag_name):
    """重命名标签"""
    # 尝试把请求体解析成JSON，如果解析失败、请求体为空或者不是合法JSON，就用空字典兜底
    request_body = request.get_json(silent=True) or {}
    # 校验newTagName是否有效
    if not is_valid_text(request_body.get("newTagName")):
        return build_json_response(400, message="无效newTagName")
    new_tag_name = request_body["newTagName"].strip()
    if tag_name == new_tag_name:
        return build_json_response(400, message=f"标签重命名失败: 新旧标签名相同(<{new_tag_name}>)")
    try:
        # 开启事务执行改名，改名成功会提交，失败会回滚
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("UPDATE tag SET tag_name = %s WHERE tag_name = %s", (new_tag_name, tag_name))
            # 如果影响行数是0，说明原标签不存在
            if db_cursor.rowcount == 0:
                return build_json_response(404, message=f"标签重命名失败: 原标签名<{tag_name}>不存在")
    except UniqueViolation:
        return build_json_response(409, message=f"标签重命名失败: 目标标签名<{new_tag_name}>已存在")
    # 标签改名成功，返回200
    return build_json_response(200, message=f"标签重命名成功!!!原标签名: <{tag_name}>，新标签名: <{new_tag_name}>")


@flask_app.route("/api/tags/<path:tag_name>", methods=["DELETE"])
def api_tags_delete(tag_name):
    """删除标签"""
    # 开启事务执行删除，删除成功会提交，失败会回滚
    with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("DELETE FROM tag WHERE tag_name = %s", (tag_name,))
        # 如果没有删到记录，说明这个标签不存在
        if db_cursor.rowcount == 0:
            return build_json_response(404, message=f"标签删除失败: 目标标签名<{tag_name}>不存在")
    # 标签删除成功，返回200
    return build_json_response(200, message=f"标签删除成功: 目标标签名<{tag_name}>已删除")


def replace_title_tags(db_connection: psycopg.Connection, title_id: int, tags: list[str]):
    """
    用请求里的整组标签覆盖当前漫剧标签:
    1. 先把请求标签规范化成去重后的集合
    2. 如果新旧标签集合完全一致，就直接跳过写入
    3. 只有在确实发生变化时，才清空旧关联再回填新关联
    """
    normalized_tags = set(tags)
    with db_connection.cursor() as db_cursor:
        db_cursor.execute(
            """
            SELECT tag.tag_name
            FROM title_tag
                     JOIN tag ON tag.id = title_tag.tag_id
            WHERE title_tag.title_id = %s
            """,
            (title_id,),
        )
        current_tags = {row["tag_name"] for row in db_cursor.fetchall()}
        if current_tags == normalized_tags:
            return
        db_cursor.execute("DELETE FROM title_tag WHERE title_id = %s", (title_id,))
        if not normalized_tags:
            return
        db_cursor.execute(
            """
            INSERT INTO title_tag(title_id, tag_id)
            SELECT %s, tag.id
            FROM tag
            WHERE tag.tag_name = ANY (%s) ON CONFLICT DO NOTHING
            """,
            (title_id, list(normalized_tags)),
        )


def get_required_oss_config():
    """读取必填的OSS相关环境变量"""
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
        raise Exception(f"缺少OSS配置: {'、'.join(missing)}")
    return access_key, secret_key, endpoint, region, bucket_name


def normalize_and_validate_tag_names(raw_tag_names, db_cursor):
    """规范化并校验标签名"""
    tag_names = [str(tag_name).strip() for tag_name in (raw_tag_names or []) if is_valid_text(tag_name)]
    tag_names = list(dict.fromkeys(tag_names))
    if not tag_names:
        return []
    db_cursor.execute("SELECT tag_name FROM tag WHERE tag_name = ANY(%s)", (tag_names,), )
    existing_tag_names = {row["tag_name"] for row in db_cursor.fetchall()}
    missing_tag_names = [tag_name for tag_name in tag_names if tag_name not in existing_tag_names]
    if missing_tag_names:
        raise Exception(f"以下标签不存在: {'、'.join(missing_tag_names)}")
    return tag_names


def append_millisecond_timestamp_to_filename(path_object: Path) -> str:
    """给文件名追加毫秒时间戳，避免上传到对象存储时发生同名覆盖"""
    suffixes = "".join(path_object.suffixes)
    timestamp = int(time.time() * 1000)
    if suffixes:
        base_name = path_object.name[:-len(suffixes)]
        return f"{base_name}_{timestamp}{suffixes}"
    return f"{path_object.name}_{timestamp}"


def resolve_resource_to_url(value: str, title_id: str, local_path_kind: str = "any"):
    """
    把资源输入转换成可访问地址
    :param value: 资源输入
    :param title_id: 漫剧id
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
        raise Exception(f"Not Found: {normalized}")
    except Exception as path_error:
        raise Exception(f"路径解析失败: {path_error}")

    client = tos.TosClientV2(access_key, secret_key, endpoint, region)

    if local_path_kind not in {"any", "file", "dir"}:
        raise Exception(f"local_path_kind参数错误: {local_path_kind}")

    # 文件输入会上传一个对象并返回单个访问地址
    if path_object.is_file():
        if local_path_kind == "dir":
            raise Exception("本地路径必须是目录，不能是文件")
        # 上传前给文件名追加时间戳，这样多次导入同名文件时不会互相覆盖
        filename_with_timestamp = append_millisecond_timestamp_to_filename(path_object)
        key = f"{title_id}/{filename_with_timestamp}"
        response = client.put_object_from_file(bucket_name, key, str(path_object))
        if getattr(response, "status_code", None) != 200:
            raise Exception(f"上传失败，status_code={getattr(response, 'status_code', 'unknown')}")
        return f"https://{bucket_name}.{endpoint}/{key}"

    # 目录输入会递归上传所有文件，返回值会是一组可直接访问的地址列表
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
                key = f"{title_id}/{parent_dir}/{filename_with_timestamp}"
            else:
                key = f"{title_id}/{filename_with_timestamp}"

            response = client.put_object_from_file(bucket_name, key, str(file_path))
            if getattr(response, "status_code", None) != 200:
                raise Exception(f"上传失败: {file_path}，status_code={getattr(response, 'status_code', 'unknown')}")

            url_list.append(f"https://{bucket_name}.{endpoint}/{key}")

        if not url_list:
            raise Exception("目录为空或目录下没有可上传文件")

        return url_list

    raise Exception("输入路径既不是文件也不是目录")


@flask_app.route("/api/titles", methods=["POST"])
def api_titles_post():
    """创建漫剧"""
    # 尝试把请求体解析成JSON，如果解析失败、请求体为空或者不是合法JSON，就用空字典兜底
    request_body = request.get_json(silent=True) or {}
    if not is_valid_text(request_body.get("titleName")):
        return build_json_response(400, message="无效titleName")
    title_name = request_body["titleName"].strip()
    title_poster = str(request_body.get("titlePoster") or "").strip()
    try:
        # 开启事务执行创建，创建成功会提交，失败会回滚
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            title_tags = normalize_and_validate_tag_names(request_body.get("titleTags", []), db_cursor)
            # 创建一条只有name、cover_url=None的漫剧记录
            db_cursor.execute("INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id", (title_name, None), )
            created_title_id = db_cursor.fetchone()["id"]  # 这条记录的id
            if title_tags:
                replace_title_tags(db_connection, created_title_id, title_tags)
            if title_poster:
                poster_url = resolve_resource_to_url(title_poster, str(created_title_id), local_path_kind="file", )
                db_cursor.execute("UPDATE title SET cover_url = %s WHERE id = %s", (poster_url, created_title_id), )
    except UniqueViolation:
        return build_json_response(409, message=f"漫剧创建失败: 目标漫剧名<{title_name}>已存在")
    except Exception as e:
        return build_json_response(400, message=str(e))
    # 漫剧创建成功，返回201
    return build_json_response(201, message=f"漫剧创建成功: 目标漫剧名<{title_name}>已创建")


@flask_app.route("/api/titles/<path:title_name>", methods=["PATCH"])
def api_titles_patch(title_name):
    """修改漫剧信息"""
    request_body = request.get_json(silent=True) or {}
    if not is_valid_text(request_body.get("newTitleName")):
        return build_json_response(400, message="无效newTitleName")
    new_title_name = request_body["newTitleName"].strip()
    new_title_poster = str(request_body.get("newTitlePoster") or "").strip()
    change_messages = []
    try:
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("SELECT id, name, cover_url FROM title WHERE name = %s", (title_name,), )
            title_row = db_cursor.fetchone()
            if not title_row:
                return build_json_response(404, message=f"修改漫剧信息失败: 漫剧<{title_name}>不存在")
            title_id = title_row["id"]
            current_title_name = title_row["name"]
            current_title_cover_url = title_row["cover_url"]
            title_tags = normalize_and_validate_tag_names(request_body.get("titleTags", []), db_cursor)
            replace_title_tags(db_connection, title_id, title_tags)
            update_fields = []
            update_params = []

            if new_title_name != current_title_name:
                update_fields.append("name = %s")
                update_params.append(new_title_name)
                change_messages.append(f"原漫剧名: <{current_title_name}>，新漫剧名: <{new_title_name}>，")

            if not new_title_poster:
                target_title_cover_url = None
            else:
                target_title_cover_url = resolve_resource_to_url(new_title_poster, str(title_id), local_path_kind="file")
            if target_title_cover_url != current_title_cover_url:
                update_fields.append("cover_url = %s")
                update_params.append(target_title_cover_url)
                change_messages.append(f"原漫剧海报资源地址: <{current_title_cover_url}>，新漫剧海报资源地址: <{target_title_cover_url}>，")

            if update_fields:
                update_params.append(title_id)
                db_cursor.execute(f"UPDATE title SET {', '.join(update_fields)} WHERE id = %s", tuple(update_params), )
    except UniqueViolation:
        return build_json_response(409, message=f"漫剧信息修改失败: 目标漫剧名<{new_title_name}>已存在")
    except Exception as e:
        return build_json_response(400, message=str(e))
    return build_json_response(200, message=f"漫剧信息修改成功!!!{"".join(change_messages)}当前漫剧绑定标签: <{"、".join(title_tags) if title_tags else "无"}>")


@flask_app.route("/api/titles/<path:title_name>", methods=["DELETE"])
def api_titles_delete(title_name):
    """删除漫剧"""
    # 开启事务执行删除，删除成功会提交，失败会回滚
    with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("DELETE FROM title WHERE name = %s", (title_name,))
        if db_cursor.rowcount == 0:
            return build_json_response(404, message=f"漫剧删除失败: 目标漫剧名<{title_name}>不存在")
    return build_json_response(200, message=f"漫剧删除成功: 目标漫剧名<{title_name}>已删除")


def extract_file_urls_from_directory_html(html: str, directory_url: str):
    """从目录HTML里提取文件链接候选列表并转成绝对URL"""
    href_matches = re.findall(r"href\s*=\s*(['\"])(.*?)\1", str(html or ""), re.I | re.S)
    video_urls = []

    for _, raw_href in href_matches:
        raw_href = raw_href.strip()
        if not raw_href or raw_href.startswith("#") or raw_href.startswith("?"):
            continue
        if raw_href.lower().startswith(("mailto:", "javascript:")):
            continue

        absolute_video_url = urljoin(directory_url, raw_href)
        pathname = unquote(urlparse(absolute_video_url).path)
        if pathname.endswith("/"):
            continue
        video_urls.append(absolute_video_url)
    return list(dict.fromkeys(video_urls))


def parse_episode_no_from_filename(filename: str | None):
    """从文件名里解析集号"""
    normalized_filename = str(filename or "").strip()
    if not normalized_filename:
        return None

    stem = Path(normalized_filename).stem.strip()
    if not stem:
        return None

    raw_episode_no = None
    for pattern in EPISODE_PATTERNS:
        match = pattern.fullmatch(stem)
        if match:
            raw_episode_no = (match.group("raw") or "").strip()
            break

    if not raw_episode_no:
        return None

    try:
        parsed = chinese2digits.takeNumberFromString(raw_episode_no)
    except Exception:
        return None

    digits_list = parsed.get("digitsStringList") or []
    if not digits_list:
        return None

    try:
        episode_no = int(float(str(digits_list[0]).strip()))
    except (TypeError, ValueError):
        return None

    return episode_no if episode_no > 0 else None


def extract_episode_records_from_url_list(video_urls: list[str]):
    episode_records = []
    for video_url in video_urls:
        pathname = unquote(urlparse(video_url).path)
        filename = pathname.rsplit("/", 1)[-1] if pathname else ""
        if not VIDEO_EXTENSION_RE.search(pathname):
            continue
        episode_no = parse_episode_no_from_filename(filename)
        if episode_no is None:
            continue

        episode_records.append(
            {
                "episodeNo": episode_no,
                "videoUrl": video_url,
            }
        )

    episode_records.sort(key=lambda item: (item["episodeNo"], item["videoUrl"]))

    deduplicated_episode_records = {}
    for episode_record in episode_records:
        deduplicated_episode_records.setdefault(episode_record["episodeNo"], episode_record)

    return list(deduplicated_episode_records.values())


def build_episode_records_from_directory_input(directory_input: str, title_id: int):
    """把目录输入解析成统一的剧集记录列表"""
    try:
        resolved_directory_resource = resolve_resource_to_url(directory_input, str(title_id), local_path_kind="dir", )
    except Exception as e:
        raise Exception(e)
    video_urls = []
    if isinstance(resolved_directory_resource, str):
        response = requests.get(resolved_directory_resource, timeout=20)
        if response.status_code != 200:
            raise Exception(f"读取目录失败，status_code={response.status_code}")
        video_urls = extract_file_urls_from_directory_html(response.text, resolved_directory_resource, )
    elif isinstance(resolved_directory_resource, list):
        video_urls = resolved_directory_resource
    episode_records = extract_episode_records_from_url_list(video_urls)

    if not episode_records:
        raise Exception("目录中没有识别到可解析的视频")

    return episode_records


@flask_app.route("/api/episodes/batch-directory", methods=["POST"])
def api_episodes_batch_directory():
    """按目录批量导入剧集"""
    request_body = request.get_json(silent=True) or {}

    if not is_valid_text(request_body.get("name")):
        return build_json_response(400, message="无效name")
    if not is_valid_text(request_body.get("directory")):
        return build_json_response(400, message="无效directory")

    title_name = request_body["name"].strip()
    directory = request_body["directory"].strip()
    raw_poster = str(request_body.get("poster") or "").strip()
    selected_tags = [tag_name.strip() for tag_name in request_body.get("tags", []) if is_valid_text(tag_name)]
    selected_tags = list(dict.fromkeys(selected_tags))

    created_title = False
    parsed_episode_records = []
    upsert_stats = {"inserted": 0, "updated": 0}

    try:
        with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
            db_cursor.execute("SELECT id FROM title WHERE name = %s", (title_name,))
            title_row = db_cursor.fetchone()

            if title_row:
                title_id = title_row["id"]
            else:
                db_cursor.execute(
                    "INSERT INTO title(name, cover_url) VALUES (%s, %s) RETURNING id",
                    (title_name, None),
                )
                title_id = db_cursor.fetchone()["id"]
                created_title = True

            if selected_tags:
                db_cursor.execute(
                    "SELECT tag_name FROM tag WHERE tag_name = ANY(%s)",
                    (selected_tags,),
                )
                existing_tag_names = {row["tag_name"] for row in db_cursor.fetchall()}
                missing_tag_names = [tag_name for tag_name in selected_tags if tag_name not in existing_tag_names]
                if missing_tag_names:
                    raise Exception(f"以下标签不存在: {'、'.join(missing_tag_names)}")

            replace_title_tags(db_connection, title_id, selected_tags)

            if raw_poster:
                poster_url = resolve_resource_to_url(
                    raw_poster,
                    str(title_id),
                    local_path_kind="file",
                )
                db_cursor.execute(
                    "UPDATE title SET cover_url = %s WHERE id = %s",
                    (poster_url, title_id),
                )

            parsed_episode_records = build_episode_records_from_directory_input(directory, title_id)
            if not parsed_episode_records:
                raise Exception("目录中没有识别到可解析的视频")

            episode_numbers = [item["episodeNo"] for item in parsed_episode_records]
            episode_urls = [item["videoUrl"] for item in parsed_episode_records]

            db_cursor.execute(
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
                  AND NOT EXISTS (
                    SELECT 1
                    FROM inserted ins
                    WHERE ins.episode_no = i.episode_no
                    )
                    RETURNING e.episode_no
                    )
                SELECT (SELECT COUNT(*) ::int FROM inserted) AS inserted,
                       (SELECT COUNT(*) ::int FROM updated)  AS updated
                """,
                (episode_numbers, episode_urls, title_id, title_id),
            )
            upsert_stats = db_cursor.fetchone() or {"inserted": 0, "updated": 0}

    except UniqueViolation:
        return build_json_response(409, message=f"<{title_name}>漫剧名称已存在")
    except ValueError as error:
        return build_json_response(400, message=str(error))
    except Exception as error:
        return build_json_response(400, message=str(error))

    return build_json_response(
        201 if created_title else 200,
        message=f"批量导入完成，共识别{len(parsed_episode_records)}集，新增{upsert_stats["inserted"]}集，更新{upsert_stats["updated"]}集",
    )


@flask_app.route("/api/episodes", methods=["POST"])
def api_episodes_post():
    """新增单集内容"""
    # 尝试把请求体解析成JSON，如果解析失败、请求体为空或者不是合法JSON，就用空字典兜底
    request_body = request.get_json(silent=True) or {}
    if not is_valid_text(request_body.get("titleName")):
        return build_json_response(400, message="无效titleName")
    title_name = request_body.get("titleName").strip()
    try:
        episode_no = int(request_body.get("episodeNo"))
    except Exception:
        return build_json_response(400, message="无效episodeNo")
    if episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")
    if not is_valid_text(request_body.get("videoUrl")):
        return build_json_response(400, message="无效videoUrl")
    raw_video_url = request_body.get("videoUrl").strip()

    # 开启事务执行创建，创建成功会提交，失败会回滚
    with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT id FROM title WHERE name = %s", (title_name,))
        title_row = db_cursor.fetchone()
        if not title_row:
            return build_json_response(404, message=f"<{title_name}>漫剧不存在")
        try:
            video_url = resolve_resource_to_url(raw_video_url, str(title_row["id"]), local_path_kind="file", )
        except Exception as e:
            return build_json_response(400, message=str(e))
        try:
            db_cursor.execute("INSERT INTO episode(title_id, episode_no, episode_url) VALUES (%s, %s, %s)", (title_row["id"], episode_no, video_url))
        except UniqueViolation:
            return build_json_response(409, message=f"<{title_name}>漫剧目标集号<{episode_no}>已存在")
    return build_json_response(201, message=f"<{title_name}>漫剧剧集新增成功")


@flask_app.route("/api/episodes", methods=["PATCH"])
def api_episodes_patch():
    """修改单集集号与视频地址"""
    # 尝试把请求体解析成JSON，如果解析失败、请求体为空或者不是合法JSON，就用空字典兜底
    request_body = request.get_json(silent=True) or {}
    if not is_valid_text(request_body.get("titleName")):
        return build_json_response(400, message="无效titleName")
    title_name = request_body.get("titleName").strip()
    try:
        episode_no = int(request_body.get("episodeNo"))
    except Exception:
        return build_json_response(400, message="无效episodeNo")
    if episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")
    try:
        new_episode_no = int(request_body.get("newEpisodeNo"))
    except Exception:
        return build_json_response(400, message="无效newEpisodeNo")
    if new_episode_no <= 0:
        return build_json_response(400, message="集号必须大于0")
    if not is_valid_text(request_body.get("videoUrl")):
        return build_json_response(400, message="无效videoUrl")
    raw_video_url = request_body.get("videoUrl").strip()
    # 开启事务执行创建，创建成功会提交，失败会回滚
    with open_db_connection_in_transaction() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute("SELECT id FROM title WHERE name = %s", (title_name,))
        title_row = db_cursor.fetchone()
        if not title_row:
            return build_json_response(404, message=f"<{title_name}>漫剧不存在")
        try:
            video_url = resolve_resource_to_url(raw_video_url, str(title_row["id"]), local_path_kind="file", )
        except Exception as e:
            return build_json_response(400, message=str(e))
        try:
            db_cursor.execute(
                """
                UPDATE episode e
                SET episode_no  = %s,
                    episode_url = %s FROM title t
                WHERE e.title_id = t.id
                  AND t.name = %s
                  AND e.episode_no = %s
                """,
                (new_episode_no, video_url, title_name, episode_no),
            )
        except UniqueViolation:
            return build_json_response(409, message=f"<{title_name}>漫剧目标集号<{new_episode_no}>已存在")
        if db_cursor.rowcount == 0:
            return build_json_response(404, message=f"<{title_name}>漫剧集号<{episode_no}>剧集不存在")
    return build_json_response(200, message=f"<{title_name}>漫剧剧集信息修改成功")


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


@flask_app.route("/api/titles", methods=["GET"])
def api_titles_get():
    """返回管理面板使用的漫剧基础列表: name、cover_url、tags"""
    search = str(request.args.get("search") or "").strip()
    page = normalize_positive_int(request.args.get("page"), 1)
    page_size = normalize_positive_int(request.args.get("pageSize"), 20, 100)
    filters = []
    values = []
    if search:
        values.append(f"%{search.lower()}%")
        filters.append("LOWER(title.name) LIKE %s")
    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute(f"SELECT COUNT(*)::int AS total FROM title {where_clause}", values)
        total = db_cursor.fetchone()["total"] or 0
        total_pages = max(1, math.ceil(total / page_size))
        safe_page = max(1, min(page, total_pages))
        offset = (safe_page - 1) * page_size
        db_cursor.execute(
            f"""
            WITH paged_titles AS (
              SELECT
                title.id,
                title.name,
                title.cover_url
              FROM
                title {where_clause}
              ORDER BY
                title.name ASC,
                title.id ASC
              LIMIT
                %s OFFSET %s
            )
            SELECT
              paged_titles.name,
              paged_titles.cover_url,
              COALESCE(tag_summary.tags, ARRAY [] :: text []) AS tags
            FROM
              paged_titles
              LEFT JOIN LATERAL (
                SELECT
                  ARRAY_AGG(
                    tag.tag_name
                    ORDER BY
                      tag.tag_name
                  ) AS tags
                FROM
                  title_tag
                  JOIN tag ON tag.id = title_tag.tag_id
                WHERE
                  title_tag.title_id = paged_titles.id
              ) AS tag_summary ON TRUE
            ORDER BY
              paged_titles.name ASC,
              paged_titles.id ASC
            """,
            [*values, page_size, offset],
        )
        title_rows = db_cursor.fetchall()
    return build_json_response(
        200,
        data=title_rows,
        pagination={
            "total": total,
            "page": safe_page,
            "pageSize": page_size,
            "totalPages": total_pages,
        },
    )


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


def convert_to_iso_datetime(value):
    """把数据库时间值统一转换成ISO字符串"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return value


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


def query_series_page_data(tag=None, name=None, search=None, sort=None, page=1, page_size=25):
    """
    把前端传来的筛选条件转换成SQL:
    1. 分页选出当前页的漫剧
    2. 把每部漫剧关联的标签和剧集一起聚合出来
    3. 最后整理成前端直接能渲染的JSON结构
    """
    # TODO: 优化性能
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
              paged_titles.first_ingested_at AS "firstIngestedAt",
              paged_titles.updated_at AS "updatedAt",
              paged_titles.total_episode_count AS "totalEpisodeCount",
              paged_titles.current_max_episode_no AS "currentMaxEpisodeNo",
              paged_titles.last_new_episode_at AS "lastNewEpisodeAt",
              COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags
            FROM paged_titles
            LEFT JOIN LATERAL (
                SELECT
                  COALESCE(
                    ARRAY_AGG(tag.tag_name ORDER BY tag.tag_name),
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
    return payload


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


def serialize_series_detail_record(row):
    """把详情查询结果整理成详情页可直接消费的结构"""
    payload = serialize_series_record(row)
    payload["totalEpisodeCount"] = int(row.get("totalEpisodeCount") or len(payload["episodes"]))
    payload["currentMaxEpisodeNo"] = int(row.get("currentMaxEpisodeNo") or 0)
    return payload


def query_series_detail_data(title_name: str):
    """按标题名返回单个漫剧详情，包含完整剧集列表"""
    with open_db_connection() as db_connection, db_connection.cursor() as db_cursor:
        db_cursor.execute(
            """
            SELECT title.id,
                   title.name,
                   title.cover_url                                AS poster,
                   title.first_ingested_at                        AS "firstIngestedAt",
                   title.last_new_episode_at                      AS "lastNewEpisodeAt",
                   title.updated_at                               AS "updatedAt",
                   title.total_episode_count                      AS "totalEpisodeCount",
                   title.current_max_episode_no                   AS "currentMaxEpisodeNo",
                   COALESCE(tag_summary.tags, ARRAY[]::text[])    AS tags,
                   COALESCE(episode_summary.episodes, '[]'::json) AS episodes
            FROM title
                     LEFT JOIN LATERAL (
                SELECT COALESCE(
                               JSON_AGG(
                                       JSON_BUILD_OBJECT(
                                               'episode', episode.episode_no,
                                               'firstIngestedAt', episode.first_ingested_at,
                                               'updatedAt', episode.updated_at,
                                               'videoUrl', episode.episode_url
                                       ) ORDER BY episode.episode_no
                               ) FILTER(WHERE episode.id IS NOT NULL),
                               '[]' ::json
                       ) AS episodes
                FROM episode
                WHERE episode.title_id = title.id
                    ) AS episode_summary ON TRUE
                     LEFT JOIN LATERAL (
                SELECT COALESCE(
                               ARRAY_AGG(tag.tag_name ORDER BY tag.tag_name),
                               ARRAY[] ::text[]
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


@flask_app.route("/api/series/<path:title_name>", methods=["GET"])
def api_series_detail(title_name):
    """按标题名返回单个漫剧详情"""
    payload = query_series_detail_data(unquote(title_name))
    if not payload:
        return build_json_response(404, message=f"<{title_name}>漫剧不存在")
    return build_json_response(200, data=payload)


@flask_app.route("/", defaults={"path": ""})
@flask_app.route("/<path:path>")
def spa(path: str):
    """SPA兜底路由，非API请求统一交给前端入口页面"""
    if path.startswith("api/"):
        return build_json_response(404, message="404 Not Found!!!")
    return render_template("index.html")


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "4173"))
    flask_app.run(host=host, port=port, debug=True)
