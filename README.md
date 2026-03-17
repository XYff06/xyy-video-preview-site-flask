# Flask Video Preview Site

这是一个基于 Flask + PostgreSQL 的视频预览网站，UI 与交互按你提供的原项目结构迁移：

- 首页：标签筛选、搜索、排序、分页、海报卡片
- 详情页：视频播放器、10 个一页的选集切换
- 管理弹窗：标签管理、漫剧管理、内容管理
- 后端 API：兼容原项目的 `/api/tags`、`/api/titles`、`/api/episodes`、`/api/series` 等接口

## 目录结构

```text
flask_video_preview/
├─ app.py
├─ requirements.txt
├─ .env.example
├─ schema.sql
├─ templates/
│  └─ index.html
└─ static/
   ├─ app.js
   └─ styles.css
```

## 1. 安装依赖

```bash
pip install -r requirements.txt
```

## 2. 初始化 PostgreSQL

先创建数据库：

```sql
CREATE DATABASE video_preview WITH ENCODING = 'UTF8';
```

然后导入建表脚本：

```bash
psql -U postgres -d video_preview -f schema.sql
```

## 3. 配置环境变量

复制配置文件：

```bash
cp .env.example .env
```

Windows 可以直接新建 `.env`，内容参考 `.env.example`。

## 4. 启动项目

```bash
python app.py
```

启动后访问：

```text
http://127.0.0.1:4173
```

## 5. 接口说明

已实现以下接口：

- `GET /api/health`
- `GET /api/ingest-records`
- `GET /api/series`
- `GET /api/series/<title_name>`
- `GET /api/tags`
- `GET /api/titles`
- `POST /api/tags`
- `PATCH /api/tags/<tag_name>`
- `DELETE /api/tags/<tag_name>`
- `POST /api/titles`
- `PATCH /api/titles/<title_name>`
- `DELETE /api/titles/<title_name>`
- `POST /api/episodes`
- `PATCH /api/episodes`
- `DELETE /api/episodes`
- `POST /api/episodes/batch-directory`

## 6. 说明

这份 Flask 版本保留了你提供前端的 UI 和主要交互逻辑，因此页面样式与功能会非常接近原版。
