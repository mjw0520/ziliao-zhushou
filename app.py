# -*- coding: utf-8 -*-
"""资料助手 Web 服务：纯标准库 HTTP 服务器 + JSON API + 静态前端。

运行：python app.py [--port 8000] [--no-open]
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional, Tuple

import kb

# 打包成无控制台版（--windowed）时 stdout/stderr 为 None，重定向到空设备避免崩溃
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _app_dir() -> str:
    """程序目录：打包版用 exe 所在目录（可写，放 data/），源码版用本文件目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _static_dir() -> str:
    """前端页面目录：打包版从内置资源读取，源码版用 static/。"""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            return os.path.join(meipass, "static")
    return os.path.join(_app_dir(), "static")


BASE_DIR = _app_dir()
STATIC_DIR = _static_dir()
TMP_DIR = os.path.join(BASE_DIR, "data", "tmp")
os.chdir(BASE_DIR)
os.makedirs(TMP_DIR, exist_ok=True)

kb_instance: Optional[kb.KnowledgeBase] = None
_server = None  # 供 /api/shutdown 使用
_request_count = 0  # 用于判断浏览器是否已成功打开


def get_kb() -> kb.KnowledgeBase:
    global kb_instance
    if kb_instance is None:
        kb_instance = kb.KnowledgeBase(BASE_DIR)
    return kb_instance


# ---------------- 简易 multipart 解析 ----------------
def parse_multipart(body: bytes, content_type: str) -> List[Dict[str, object]]:
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type)
    boundary = (m.group(1) or m.group(2)).strip() if m else ""
    if not boundary:
        return []
    delim = b"--" + boundary.encode("utf-8")
    parts: List[Dict[str, object]] = []
    chunks = body.split(delim)
    for chunk in chunks:
        if not chunk or chunk in (b"--\r\n", b"--\n", b"\r\n", b"\n"):
            continue
        if chunk.startswith(b"--"):
            break
        # 头与内容以 \r\n\r\n 分隔
        if b"\r\n\r\n" in chunk:
            header_blob, data = chunk.split(b"\r\n\r\n", 1)
            sep = b"\r\n"
        else:
            header_blob, data = chunk.split(b"\n\n", 1)
            sep = b"\n"
        headers: Dict[str, str] = {}
        for line in header_blob.split(sep):
            line = line.decode("utf-8", errors="replace").strip()
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        data = data.rstrip(b"\r\n")
        name = ""
        filename = ""
        ct = headers.get("content-type", "")
        disp = headers.get("content-disposition", "")
        nm = re.search(r'name="([^"]*)"', disp)
        if nm:
            name = nm.group(1)
        fn = re.search(r'filename="([^"]*)"', disp)
        if fn:
            filename = fn.group(1)
        parts.append({"name": name, "filename": filename, "content_type": ct, "data": data})
    return parts


def save_upload(part: Dict[str, object], suffix: str = "") -> Optional[str]:
    """把上传的文件部分保存到 tmp，返回路径。"""
    fname = part.get("filename") or part.get("name")
    if not fname or not isinstance(part.get("data"), bytes) or not part["data"]:
        return None
    safe = os.path.basename(str(fname))
    path = os.path.join(TMP_DIR, safe + suffix)
    i = 1
    while os.path.exists(path):
        stem, ext = os.path.splitext(safe)
        path = os.path.join(TMP_DIR, "%s_%d%s%s" % (stem, i, ext, suffix))
        i += 1
    with open(path, "wb") as f:
        f.write(part["data"])
    return path


# ---------------- 请求处理 ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "KB/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 工具 ----
    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send_json(self, obj: object, code: int = 200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json_body(self) -> Optional[dict]:
        try:
            data = self._read_body()
            return json.loads(data.decode("utf-8")) if data else {}
        except Exception:
            return None

    def _send_file(self, path: str, download_name: Optional[str] = None):
        if not os.path.isfile(path):
            self._send_json({"ok": False, "error": "文件不存在"}, 404)
            return
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")  # 本地应用：始终加载最新前端
        if download_name:
            enc = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%s" % enc)
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    # ---- 路由 ----
    def _bump_request(self):
        global _request_count
        _request_count += 1

    def do_GET(self):
        self._bump_request()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._send_json({"ok": True, "time": kb.now_str(), "info": kb.get_python_info()})
            elif path == "/api/bid/company":
                self._send_json(get_kb().get_company_profile())
            elif path == "/api/check":
                self._send_json(env_check_result())
            elif path == "/api/stats":
                self._send_json(get_kb().stats())
            elif path == "/api/files":
                self._send_json({"ok": True, "files": get_kb().list_files()})
            elif path == "/api/search":
                q = (query.get("q") or [""])[0]
                limit = int((query.get("limit") or ["30"])[0])
                kind = (query.get("kind") or [""])[0] or None
                self._send_json({"ok": True, "q": q, "kind": kind,
                                 "results": get_kb().search(q, limit, kind)})
            elif path == "/api/tables":
                self._send_json({"ok": True, "tables": get_kb().list_tables()})
            elif path == "/api/tables/rows":
                fid = int((query.get("file_id") or ["0"])[0])
                sf = (query.get("sort_field") or [""])[0]
                sd = (query.get("sort_dir") or ["asc"])[0]
                ff = (query.get("filter_field") or [""])[0]
                fv = (query.get("filter_value") or [""])[0]
                limit = int((query.get("limit") or ["200"])[0])
                offset = int((query.get("offset") or ["0"])[0])
                self._send_json({"ok": True, **get_kb().sheet_rows(fid, sf, sd, ff, fv, limit, offset)})
            elif path == "/api/field-keys":
                self._send_json({"ok": True, "fields": get_kb().field_keys()})
            elif path == "/api/field-search":
                field = (query.get("field") or [""])[0]
                value = (query.get("value") or [""])[0]
                self._send_json({"ok": True, "results": get_kb().search_by_field(field, value)})
            elif path.startswith("/api/record/"):
                rest = path[len("/api/record/"):].rstrip("/")
                if rest.endswith("/pages"):
                    rid = rest[:len(rest) - len("/pages")]
                    if rid.isdigit():
                        self._send_json({"ok": True, "pages": get_kb().record_pages(int(rid))})
                    else:
                        self._send_json({"ok": False, "error": "无效记录"}, 400)
                elif rest.isdigit():
                    rec = get_kb().get_record(int(rest))
                    if rec:
                        self._send_json({"ok": True, "record": rec})
                    else:
                        self._send_json({"ok": False, "error": "记录不存在"}, 404)
                else:
                    self._send_json({"ok": False, "error": "无效请求"}, 400)
            elif path.startswith("/media/"):
                fid = path[len("/media/"):].strip()
                if fid.isdigit():
                    fp = get_kb().get_file_path(int(fid))
                    if fp:
                        self._send_file(fp)
                    else:
                        self._send_json({"ok": False, "error": "文件不存在"}, 404)
                else:
                    self._send_json({"ok": False, "error": "无效文件"}, 400)
            elif path.startswith("/download/"):
                fname = urllib.parse.unquote(os.path.basename(path[len("/download/"):]))
                self._send_file(os.path.join(get_kb().export_dir, fname), fname)
            else:
                self._serve_static(path)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        self._bump_request()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        ctype = self.headers.get("Content-Type", "")
        try:
            if path == "/api/files/upload":
                self._handle_upload()
            elif path == "/api/files/scan":
                self._send_json({"ok": True, **get_kb().scan_folder()})
            elif path == "/api/files/delete":
                body = self._read_json_body()
                fid = int((body or {}).get("file_id") or 0)
                self._send_json(get_kb().delete_file(fid))
            elif path == "/api/files/reparse":
                body = self._read_json_body()
                fid = int((body or {}).get("file_id") or 0)
                self._send_json(get_kb().reparse_file(fid))
            elif path == "/api/export/selected":
                body = self._read_json_body() or {}
                ids = [int(x) for x in (body.get("record_ids") or [])]
                scores = {}
                for k, v in (body.get("scores") or {}).items():
                    try:
                        scores[int(k)] = float(v)
                    except Exception:
                        pass
                out = get_kb().export_selected(ids, scores)
                self._send_json({"ok": True, "download": "/download/" + os.path.basename(out)})
            elif path == "/api/shutdown":
                self._send_json({"ok": True, "msg": "程序即将关闭"})
                self._do_shutdown()
            elif path == "/api/bid/company":
                body = self._read_json_body() or {}
                self._send_json(get_kb().save_company_profile(body.get("fields") or {}))
            elif path == "/api/bid/parse":
                self._handle_bid_parse()
            elif path == "/api/bid/generate":
                self._handle_bid_generate()
            elif path == "/api/deps/install":
                self._send_json(install_missing_deps())
            elif path == "/api/paste/preview":
                self._handle_paste_preview()
            elif path == "/api/paste/apply":
                self._handle_paste_apply()
            elif path == "/api/template/columns":
                self._handle_template_columns()
            elif path == "/api/fill/preview":
                self._handle_fill_preview()
            elif path == "/api/fill/apply":
                self._handle_fill_apply()
            else:
                self._send_json({"ok": False, "error": "未知接口"}, 404)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _do_shutdown(self):
        """延迟关闭服务器（先把响应发出去），供网页“退出程序”按钮调用。"""
        global _server
        srv = _server
        if srv is None:
            return

        def _stop():
            time.sleep(0.5)
            try:
                srv.shutdown()
            except Exception:
                pass

        threading.Thread(target=_stop, daemon=True).start()

    def _serve_static(self, path: str):
        rel = path.lstrip("/")
        if not rel or rel.endswith("/"):
            rel = "index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        self._send_file(full)

    # ---- 业务处理 ----
    def _handle_upload(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        k = get_kb()
        file_parts = [p for p in parts if p.get("filename")]
        fields = {}
        for p in parts:
            if not p.get("filename"):
                try:
                    fields[p.get("name") or ""] = (p.get("data") or b"").decode("utf-8", "replace")
                except Exception:
                    fields[p.get("name") or ""] = ""
        folders = []
        try:
            _f = json.loads(fields.get("folders", "") or "[]")
            if isinstance(_f, list):
                folders = _f
        except Exception:
            folders = []
        results = []
        for i, p in enumerate(file_parts):
            if not p.get("data"):
                continue
            tmp = save_upload(p)
            if not tmp:
                continue
            rel_dir = ""
            if i < len(folders) and folders[i]:
                rel_dir = str(folders[i])
            try:
                res = k.import_file(tmp, rel_dir)
                results.append({"name": res.get("name", ""), "ok": res.get("ok", False),
                                "skipped": res.get("skipped", False),
                                "replaced": bool(res.get("replaced")),
                                "replaced_files": res.get("replaced_files", 0),
                                "records": res.get("records", 0), "error": res.get("error", "")})
            finally:
                try:
                    os.remove(tmp)
                except Exception:
                    pass
        self._send_json({"ok": True, "results": results})

    def _handle_paste_preview(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        fields = {p["name"]: p["data"].decode("utf-8", errors="replace") for p in parts if not p.get("filename")}
        file_parts = [p for p in parts if p.get("filename")]
        if len(file_parts) < 2:
            self._send_json({"ok": False, "error": "请同时上传源表格和目标表格"}, 400)
            return
        src = save_upload(file_parts[0])
        tgt = save_upload(file_parts[1])
        if not src or not tgt:
            self._send_json({"ok": False, "error": "表格读取失败"}, 400)
            return
        try:
            mode = fields.get("mode") or "match"
            src_key = (fields.get("src_key") or "").strip()
            tgt_key = (fields.get("tgt_key") or "").strip()
            try:
                top_k = int(fields.get("top_k") or "3")
            except Exception:
                top_k = 3
            res = get_kb().paste_preview(src, tgt, src_key, tgt_key, top_k, mode)
            self._send_json(res)
        finally:
            for t in (src, tgt):
                try:
                    os.remove(t)
                except Exception:
                    pass

    def _handle_paste_apply(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        fields = {p["name"]: p["data"].decode("utf-8", errors="replace") for p in parts if not p.get("filename")}
        file_parts = [p for p in parts if p.get("filename")]
        if len(file_parts) < 2:
            self._send_json({"ok": False, "error": "请同时上传源表格和目标表格"}, 400)
            return
        src = save_upload(file_parts[0])
        tgt = save_upload(file_parts[1])
        if not src or not tgt:
            self._send_json({"ok": False, "error": "表格读取失败"}, 400)
            return
        try:
            mode = fields.get("mode") or "match"
            src_key = (fields.get("src_key") or "").strip()
            tgt_key = (fields.get("tgt_key") or "").strip()
            overwrite = (fields.get("overwrite") or "0") == "1"
            append_unmatched = (fields.get("append_unmatched") or "1") == "1"
            try:
                choices = json.loads(fields.get("choices") or "{}")
                mapping = json.loads(fields.get("mapping") or "{}")
            except Exception:
                self._send_json({"ok": False, "error": "参数解析失败"}, 400)
                return
            clean_choices = {}
            for k, v in choices.items():
                try:
                    clean_choices[int(k)] = int(v) if v not in (None, "", "null") else None
                except Exception:
                    pass
            out = get_kb().paste_apply(src, tgt, mode, clean_choices, mapping,
                                       src_key, tgt_key, overwrite, append_unmatched)
            self._send_json({"ok": True, "download": "/download/" + os.path.basename(out)})
        finally:
            for t in (src, tgt):
                try:
                    os.remove(t)
                except Exception:
                    pass


    def _handle_bid_parse(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        file_part = next((p for p in parts if p.get("filename")), None)
        if not file_part:
            self._send_json({"ok": False, "error": "请上传标书模板(.docx)"}, 400)
            return
        tmp = save_upload(file_part)
        if not tmp:
            self._send_json({"ok": False, "error": "模板读取失败"}, 400)
            return
        try:
            res = get_kb().parse_bid_template(tmp)
            self._send_json(res)
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass

    def _handle_bid_generate(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        fields = {p["name"]: p["data"].decode("utf-8", errors="replace") for p in parts if not p.get("filename")}
        file_part = next((p for p in parts if p.get("filename")), None)
        if not file_part:
            self._send_json({"ok": False, "error": "请上传标书模板(.docx)"}, 400)
            return
        tmp = save_upload(file_part)
        if not tmp:
            self._send_json({"ok": False, "error": "模板读取失败"}, 400)
            return
        try:
            try:
                choices = json.loads(fields.get("choices") or "{}")
                project = json.loads(fields.get("project") or "{}")
            except Exception:
                self._send_json({"ok": False, "error": "参数解析失败"}, 400)
                return
            out = get_kb().generate_bid(tmp, choices, project)
            self._send_json({"ok": True, "download": "/download/" + os.path.basename(out)})
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass

    def _handle_template_columns(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        file_part = next((p for p in parts if p.get("filename")), None)
        if not file_part:
            self._send_json({"ok": False, "error": "请上传模板表格"}, 400)
            return
        tmp = save_upload(file_part)
        if not tmp:
            self._send_json({"ok": False, "error": "模板读取失败"}, 400)
            return
        try:
            tmpl = kb.read_template(tmp)
            if not tmpl.get("ok"):
                self._send_json(tmpl, 400)
                return
            self._send_json({"ok": True, "columns": tmpl["columns"], "rows": len(tmpl["rows"])})
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass
    def _handle_fill_preview(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        fields = {p["name"]: p["data"].decode("utf-8", errors="replace") for p in parts if not p.get("filename")}
        file_part = next((p for p in parts if p.get("filename")), None)
        if not file_part:
            self._send_json({"ok": False, "error": "请上传模板表格"}, 400)
            return
        tmp = save_upload(file_part)
        if not tmp:
            self._send_json({"ok": False, "error": "模板读取失败"}, 400)
            return
        try:
            title_col = (fields.get("title_col") or "").strip()
            try:
                top_k = int(fields.get("top_k") or "3")
            except Exception:
                top_k = 3
            k = get_kb()
            tmpl = kb.read_template(tmp)
            if not tmpl.get("ok"):
                self._send_json(tmpl, 400)
                return
            cols = tmpl["columns"]
            if not title_col or title_col not in cols:
                title_col = cols[0]
            # 每条模板行的候选
            rows_out = []
            for i, row in enumerate(tmpl["rows"]):
                q = row.get(title_col, "")
                cands = k.match_title(q, top_k=top_k)
                rows_out.append({"index": i, "title": q, "candidates": cands})
            mapping = k.suggest_mapping(cols, title_col)
            self._send_json({"ok": True, "columns": cols, "title_col": title_col,
                             "rows": rows_out, "mapping": mapping,
                             "kb_fields": k._field_keys()})
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass

    def _handle_fill_apply(self):
        body = self._read_body()
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        fields = {p["name"]: p["data"].decode("utf-8", errors="replace") for p in parts if not p.get("filename")}
        file_part = next((p for p in parts if p.get("filename")), None)
        if not file_part:
            self._send_json({"ok": False, "error": "请上传模板表格"}, 400)
            return
        tmp = save_upload(file_part)
        if not tmp:
            self._send_json({"ok": False, "error": "模板读取失败"}, 400)
            return
        try:
            try:
                choices = json.loads(fields.get("choices") or "{}")
                mapping = json.loads(fields.get("mapping") or "{}")
                scores = json.loads(fields.get("scores") or "{}")
            except Exception:
                self._send_json({"ok": False, "error": "参数解析失败"}, 400)
                return
            title_col = fields.get("title_col") or ""
            clean_choices: Dict[int, Optional[int]] = {}
            for idx_str, rid in choices.items():
                try:
                    idx = int(idx_str)
                except Exception:
                    continue
                clean_choices[idx] = int(rid) if rid not in (None, "", "null") else None
            k = get_kb()
            clean_scores = {}
            for idx_str, s in scores.items():
                try:
                    clean_scores[int(idx_str)] = float(s)
                except Exception:
                    pass
            out = k.export_filled(tmp, clean_choices, mapping, title_col, clean_scores)
            self._send_json({"ok": True, "download": "/download/" + os.path.basename(out)})
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass


# ---------------- 环境检查 ----------------
def env_check_result() -> Dict[str, object]:
    missing = kb.check_environment()
    return {
        "ok": len(missing) == 0,
        "missing": missing,
        "python": kb.get_python_info()["python"],
        "python_path": sys.executable,
        "install_command": kb.INSTALL_COMMAND,
    }


def install_missing_deps() -> Dict[str, object]:
    if getattr(sys, "frozen", False):
        return {"ok": True, "already": True,
                "output": "这是打包版，解析组件已内置，无需安装。"}
    missing = kb.check_environment()
    if not missing:
        return {"ok": True, "already": True, "output": "所有解析组件都已就绪，无需安装。"}
    pkgs = [m["pip"] for m in missing]
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"] + pkgs
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=600)
        out = proc.stdout.decode("utf-8", errors="replace")
        err = proc.stderr.decode("utf-8", errors="replace")
        tail = (out + err)[-2000:]
        return {
            "ok": proc.returncode == 0,
            "installed": pkgs if proc.returncode == 0 else [],
            "failed": [] if proc.returncode == 0 else pkgs,
            "output_tail": tail,
        }
    except Exception as e:
        return {"ok": False, "installed": [], "failed": pkgs, "output_tail": str(e)}


def _ask_yes_no(text: str, title: str) -> bool:
    """弹出“是/否”对话框；用户点“是”返回 True。非 Windows 或出错返回 False。"""
    if os.name != "nt":
        return False
    try:
        import ctypes
        ret = ctypes.windll.user32.MessageBoxW(
            0, text, title,
            0x04 | 0x20 | 0x100)  # MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2
        return ret == 6  # IDYES
    except Exception:
        return False


def show_env_popup(missing: List[Dict[str, object]]) -> None:
    """弹对话框让使用者自己选择：现在安装，还是暂不安装。"""
    text = (kb.build_env_message(missing)
            + "\n\n是否现在打开安装脚本（install_deps.bat）进行安装？\n"
              "选择“是”会弹出安装窗口（需要联网）；选择“否”则继续启动，"
              "基础功能（txt / csv）仍可使用。")
    if _ask_yes_no(text, "资料助手 - 缺少解析组件"):
        _launch_installer()


def _launch_installer() -> None:
    """在独立窗口里打开 install_deps.bat，让用户看到安装进度。"""
    bat = os.path.join(BASE_DIR, "install_deps.bat")
    if not os.path.isfile(bat):
        return
    try:
        os.startfile(bat)  # 默认方式打开，会弹出一个新的命令行窗口
    except Exception:
        try:
            subprocess.Popen(["cmd", "/c", "start", "", "install_deps.bat"],
                             cwd=BASE_DIR,
                             creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))
        except Exception:
            pass

def _fatal_error(msg: str) -> None:
    """启动失败时：有控制台则打印，打包版（无控制台）弹系统提示框。"""
    try:
        print(msg)
    except Exception:
        pass
    if getattr(sys, "frozen", False) and os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "资料助手 - 启动失败", 0x10)
        except Exception:
            pass

def _open_browser(port: int) -> None:
    """自动打开浏览器；若一段时间内没有任何请求（浏览器没打开），弹窗提示网址。"""
    url = "http://127.0.0.1:%d" % port
    try:
        webbrowser.open(url)
    except Exception:
        pass
    time.sleep(8)
    global _request_count
    if _request_count == 0 and getattr(sys, "frozen", False) and os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0,
                "浏览器未能自动打开。\n\n请在浏览器地址栏手动输入：\n%s" % url,
                "资料助手", 0x40)  # MB_ICONINFORMATION
        except Exception:
            pass

def main():
    import argparse
    parser = argparse.ArgumentParser(description="资料助手")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--no-popup", action="store_true", help="不弹出系统提示框")
    args = parser.parse_args()

    info = kb.get_python_info()
    # 环境检查：缺失组件时控制台提示 + 弹窗
    missing = kb.check_environment()
    if missing:
        print("")
        print("=" * 58)
        print("  [警告] 本机缺少以下解析组件：")
        for m in missing:
            print("    - %s  (需要安装 %s)" % (m["label"], m["pip"]))
        print("  已弹出对话框，可选择立即安装或暂不安装。")
        print("  手动安装：双击 install_deps.bat，或运行：")
        print("    " + kb.INSTALL_COMMAND)
        print("=" * 58)
        if not args.no_popup:
            threading.Thread(target=show_env_popup, args=(missing,), daemon=True).start()
    # 首次启动：如果库里还没有文件，自动扫描 data/files
    k = get_kb()
    if k.stats()["files"] == 0:
        res = k.scan_folder()
        if res.get("added"):
            print("  已自动导入 %d 个文件" % len(res["added"]))
    print("=" * 58)
    print("  资料助手已启动")
    print("  地址:  http://127.0.0.1:%d" % args.port)
    print("  Python: %s | pandas:%s openpyxl:%s pdfplumber:%s docx:%s pptx:%s pillow:%s" % (
        info["python"], info["pandas"], info["openpyxl"], info["pdfplumber"],
        info["docx"], info["pptx"], info["pillow"]))
    print("  提示: 按 Ctrl+C 停止")
    print("=" * 58)

    global _server
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        _server = server
    except Exception as e:
        _fatal_error("端口 %d 无法启动：%s\n\n请关闭占用该端口的程序后重试。" % (args.port, e))
        return
    if not args.no_open:
        threading.Thread(target=_open_browser, args=(args.port,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        if kb_instance:
            kb_instance.close()


if __name__ == "__main__":
    main()
