/* 资料助手前端逻辑 */
"use strict";

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, type = "ok", ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function kindLabel(kind) {
  const map = { sheet: "表格", pdf: "PDF", doc: "文档", text: "文本", image: "图片", slide: "演示", other: "其他" };
  return map[kind] || kind;
}

async function api(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || (data && data.ok === false && data.error)) {
    throw new Error((data && data.error) || ("请求失败 " + res.status));
  }
  return data;
}

function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- 顶栏 & 标签页 ---------- */
async function loadStats() {
  try {
    const s = await api("/api/stats");
    $("#stats").textContent = "📄 " + s.files + " 个文件 · 🧾 " + s.records + " 条记录";
  } catch (e) { $("#stats").textContent = "—"; }
}

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
  });
});

/* ---------- 搜索 ---------- */
const state = { selected: new Map(), q: "" }; // record_id -> record; q = 当前搜索词

function renderResults(results) {
  const box = $("#results");
  if (!results.length) {
    box.innerHTML = '<div class="empty-tip"><p>😕 没有找到相关结果，换个关键词试试</p></div>';
    return;
  }
  box.innerHTML = "";
  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "result-card";
    const scoreCls = r.score >= 60 ? "" : "low";
    const fieldsHtml = Object.entries(r.fields || {}).slice(0, 8)
      .map(([k, v]) => `<span class="tag"><b>${esc(k)}</b>：${esc(v)}</span>`).join("");
    const picked = state.selected.has(r.id);
    card.innerHTML = `
      <div class="result-head">
        <span class="result-title">${esc(r.title || "(无标题)")}</span>
        <span class="score ${scoreCls}">${r.score}分</span>
      </div>
      <div class="result-meta">
        <span>📁 ${esc(r.file_name || "")}</span>
        <span>${kindLabel(r.file_kind || "")}</span>
        ${r.type ? `<span>${esc(r.type)}</span>` : ""}
        ${r.page ? `<span>第${r.page}页</span>` : ""}
        ${r.row ? `<span>第${r.row}行</span>` : ""}
      </div>
      ${r.snippet ? `<div class="result-snippet">${r.snippet}</div>` : ""}
      ${fieldsHtml ? `<div class="fields-tags">${fieldsHtml}</div>` : ""}
      <div class="result-actions">
        <button class="small ghost btn-read">📖 阅读</button>
        <button class="small btn-pick ${picked ? "btn-picked" : ""}" data-id="${r.id}">
          ${picked ? "✓ 已选择" : "＋ 选择"}
        </button>
      </div>`;
    card.querySelector(".btn-pick").addEventListener("click", () => toggleSelect(r));
    card.querySelector(".btn-read").addEventListener("click", () => openReading(r, state.q || ""));
    box.appendChild(card);
  });
}

function toggleSelect(r) {
  if (state.selected.has(r.id)) {
    state.selected.delete(r.id);
    toast("已取消选择", "ok", 1200);
  } else {
    state.selected.set(r.id, r);
    toast("已加入选择列表", "ok", 1200);
  }
  renderSelected();
  // 刷新卡片按钮状态
  const btn = document.querySelector(`.btn-pick[data-id="${r.id}"]`);
  if (btn) {
    btn.classList.toggle("btn-picked", state.selected.has(r.id));
    btn.textContent = state.selected.has(r.id) ? "✓ 已选择" : "＋ 选择";
  }
}

function renderSelected() {
  const list = $("#selected-list");
  $("#sel-count").textContent = state.selected.size;
  if (!state.selected.size) {
    list.innerHTML = '<p class="dim">搜索后点「选择」把记录加入这里，可复制或导出。</p>';
    return;
  }
  list.innerHTML = "";
  state.selected.forEach((r) => {
    const item = document.createElement("div");
    item.className = "sel-item";
    item.innerHTML = `<span class="t">${esc(r.title || "(无标题)")}</span><span class="x" title="移除">✕</span>`;
    item.querySelector(".x").addEventListener("click", (e) => {
      e.stopPropagation();
      state.selected.delete(r.id);
      renderSelected();
      const btn = document.querySelector(`.btn-pick[data-id="${r.id}"]`);
      if (btn) { btn.classList.remove("btn-picked"); btn.textContent = "＋ 选择"; }
    });
    item.addEventListener("click", () => showRecordModal(r));
    list.appendChild(item);
  });
}

/* ---------- 阅读模式 ---------- */
const reader = { q: "", pages: [], idx: -1 };

function escRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightAll(text, q) {
  let out = esc(text);
  if (!q || !String(q).trim()) return out;
  const terms = String(q).trim().split(/[\s,，。;；、]+/).filter(Boolean).slice(0, 8);
  for (const t of terms) {
    const et = esc(t);
    if (!et) continue;
    try { out = out.replace(new RegExp(escRegex(et), "gi"), "<mark>$&</mark>"); } catch (e) { /* ignore */ }
  }
  return out;
}

function scrollToMatch(dir) {
  const marks = $$("#modal-body .reading-content mark");
  const info = $("#rd-find-info");
  if (!marks.length) { if (info) info.textContent = "无匹配"; return; }
  reader.idx = dir > 0 ? (reader.idx + 1) % marks.length : (reader.idx - 1 + marks.length) % marks.length;
  marks[reader.idx].scrollIntoView({ block: "center", behavior: "smooth" });
  if (info) info.textContent = (reader.idx + 1) + " / " + marks.length + " 处";
}

function renderReadingContent(rec) {
  const body = $("#modal-body");
  const parts = ['<p class="dim">📁 ' + esc(rec.file_name || "") +
    (rec.page ? " · 第" + rec.page + "页" : "") +
    (rec.row_no ? " · 第" + rec.row_no + "行" : "") + "</p>"];
  if (reader.pages.length > 1) {
    const cur = reader.pages.findIndex((p) => p.id === rec.id);
    parts.push('<div class="reading-nav">' +
      '<button class="small" id="rd-prev"' + (cur <= 0 ? " disabled" : "") + ">← 上一页</button>" +
      '<span class="dim">' + (rec.page || "") + " / " + reader.pages.length + " 页</span>" +
      '<button class="small" id="rd-next"' + (cur < 0 || cur >= reader.pages.length - 1 ? " disabled" : "") + ">下一页 →</button>" +
      "</div>");
  }
  parts.push('<div class="reading-nav">' +
    '<button class="small" id="rd-find-prev">▲ 上一个</button>' +
    '<span class="dim" id="rd-find-info"></span>' +
    '<button class="small" id="rd-find-next">▼ 下一个</button>' +
    "</div>");
  parts.push('<div class="reading-content">' + highlightAll(rec.content || "(无正文)", reader.q) + "</div>");
  const fields = Object.entries(rec.fields || {}).map(([k, v]) => esc(k) + "：" + esc(v)).join("\n");
  if (fields) parts.push("<p><b>字段：</b></p><pre>" + esc(fields) + "</pre>");
  body.innerHTML = parts.join("");
  reader.idx = -1;
  const info = $("#rd-find-info");
  if (info) info.textContent = $$("#modal-body .reading-content mark").length ? "共 " + $$("#modal-body .reading-content mark").length + " 处" : "";
  const cur = reader.pages.findIndex((p) => p.id === rec.id);
  const pv = $("#rd-prev"), nx = $("#rd-next");
  if (pv) pv.onclick = () => { if (cur > 0) loadReadingPage(reader.pages[cur - 1].id); };
  if (nx) nx.onclick = () => { if (cur >= 0 && cur < reader.pages.length - 1) loadReadingPage(reader.pages[cur + 1].id); };
  const fp = $("#rd-find-prev"), fn = $("#rd-find-next");
  if (fp) fp.onclick = () => scrollToMatch(-1);
  if (fn) fn.onclick = () => scrollToMatch(1);
}

async function loadReadingPage(recordId) {
  try {
    const d = await api("/api/record/" + recordId);
    $("#modal-title").textContent = (d.record && d.record.title) || "(无标题)";
    renderReadingContent(d.record || {});
  } catch (e) { toast("读取失败：" + e.message, "err"); }
}

async function openReading(r, query) {
  reader.q = query || "";
  reader.pages = [];
  reader.idx = -1;
  $("#modal-title").textContent = r.title || "(无标题)";
  const box = document.querySelector(".modal-box");
  if (box) box.classList.add("reading");
  const kind = r.file_kind || r.type;
  if (kind === "image") {
    $("#modal-body").innerHTML = '<p class="dim">📁 ' + esc(r.file_name || "") + '</p><div class="reading-img"><img src="/media/' + r.file_id + '"></div>';
    $("#modal").classList.remove("hidden");
    return;
  }
  if (kind === "pdf" || kind === "slide") {
    try {
      const d = await api("/api/record/" + r.id + "/pages");
      reader.pages = d.pages || [];
    } catch (e) { reader.pages = []; }
  }
  let rec = { id: r.id, title: r.title, content: r.content, fields: r.fields || {},
              page: r.page, row_no: r.row, file_name: r.file_name, file_kind: kind };
  if (!rec.content) {
    try {
      const d = await api("/api/record/" + r.id);
      if (d.record) rec = d.record;
    } catch (e) { /* ignore */ }
  }
  renderReadingContent(rec);
  $("#modal").classList.remove("hidden");
}

function showRecordModal(r) {
  openReading(r, state.q || "");
}

async function doSearch() {
  const q = $("#search-input").value.trim();
  if (!q) {
    toast("请输入搜索关键词", "err", 1500);
    return;
  }
  state.q = q;
  $("#results").innerHTML = '<div class="empty-tip"><p>搜索中…</p></div>';
  try {
    const kind = $("#search-kind").value || "";
    const data = await api("/api/search?q=" + encodeURIComponent(q) + "&limit=30&kind=" + encodeURIComponent(kind));
    renderResults(data.results || []);
  } catch (e) {
    toast("搜索失败：" + e.message, "err");
    $("#results").innerHTML = '<div class="empty-tip"><p>😕 搜索失败</p></div>';
  }
}

function copySelected() {
  if (!state.selected.size) { toast("还没有选择任何记录", "err"); return; }
  const lines = [];
  state.selected.forEach((r) => {
    lines.push("【" + (r.title || "") + "】 来源：" + (r.file_name || "") +
      (r.page ? " 第" + r.page + "页" : "") + (r.row ? " 第" + r.row + "行" : ""));
    Object.entries(r.fields || {}).forEach(([k, v]) => lines.push(k + "：" + v));
    if (r.content) lines.push(r.content.slice(0, 300));
    lines.push("");
  });
  const text = lines.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("已复制 " + state.selected.size + " 条记录"))
      .catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败", "err"); }
  ta.remove();
}

async function exportSelected() {
  if (!state.selected.size) { toast("还没有选择任何记录", "err"); return; }
  try {
    const scores = {};
    state.selected.forEach((r, id) => { scores[id] = r.score || ""; });
    const data = await api("/api/export/selected", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record_ids: Array.from(state.selected.keys()), scores })
    });
    triggerDownload(data.download);
    toast("已导出 Excel");
  } catch (e) { toast("导出失败：" + e.message, "err"); }
}

/* ---------- 事件绑定：搜索 ---------- */
$("#search-btn").addEventListener("click", doSearch);
$("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) doSearch(); });
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  $("#search-kind").value = "";
  state.q = "";
  state.selected.clear();
  renderSelected();
  $("#results").innerHTML = '<div class="empty-tip"><p>🔍 在上方输入关键词开始搜索</p><p class="dim">支持中文/英文/数字，标题和正文都会检索；可搜索 Excel 每一行、PDF 每一页、Word/PPT/图片(文件名)。</p></div>';
});
$("#copy-selected").addEventListener("click", copySelected);
$("#export-selected").addEventListener("click", exportSelected);
$("#clear-selected").addEventListener("click", () => { state.selected.clear(); renderSelected(); });
$("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").classList.add("hidden"); });
/* ---------- 表格工作台 ---------- */
const wb = { tables: [], cur: null, sortField: "", sortDir: "asc", filterField: "", filterValue: "" };

function switchTab(name) {
  const btn = document.querySelector('.tab[data-tab="' + name + '"]');
  if (btn) btn.click();
}

async function loadFieldKeys() {
  try {
    const d = await api("/api/field-keys");
    const sel = $("#wb-field");
    const cur = sel.value;
    sel.innerHTML = "<option value=''>（选择字段）</option>" +
      (d.fields || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    if (cur) sel.value = cur;
  } catch (e) {
    $("#wb-field").innerHTML = "<option value=''>字段加载失败</option>";
  }
}

async function loadTables() {
  try {
    const d = await api("/api/tables");
    wb.tables = d.tables || [];
    renderWbTables();
  } catch (e) {
    $("#wb-tables").innerHTML = '<p class="dim">表格列表加载失败：' + esc(e.message) + "</p>";
  }
}

function renderWbTables() {
  const box = $("#wb-tables");
  if (!wb.tables.length) {
    box.innerHTML = '<p class="dim">暂无表格（先把 xlsx/xls/csv 导入文档库）</p>';
    return;
  }
  box.innerHTML = "";
  wb.tables.forEach((t) => {
    const item = document.createElement("div");
    item.className = "wb-table-item" + (wb.cur && wb.cur.file_id === t.file_id ? " active" : "");
    const cols = (t.columns || []).map(esc);
    item.innerHTML = '<div class="wb-table-name">' + esc(t.name) + "</div>" +
      '<div class="dim">' + t.records + " 行 · " +
      (cols.length ? cols.slice(0, 6).join("、") + (cols.length > 6 ? "…" : "") : "无列") + "</div>";
    item.addEventListener("click", () => {
      wb.cur = t;
      wb.sortField = ""; wb.sortDir = "asc"; wb.filterField = ""; wb.filterValue = "";
      renderWbTables();
      populateWbFilter();
      loadWbRows();
    });
    box.appendChild(item);
  });
}

function populateWbFilter() {
  const cols = (wb.cur && wb.cur.columns) || [];
  $("#wb-filter-field").innerHTML = "<option value=''>（全部）</option>" +
    cols.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("#wb-filter-field").value = wb.filterField || "";
  $("#wb-filter-value").value = wb.filterValue || "";
}

async function loadWbRows() {
  if (!wb.cur) return;
  $("#wb-rows-title").textContent = "正在加载「" + wb.cur.name + "」…";
  const params = new URLSearchParams({
    file_id: wb.cur.file_id, sort_field: wb.sortField, sort_dir: wb.sortDir,
    filter_field: wb.filterField, filter_value: wb.filterValue
  });
  try {
    const d = await api("/api/tables/rows?" + params.toString());
    renderWbRows(wb.cur.columns || [], d.rows || [], d.total || 0);
    $("#wb-rows-title").textContent = wb.cur.name + " · 共 " + (d.total || 0) + " 行";
  } catch (e) {
    $("#wb-rows-title").textContent = "加载失败：" + e.message;
    $("#wb-rows-body").innerHTML = '<tr><td class="dim">加载失败</td></tr>';
  }
}

function renderWbRows(cols, rows, total) {
  const head = $("#wb-rows-head");
  const body = $("#wb-rows-body");
  if (!cols.length) {
    head.innerHTML = "";
    body.innerHTML = '<tr><td class="dim">该表没有识别到列</td></tr>';
    return;
  }
  head.innerHTML = "<tr><th class='wb-rowno'>#</th>" + cols.map((c) => {
    const arrow = wb.sortField === c ? (wb.sortDir === "asc" ? " ▲" : " ▼") : "";
    return '<th data-col="' + esc(c) + '" title="点击排序">' + esc(c) + arrow + "</th>";
  }).join("") + "</tr>";
  $$("#wb-rows-head th[data-col]").forEach((th) => {
    th.addEventListener("click", () => {
      const c = th.dataset.col;
      if (wb.sortField === c) wb.sortDir = wb.sortDir === "asc" ? "desc" : "asc";
      else { wb.sortField = c; wb.sortDir = "asc"; }
      loadWbRows();
    });
  });
  body.innerHTML = "";
  if (!rows.length) {
    body.innerHTML = '<tr><td class="dim" colspan="' + (cols.length + 1) + '">无数据</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const cells = cols.map((c) => "<td>" + esc(r.fields && r.fields[c] != null ? r.fields[c] : "") + "</td>").join("");
    body.insertAdjacentHTML("beforeend", '<tr><td class="dim">' + (r.row || "") + "</td>" + cells + "</tr>");
  });
}

async function doWbFieldSearch() {
  const field = $("#wb-field").value;
  const value = $("#wb-value").value.trim();
  if (!field) { toast("请先选择字段", "err"); return; }
  if (!value) { toast("请输入字段值", "err"); return; }
  $("#wb-field-result").textContent = "筛选中…";
  try {
    const d = await api("/api/field-search?field=" + encodeURIComponent(field) + "&value=" + encodeURIComponent(value));
    const res = d.results || [];
    if (!res.length) {
      $("#wb-field-result").innerHTML = "<p>未找到字段「" + esc(field) + "」包含「" + esc(value) + "」的行</p>";
      return;
    }
    $("#wb-field-result").innerHTML = "<p>找到 " + res.length + " 行：</p><div class='wb-field-hits'>" +
      res.map((r) => '<div class="wb-field-hit"><b>' + esc(r.title || "(无标题)") + "</b>　" +
        '<span class="dim">' + esc(r.file_name || "") + "</span><br>" +
        '<span class="dim">' + esc(field) + " = " + esc(r.match_value) + "</span></div>").join("") +
      "</div>";
  } catch (e) {
    $("#wb-field-result").textContent = "筛选失败：" + e.message;
  }
}

$("#wb-field-search").addEventListener("click", doWbFieldSearch);
$("#wb-value").addEventListener("keydown", (e) => { if (e.key === "Enter") doWbFieldSearch(); });
$("#wb-filter-apply").addEventListener("click", () => {
  wb.filterField = $("#wb-filter-field").value;
  wb.filterValue = $("#wb-filter-value").value.trim();
  loadWbRows();
});
$("#wb-filter-clear").addEventListener("click", () => {
  wb.filterField = ""; wb.filterValue = "";
  populateWbFilter();
  loadWbRows();
});
$("#wb-goto-fill").addEventListener("click", () => switchTab("fill"));
$("#wb-goto-paste").addEventListener("click", () => switchTab("paste"));

/* ---------- 表格填写 ---------- */
const fill = { file: null, columns: [], titleCol: "", rows: [], mapping: {}, kbFields: [] };

/* 遍历拖入的 items：支持文件夹（递归收集文件及其相对路径）。 */
async function collectDropped(dt) {
  const out = [];
  if (dt && dt.items && dt.items.length) {
    const entries = [];
    for (const it of dt.items) {
      let e = null;
      try { e = it.webkitGetAsEntry ? it.webkitGetAsEntry() : (it.getAsEntry ? it.getAsEntry() : null); } catch (err) { e = null; }
      if (e) entries.push(e);
    }
    if (entries.length) {
      const walk = (entry, rel) => new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((f) => { out.push({ file: f, relPath: rel }); resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
          const childRel = rel ? rel + "/" + entry.name : entry.name;
          const reader = entry.createReader();
          const batch = () => {
            reader.readEntries((items) => {
              if (!items.length) { resolve(); return; }
              Promise.all(items.map((e) => walk(e, childRel))).then(batch);
            }, () => resolve());
          };
          batch();
        } else { resolve(); }
      });
      await Promise.all(entries.map((e) => walk(e, "")));
      return out;
    }
  }
  // 回退：不支持目录遍历的浏览器，按普通文件处理
  for (const f of Array.from((dt && dt.files) || [])) {
    out.push({ file: f, relPath: "" });
  }
  return out;
}

function setupDropzone(zoneId, inputId, onFiles, opts = {}) {
  const zone = $(zoneId), input = $(inputId);
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (!input.files.length) return;
    if (opts.allowDirs) onFiles(Array.from(input.files).map((f) => ({ file: f, relPath: "" })));
    else onFiles(Array.from(input.files));
  });
  ["dragover", "dragenter"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove("over");
  }));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (opts.allowDirs) {
      const items = await collectDropped(e.dataTransfer);
      if (items.length) onFiles(items);
      return;
    }
    if (e.dataTransfer && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
  });
}

setupDropzone("#fill-drop", "#fill-file", async (files) => {
  const f = files[0];
  if (!/\.(xlsx|xlsm|xls|csv)$/i.test(f.name)) { toast("只支持 .xlsx / .xls / .csv", "err"); return; }
  fill.file = f;
  const info = $("#fill-file-info");
  info.classList.remove("hidden");
  info.textContent = "📄 " + f.name + "（" + fmtSize(f.size) + "）";
  $("#fill-step2").classList.add("hidden");
  // 读取模板列名，填充“匹配列”下拉
  const fd = new FormData();
  fd.append("template", f);
  const sel = $("#fill-title-col");
  sel.innerHTML = "<option value=' >读取中…</option>";
  try {
    const data = await api("/api/template/columns", { method: "POST", body: fd });
    sel.innerHTML = data.columns.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  } catch (e) {
    sel.innerHTML = "";
    toast("读取模板列失败：" + e.message, "err");
  }
});

$("#fill-match-btn").addEventListener("click", async () => {
  if (!fill.file) { toast("请先上传模板表格", "err"); return; }
  const fd = new FormData();
  fd.append("template", fill.file);
  fd.append("title_col", $("#fill-title-col").value || "");
  fd.append("top_k", $("#fill-topk").value || "3");
  const btn = $("#fill-match-btn");
  btn.disabled = true; btn.textContent = "匹配中…";
  try {
    const data = await api("/api/fill/preview", { method: "POST", body: fd });
    fill.columns = data.columns; fill.titleCol = data.title_col;
    fill.rows = data.rows; fill.mapping = data.mapping || {};
    fill.kbFields = data.kb_fields || [];
    renderMapping();
    renderReview();
    $("#fill-step1").classList.add("hidden");
    $("#fill-step2").classList.remove("hidden");
    toast("共 " + fill.rows.length + " 行，请核对候选");
  } catch (e) {
    toast("匹配失败：" + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "开始匹配";
  }
});

function renderMapping() {
  const box = $("#mapping-editor");
  const nonTitle = fill.columns.filter((c) => c !== fill.titleCol);
  if (!nonTitle.length) { box.innerHTML = '<span class="dim">模板只有标题列，无需映射其它字段。</span>'; return; }
  box.innerHTML = "";
  nonTitle.forEach((col) => {
    const item = document.createElement("div");
    item.className = "mapping-item";
    const opts = ["<option value=''>（不填写）</option>"].concat(
      fill.kbFields.map((f) => `<option value="${esc(f)}"${fill.mapping[col] === f ? " selected" : ""}>${esc(f)}</option>`)
    ).join("");
    item.innerHTML = `<span>${esc(col)} ←</span><select data-col="${esc(col)}">${opts}</select>`;
    box.appendChild(item);
  });
}

function renderReview() {
  const tbody = $("#review-body");
  tbody.innerHTML = "";
  fill.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const opts = ["<option value=''>— 不匹配 —</option>"].concat(
      row.candidates.map((c) =>
        `<option value="${c.record_id}">${esc(c.title)}（${c.score}分）[${esc(c.file_name)}]</option>`)
    ).join("");
    const best = row.candidates[0];
    const autoPick = best && best.score >= 40;
    const sel = autoPick ? best.record_id : "";
    const score = autoPick ? best.score : (best ? best.score : 0);
    const scoreCls = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
    tr.innerHTML = `
      <td class="dim">${i + 1}</td>
      <td class="row-title">${esc(row.title)}</td>
      <td><select data-row="${i}">${opts}</select></td>
      <td class="scorecell ${scoreCls}">${autoPick ? score + "分" : "未选"}</td>`;
    const select = tr.querySelector("select");
    select.value = String(sel);
    select.addEventListener("change", () => {
      const v = select.value;
      const cand = row.candidates.find((c) => String(c.record_id) === v);
      const td = tr.querySelector(".scorecell");
      if (!cand) { td.textContent = "未选"; td.className = "scorecell bad"; }
      else {
        td.textContent = cand.score + "分";
        td.className = "scorecell " + (cand.score >= 70 ? "good" : cand.score >= 40 ? "mid" : "bad");
      }
    });
    tbody.appendChild(tr);
  });
}

$("#fill-back").addEventListener("click", () => {
  $("#fill-step2").classList.add("hidden");
  $("#fill-step1").classList.remove("hidden");
  $("#fill-result").classList.add("hidden");
});

$("#fill-export-btn").addEventListener("click", async () => {
  if (!fill.file) return;
  const choices = {};
  const scores = {};
  $$("#review-body select[data-row]").forEach((sel) => {
    choices[sel.dataset.row] = sel.value ? Number(sel.value) : null;
    const row = fill.rows[Number(sel.dataset.row)];
    if (row) {
      const cand = row.candidates.find((c) => String(c.record_id) === sel.value);
      if (cand) scores[sel.dataset.row] = cand.score;
    }
  });
  const mapping = {};
  $$("#mapping-editor select[data-col]").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.col] = sel.value;
  });
  const fd = new FormData();
  fd.append("template", fill.file);
  fd.append("title_col", fill.titleCol);
  fd.append("choices", JSON.stringify(choices));
  fd.append("scores", JSON.stringify(scores));
  fd.append("mapping", JSON.stringify(mapping));
  const btn = $("#fill-export-btn");
  btn.disabled = true; btn.textContent = "生成中…";
  try {
    const data = await api("/api/fill/apply", { method: "POST", body: fd });
    const box = $("#fill-result");
    box.classList.remove("hidden");
    box.className = "file-info ok";
    box.innerHTML = "✅ 已生成：<a class='download-link' href='" + data.download + "'>下载填写结果 Excel</a>";
    toast("填写结果已生成");
  } catch (e) {
    toast("生成失败：" + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "导出填写结果";
  }
});

/* ---------- 文档库 ---------- */
setupDropzone("#lib-drop", "#lib-files", (items) => uploadFiles(items), { allowDirs: true });

async function uploadFiles(items) {
  const prog = $("#upload-progress");
  prog.classList.remove("hidden");
  prog.innerHTML = "上传中 " + items.length + " 个文件…<div class='progress-bar'><div></div></div>";
  const fd = new FormData();
  const folders = [];
  items.forEach((it) => {
    fd.append("files", it.file);
    folders.push(it.relPath || "");
  });
  fd.append("folders", JSON.stringify(folders));
  try {
    const data = await api("/api/files/upload", { method: "POST", body: fd });
    const ok = (data.results || []).filter((r) => r.ok).length;
    const replaced = (data.results || []).filter((r) => r.replaced).length;
    const skipped = (data.results || []).filter((r) => r.skipped).length;
    const bad = (data.results || []).filter((r) => !r.ok);
    prog.innerHTML = "✅ 成功 " + ok + " 个" +
      (replaced ? "（替换旧版 " + replaced + "）" : "") +
      (skipped ? "（跳过重复 " + skipped + "）" : "") +
      (bad.length ? "，失败 " + bad.length + " 个：" + bad.map((b) => esc(b.name)).join("、") : "");
    await refreshLib();
  } catch (e) {
    prog.innerHTML = "❌ 上传失败：" + esc(e.message);
    toast("上传失败", "err");
  }
}

async function refreshLib() {
  const data = await api("/api/files");
  const tbody = $("#lib-body");
  if (!data.files.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="dim">暂无文件</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  data.files.forEach((f) => {
    const tr = document.createElement("tr");
    const statusHtml = f.status === "ok"
      ? '<span class="status-ok">✓</span>'
      : `<span class="status-error">✗ ${esc(f.error || "解析失败")}</span>`;
    tr.innerHTML = `
      <td>${esc(f.name)}</td>
      <td><span class="kind ${f.kind}">${kindLabel(f.kind)}</span></td>
      <td>${fmtSize(f.size)}</td>
      <td>${f.n || 0}</td>
      <td>${statusHtml}</td>
      <td class="dim">${esc(f.created_at || "")}</td>
      <td class="row-actions">
        <button class="small" data-act="reparse" data-id="${f.id}">重新解析</button>
        <button class="small" data-act="delete" data-id="${f.id}">删除</button>
      </td>`;
    tr.querySelector('[data-act="reparse"]').addEventListener("click", async () => {
      try {
        const r = await api("/api/files/reparse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: f.id }) });
        await refreshLib();
        toast("已重新解析");
      } catch (e) { toast("失败：" + e.message, "err"); }
    });
    tr.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm("确定删除「" + f.name + "」及其索引记录？")) return;
      try {
        await api("/api/files/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: f.id })
        });
        await refreshLib(); loadStats(); toast("已删除");
      } catch (e) { toast("删除失败：" + e.message, "err"); }
    });
    tbody.appendChild(tr);
  });
}

$("#lib-scan").addEventListener("click", async () => {
  const btn = $("#lib-scan");
  btn.disabled = true; btn.textContent = "扫描中…";
  try {
    const data = await api("/api/files/scan", { method: "POST" });
    toast("扫描完成：新增 " + (data.added || []).length + " 个" +
      ((data.replaced || []).length ? "，替换旧版 " + data.replaced.length : "") +
      ((data.errors || []).length ? "，失败 " + data.errors.length : ""));
    await refreshLib(); loadStats();
  } catch (e) { toast("扫描失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "扫描 data/files 文件夹"; }
});

/* ---------- 环境检查 ---------- */
async function loadEnv() {
  const badge = $("#env-badge");
  try {
    const d = await api("/api/check");
    if (d.missing && d.missing.length) {
      badge.textContent = "缺组件 ⚠";
      badge.className = "env-badge warn";
      renderEnvBanner(d.missing, d.install_command);
    } else {
      badge.textContent = "环境 ✓";
      badge.className = "env-badge";
    }
  } catch (e) {
    badge.textContent = "环境检查失败";
    badge.className = "env-badge checking";
  }
}

function renderEnvBanner(missing, installCommand) {
  const list = $("#env-missing-list");
  list.innerHTML = missing.map((m) =>
    "<li>" + esc(m.label) + "　—　需要安装 <code>" + esc(m.pip) + "</code></li>").join("");
  $("#env-banner").classList.remove("hidden");
  $("#env-install-btn").onclick = async () => {
    const btn = $("#env-install-btn");
    const res = $("#env-install-result");
    btn.disabled = true;
    btn.textContent = "正在安装（需联网，可能要几分钟）…";
    res.classList.remove("hidden");
    res.innerHTML = "<span class='dim'>正在运行 pip install…</span>";
    try {
      const d = await api("/api/deps/install", { method: "POST" });
      res.innerHTML = d.ok
        ? "<span class='ok'>✅ 安装完成！请重启程序后再导入对应格式。</span>"
        : "<span class='err'>❌ 安装失败，请检查网络后重试：</span><pre>" +
          esc((d.output_tail || d.error || "").slice(-1500)) + "</pre>";
      if (d.ok) location.reload();
    } catch (e) {
      res.innerHTML = "<span class='err'>❌ " + esc(e.message) + "</span>";
    } finally {
      btn.disabled = false;
      btn.textContent = "一键安装缺失组件";
    }
  };
  $("#env-copy-btn").onclick = () => {
    fallbackCopy(installCommand);
  };
  $("#env-dismiss-btn").onclick = () => $("#env-banner").classList.add("hidden");
}

/* ---------- 退出程序 ---------- */
$("#shutdown-btn").addEventListener("click", async () => {
  if (!confirm("确定要关闭资料助手程序吗？")) return;
  try {
    await api("/api/shutdown", { method: "POST" });
    toast("程序已关闭，现在可以关闭此页面了", "ok", 6000);
    $("#shutdown-btn").disabled = true;
    $("#shutdown-btn").textContent = "已退出";
  } catch (e) {
    toast("退出失败：" + e.message, "err");
  }
});

/* ---------- 表格粘贴 ---------- */
const paste = { src: null, tgt: null, srcCols: [], tgtCols: [], mode: "match",
                srcKey: "", tgtKey: "", mapping: {}, rows: [] };

function fillPasteSelect(sel, cols, selected) {
  sel.innerHTML = cols.map(c => `<option value="${esc(c)}"${c === selected ? " selected" : ""}>${esc(c)}</option>`).join("");
}

function pasteFileInfo() {
  const parts = [];
  if (paste.src) parts.push("源：" + paste.src.name);
  if (paste.tgt) parts.push("目标：" + paste.tgt.name);
  const info = $("#paste-file-info");
  if (parts.length === 2) { info.classList.remove("hidden"); info.textContent = parts.join("　"); }
  else info.classList.add("hidden");
}

setupDropzone("#paste-src-drop", "#paste-src-file", async (files) => {
  const f = files[0];
  if (!/\.(xlsx|xlsm|xls|csv)$/i.test(f.name)) { toast("只支持 .xlsx/.xls/.csv", "err"); return; }
  paste.src = f;
  const fd = new FormData(); fd.append("template", f);
  try {
    const d = await api("/api/template/columns", { method: "POST", body: fd });
    paste.srcCols = d.columns;
    fillPasteSelect($("#paste-src-key"), d.columns, "");
    pasteFileInfo();
  } catch (e) { toast("读取源表格失败：" + e.message, "err"); }
});

setupDropzone("#paste-tgt-drop", "#paste-tgt-file", async (files) => {
  const f = files[0];
  if (!/\.(xlsx|xlsm|xls|csv)$/i.test(f.name)) { toast("只支持 .xlsx/.xls/.csv", "err"); return; }
  paste.tgt = f;
  const fd = new FormData(); fd.append("template", f);
  try {
    const d = await api("/api/template/columns", { method: "POST", body: fd });
    paste.tgtCols = d.columns;
    fillPasteSelect($("#paste-tgt-key"), d.columns, "");
    pasteFileInfo();
  } catch (e) { toast("读取目标表格失败：" + e.message, "err"); }
});

$("#paste-mode").addEventListener("change", () => {
  const m = $("#paste-mode").value;
  $("#paste-src-key-wrap").style.display = m === "match" ? "" : "none";
  $("#paste-tgt-key-wrap").style.display = m === "match" ? "" : "none";
  $("#paste-step2").classList.add("hidden");
  paste.mode = m;
});

$("#paste-start").addEventListener("click", async () => {
  if (!paste.src || !paste.tgt) { toast("请先上传源表格和目标表格", "err"); return; }
  const fd = new FormData();
  fd.append("source", paste.src);
  fd.append("target", paste.tgt);
  fd.append("mode", $("#paste-mode").value);
  fd.append("src_key", $("#paste-src-key").value || "");
  fd.append("tgt_key", $("#paste-tgt-key").value || "");
  fd.append("top_k", $("#paste-topk").value || "3");
  const btn = $("#paste-start");
  btn.disabled = true; btn.textContent = "处理中…";
  try {
    const d = await api("/api/paste/preview", { method: "POST", body: fd });
    paste.mode = d.mode;
    paste.srcKey = d.src_key; paste.tgtKey = d.tgt_key;
    paste.mapping = d.mapping || {};
    paste.rows = d.rows || [];
    renderPasteMapping(d.source_columns, d.target_columns);
    if (d.mode === "match") {
      renderPasteReview();
      $("#paste-review-wrap").classList.remove("hidden");
      $("#paste-row-note").classList.add("hidden");
    } else {
      $("#paste-review-wrap").classList.add("hidden");
      const note = $("#paste-row-note");
      note.classList.remove("hidden");
      note.textContent = "按行顺序直接复制：源表第 N 行 → 目标表第 N 行（超出目标行数的源行将追加到末尾），无需逐行核对，直接点导出。";
    }
    $("#paste-step2").classList.remove("hidden");
    toast("源表 " + d.source_rows + " 行 / 目标表 " + d.target_rows + " 行，请核对后导出");
  } catch (e) { toast("失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "开始粘贴"; }
});

function renderPasteMapping(srcCols, tgtCols) {
  const box = $("#paste-mapping");
  const used = {};
  Object.entries(paste.mapping || {}).forEach(([tc, sc]) => { if (!(sc in used)) used[sc] = tc; });
  box.innerHTML = "";
  srcCols.forEach((sc) => {
    if (sc === paste.srcKey) return;
    const item = document.createElement("div");
    item.className = "mapping-item";
    const tgt = used[sc] || (tgtCols.includes(sc) ? sc : "");
    const opts = ["<option value=''>（不粘贴）</option>"].concat(
      tgtCols.map(tc => `<option value="${esc(tc)}"${tc === tgt ? " selected" : ""}>${esc(tc)}</option>`)
    ).join("");
    item.innerHTML = "<label class='map-check'><input type='checkbox' data-sc='" + esc(sc) + "' " + (tgt ? "checked" : "") + "> " + esc(sc) + "</label><select data-sc='" + esc(sc) + "'>" + opts + "</select>";
    const chk = item.querySelector("input");
    const sel = item.querySelector("select");
    chk.addEventListener("change", () => { if (!chk.checked) sel.value = ""; });
    sel.addEventListener("change", () => { if (sel.value) chk.checked = true; });
    box.appendChild(item);
  });
  $("#paste-mapping-box").style.display = "block";
}

function collectPasteMapping() {
  const mapping = {};
  $$("#paste-mapping .mapping-item").forEach((item) => {
    const chk = item.querySelector("input");
    const sel = item.querySelector("select");
    if (chk.checked && sel.value) mapping[sel.value] = chk.dataset.sc;
  });
  return mapping;
}

function renderPasteReview() {
  const tbody = $("#paste-review-body");
  tbody.innerHTML = "";
  paste.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const opts = ["<option value=''>— 不匹配 —</option>"].concat(
      row.candidates.map(c => `<option value="${c.source_index}">${esc(c.key)}（${c.score}分）[源第${c.source_index + 1}行]</option>`)
    ).join("");
    const best = row.candidates[0];
    const autoPick = best && best.score >= 40;
    const score = best ? best.score : 0;
    const scoreCls = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
    tr.innerHTML = `
      <td class="dim">${i + 1}</td>
      <td class="row-title">${esc(row.key)}</td>
      <td><select data-row="${i}">${opts}</select></td>
      <td class="scorecell ${scoreCls}">${autoPick ? score + "分" : "未选"}</td>`;
    const sel = tr.querySelector("select");
    sel.value = String(autoPick ? best.source_index : "");
    sel.addEventListener("change", () => {
      const v = sel.value;
      const cand = row.candidates.find(c => String(c.source_index) === v);
      const td = tr.querySelector(".scorecell");
      if (!cand) { td.textContent = "未选"; td.className = "scorecell bad"; }
      else { td.textContent = cand.score + "分"; td.className = "scorecell " + (cand.score >= 70 ? "good" : cand.score >= 40 ? "mid" : "bad"); }
    });
    tbody.appendChild(tr);
  });
}

$("#paste-back").addEventListener("click", () => { $("#paste-step2").classList.add("hidden"); });

$("#paste-export").addEventListener("click", async () => {
  if (!paste.src || !paste.tgt) return;
  const fd = new FormData();
  fd.append("source", paste.src);
  fd.append("target", paste.tgt);
  fd.append("mode", paste.mode);
  fd.append("src_key", paste.srcKey || "");
  fd.append("tgt_key", paste.tgtKey || "");
  fd.append("overwrite", $("#paste-overwrite").value);
  fd.append("append_unmatched", $("#paste-append").value);
  const choices = {};
  if (paste.mode === "match") {
    $$("#paste-review-body select[data-row]").forEach((sel) => {
      choices[sel.dataset.row] = sel.value ? Number(sel.value) : null;
    });
  }
  fd.append("choices", JSON.stringify(choices));
  fd.append("mapping", JSON.stringify(collectPasteMapping()));
  const btn = $("#paste-export");
  btn.disabled = true; btn.textContent = "生成中…";
  try {
    const d = await api("/api/paste/apply", { method: "POST", body: fd });
    const box = $("#paste-result");
    box.classList.remove("hidden");
    box.className = "file-info ok";
    box.innerHTML = "✅ 已生成：<a class='download-link' href='" + d.download + "'>下载粘贴结果 Excel</a>";
    toast("粘贴结果已生成");
  } catch (e) { toast("生成失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "导出粘贴结果"; }
});

/* ---------- 标书助手 ---------- */
const BID_FIELDS = [["公司名称","公司名称"],["统一社会信用代码","统一社会信用代码"],
  ["法定代表人","法定代表人"],["注册地址","注册地址"],["注册资本","注册资本"],
  ["成立日期","成立日期"],["联系人","联系人"],["联系电话","联系电话"],
  ["邮箱","邮箱"],["开户银行","开户银行"],["银行账号","银行账号"],
  ["公司简介","公司简介"],["资质简述","资质简述"]];
const bid = { tpl: null, chapters: [], profile: {} };

function renderBidProfile() {
  const box = $("#bid-profile-fields");
  box.innerHTML = "";
  BID_FIELDS.forEach(([label]) => {
    const item = document.createElement("div");
    item.className = "bid-field";
    item.innerHTML = "<label>" + esc(label) + "：<input data-k='" + esc(label) + "' type='text'></label>";
    box.appendChild(item);
  });
}

async function loadBidProfile() {
  renderBidProfile();
  try {
    const d = await api("/api/bid/company");
    Object.entries(d.fields || {}).forEach(([k, v]) => {
      const inp = document.querySelector('#bid-profile-fields input[data-k="' + CSS.escape(k) + '"]');
      if (inp) inp.value = v;
    });
    bid.profile = d.fields || {};
  } catch (e) { /* ignore */ }
}

$("#bid-profile-save").addEventListener("click", async () => {
  const fields = {};
  $$("#bid-profile-fields input[data-k]").forEach(inp => { fields[inp.dataset.k] = inp.value.trim(); });
  try {
    await api("/api/bid/company", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
    bid.profile = fields;
    $("#bid-profile-msg").textContent = "✅ 已保存 " + new Date().toLocaleTimeString();
    toast("公司档案已保存");
  } catch (e) { toast("保存失败：" + e.message, "err"); }
});

setupDropzone("#bid-tpl-drop", "#bid-tpl-file", (files) => {
  const f = files[0];
  if (!/\.docx$/i.test(f.name)) { toast("请上传 .docx 模板", "err"); return; }
  bid.tpl = f;
  const info = $("#bid-tpl-info");
  info.classList.remove("hidden");
  info.textContent = "📄 " + f.name;
});

$("#bid-parse").addEventListener("click", async () => {
  if (!bid.tpl) { toast("请先上传标书模板", "err"); return; }
  const fd = new FormData();
  fd.append("template", bid.tpl);
  const btn = $("#bid-parse");
  btn.disabled = true; btn.textContent = "解析中…";
  try {
    const d = await api("/api/bid/parse", { method: "POST", body: fd });
    if (!d.ok) { toast("解析失败：" + (d.error || ""), "err"); return; }
    bid.chapters = d.chapters;
    renderBidChapters();
    $("#bid-chapters-box").classList.remove("hidden");
    toast("模板解析出 " + d.total + " 个章节");
  } catch (e) { toast("解析失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "解析模板"; }
});

function renderBidChapters() {
  const tbody = $("#bid-chapter-body");
  tbody.innerHTML = "";
  bid.chapters.forEach((ch, i) => {
    const tr = document.createElement("tr");
    const indent = "　".repeat(Math.max(ch.level - 1, 0));
    const modeOpts = "<option value='auto'>自动匹配</option><option value='template'>用模板原文</option><option value='empty'>留空</option>";
    const candOpts = ["<option value=''>（不填素材）</option>"].concat(
      ch.candidates.map(c => "<option value='" + c.record_id + "'>" + esc(c.title) + "（" + c.score + "分）[" + esc(c.file_name) + "]</option>")
    ).join("");
    const best = ch.candidates[0];
    tr.innerHTML = "<td class='row-title'>" + indent + esc(ch.title) + "</td>" +
      "<td><select data-i='" + i + "' class='bid-mode'>" + modeOpts + "</select></td>" +
      "<td><select data-i='" + i + "' class='bid-cand'>" + candOpts + "</select></td>";
    const modeSel = tr.querySelector(".bid-mode");
    const candSel = tr.querySelector(".bid-cand");
    modeSel.value = "auto";
    candSel.value = String(best && best.score >= 40 ? best.record_id : "");
    const sync = () => { candSel.disabled = modeSel.value !== "auto"; };
    modeSel.addEventListener("change", sync);
    sync();
    tbody.appendChild(tr);
  });
}

$("#bid-generate").addEventListener("click", async () => {
  if (!bid.tpl) return;
  const choices = {};
  $$("#bid-chapter-body tr").forEach(tr => {
    const i = tr.querySelector(".bid-mode").dataset.i;
    const mode = tr.querySelector(".bid-mode").value;
    const rid = tr.querySelector(".bid-cand").value;
    choices[i] = { mode: mode, record_id: (mode === "auto" && rid) ? Number(rid) : null };
  });
  const project = {
    "项目名称": $("#bid-proj-name").value.trim(),
    "招标编号": $("#bid-tender-no").value.trim(),
    "招标人": $("#bid-tenderer").value.trim()
  };
  const fd = new FormData();
  fd.append("template", bid.tpl);
  fd.append("choices", JSON.stringify(choices));
  fd.append("project", JSON.stringify(project));
  const btn = $("#bid-generate");
  btn.disabled = true; btn.textContent = "生成中…";
  try {
    const d = await api("/api/bid/generate", { method: "POST", body: fd });
    const box = $("#bid-result");
    box.classList.remove("hidden");
    box.className = "file-info ok";
    box.innerHTML = "✅ 已生成：<a class='download-link' href='" + d.download + "'>下载标书草稿 Word</a>";
    toast("标书草稿已生成");
  } catch (e) { toast("生成失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "生成标书草稿"; }
});

/* ---------- 帮助中心 ---------- */
const HELP = {
  doc: {
    title: "文档功能",
    lines: [
      "【文档库】把文档/表格/PDF/图片拖进虚线框即可导入（可多选，拖文件夹会连同子文件夹一起导入）；也可以把文件直接放进程序目录 data\\files（支持子文件夹分类），点「扫描 data/files 文件夹」批量导入。",
      "支持格式：txt/md/html、csv/xlsx/xls、docx/doc、pptx/ppt、pdf、图片(png/jpg…)",
      "【搜索】输入关键词（中文/英文/数字都行），可点搜索框旁下拉按 表格/文档/PDF/演示/图片 类型筛选，避免互相干扰。",
      "搜索结果按相关度排序、关键词高亮；点「＋ 选择」把记录收进右侧列表，可复制文本或导出 Excel。",
      "【数据】所有导入的文件都保存在程序旁边的 data 文件夹，删掉即清空所有资料。",
      "同名文件重新导入：内容没变会跳过；内容改过会自动替换旧版，不会出现两份。"
    ]
  },
  table: {
    title: "表格功能",
    lines: [
      "【表格填写】上传一张模板表（.xlsx/.xls/.csv），选择“匹配列”（即标题列，如 产品名称），程序自动从已导入的资料中逐行匹配并填好其它字段。",
      "每条匹配都能下拉核对：换其它候选，或选“不匹配”。字段映射会自动建议、可手动改。导出时自动加 匹配结果/匹配来源/匹配度 三列。",
      "【表格粘贴】上传“源表格”（提供数据）和“目标表格”（要填写的、已有内容）。",
      "两种方式：按匹配列对应（逐行核对，推荐）/ 按行顺序直接复制（一列/几列直接贴过来）。",
      "可选项：已有内容 不覆盖（推荐）/ 覆盖；未匹配的源行 追加到目标末尾 / 忽略。"
    ]
  },
  bid: {
    title: "标书功能",
    lines: [
      "【标书助手】① 填一次“公司档案”（名称/信用代码/法人/资质等），之后所有标书自动代入；",
      "② 上传标书模板(.docx)，系统自动读取章节结构（换模板就跟着变）；",
      "③ 核对每章：自动匹配素材库 / 用模板原文 / 留空，自动匹配会给出候选素材供选择；",
      "④ 填项目名称、招标编号、招标人；⑤ 生成标书草稿 Word（封面+目录+各章，【公司名称】【项目名称】等占位符自动替换）。",
      "【素材库】把历史标书/资质/业绩/技术方案等放进 data\\files\\标书素材\\ 的子文件夹，在「文档库」点扫描后即被自动匹配。",
      "⚠️ 生成的是草稿：报价、承诺、签字盖章必须人工核对后才能投标。"
    ]
  },
  common: {
    title: "通用说明",
    lines: [
      "启动：双击「资料助手.exe」，浏览器自动打开；用完点网页右上角「⏻ 退出程序」。",
      "如果浏览器没自动打开，请在地址栏输入 http://127.0.0.1:8000",
      "无需安装 Python、无需安装任何依赖、无需联网，数据全部在本机。",
      "杀毒软件误报时选择“允许运行”即可（本地打包的绿色软件）。",
      "Win7 兼容版说明见压缩包内《使用说明-Win7.txt》。"
    ]
  }
};

function openHelp(sec) {
  const secs = ["doc", "table", "bid", "common"];
  const names = { doc: "📄 文档", table: "📊 表格", bid: "📑 标书", common: "⚙️ 通用" };
  if (!secs.includes(sec)) sec = "doc";
  const nav = secs.map(s => `<button class="help-nav" data-sec="${s}"${s === sec ? ' disabled' : ''}>${names[s]}</button>`).join("");
  const body = `<div class="help-nav">${nav}</div><div class="help-body">${HELP[sec].lines.map(l => `<p>${esc(l)}</p>`).join("")}</div>`;
  $("#modal-title").textContent = "使用说明 · " + HELP[sec].title;
  $("#modal-body").innerHTML = body;
  const mbox = document.querySelector(".modal-box");
  if (mbox) mbox.classList.remove("reading");
  $$(".help-nav[data-sec]").forEach(btn => {
    btn.addEventListener("click", () => openHelp(btn.dataset.sec));
  });
  $("#modal").classList.remove("hidden");
}

$("#help-btn").addEventListener("click", () => openHelp("doc"));
$$(".help-link").forEach(a => a.addEventListener("click", (e) => { e.preventDefault(); openHelp(a.dataset.help); }));

/* ---------- 初始化 ---------- */
async function init() {
  await Promise.all([loadStats(), refreshLib(), loadEnv(), loadBidProfile(), loadFieldKeys(), loadTables()]);
}
init();
