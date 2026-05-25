import { useState, useRef, useCallback, useEffect, useReducer, useMemo } from "react";

/* ═══════════════════════════════════════════════════════════════════
   Cherry Canvas — 生产版 v3
   
   本次更新:
   ✓ 修复 bug: 选择逻辑/拖拽区域/hit-test/缩放精度/外部点击关闭
   ✓ 即梦本地运行时集成：用户只需网页登录或扫码授权
   ✓ API 配置: 删除派欧云，保留其他平台并移除邀请链接
   ✓ 自定义 API: 基础 OpenAI 兼容配置 + 可折叠高级字段
   ✓ 10 套主题配色 (全局变量驱动)
   ✓ 节点默认尺寸增大 30-40%
   ✓ Header 区域大幅可拖拽 + Body 空白区域拖拽
   ✓ 选择逻辑: 鼠标点击选中 (非悬停)，移除 hover 副作用
   ✓ 结果区点击 → 弹出大图预览 + 下载按钮
   ✓ 学习原项目: 流式输出/批量出图/连线锚点提示/快捷键面板
   ═══════════════════════════════════════════════════════════════════ */

const GRID = 24, MIN_Z = 0.1, MAX_Z = 4;
const clamp = (v,a,b) => Math.min(Math.max(v,a),b);
const snap = (v,g) => Math.round(v/g)*g;
const uid = () => "n_" + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-4);
const s2c = (sx,sy,vp) => ({x:(sx-vp.x)/vp.z, y:(sy-vp.y)/vp.z});
const c2s = (cx,cy,vp) => ({x:cx*vp.z+vp.x, y:cy*vp.z+vp.y});
const inR = (r,px,py) => px>=r.x&&px<=r.x+r.w&&py>=r.y&&py<=r.y+r.h;
const olap = (a,b) => a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const isImageFile = (file) => file?.type?.startsWith("image/");
const isVideoFile = (file) => file?.type?.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file?.name || "");
const isAudioFile = (file) => file?.type?.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file?.name || "");
const isTextFile = (file) => file?.type?.startsWith("text/") || /\.(txt|md|markdown|json|csv|srt|ass|vtt|xml|yaml|yml)$/i.test(file?.name || "");
const fileKindOf = (file) => isImageFile(file) ? "image" : isVideoFile(file) ? "video" : isAudioFile(file) ? "audio" : isTextFile(file) ? "text" : "other";
const isSupportedAssetFile = (file) => ["image", "video", "audio", "text"].includes(fileKindOf(file));
const SOURCE_ASSET_TYPES = new Set(["source-image", "source-video", "source-audio", "source-text"]);
const isSourceAssetType = (type) => SOURCE_ASSET_TYPES.has(type);
const fileSort = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const naturalFileCompare = (a, b) => fileSort.compare(a.path || a.file?.name || "", b.path || b.file?.name || "");
const hasFileDrag = (dt) => Array.from(dt?.types || []).includes("Files") || Array.from(dt?.items || []).some(item => item.kind === "file");
const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
  reader.readAsDataURL(file);
});
const readFileAsText = (file) => file.text ? file.text() : new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result || "");
  reader.onerror = () => reject(reader.error || new Error("文本读取失败"));
  reader.readAsText(file);
});
const readEntryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
const readDirectoryBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
const walkDroppedEntry = async (entry, parentPath = "") => {
  if(!entry) return [];
  const nextPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if(entry.isFile){
    const file = await readEntryFile(entry);
    return [{ file, path: nextPath, rootName: parentPath.split("/")[0] || entry.name }];
  }
  if(entry.isDirectory){
    const reader = entry.createReader();
    const entries = [];
    while(true){
      const batch = await readDirectoryBatch(reader);
      if(!batch.length) break;
      entries.push(...batch);
    }
    const nested = await Promise.all(entries.map(child => walkDroppedEntry(child, nextPath)));
    return nested.flat();
  }
  return [];
};
const collectDroppedFileEntries = async (dt) => {
  const itemEntries = Array.from(dt?.items || [])
    .filter(item => item.kind === "file")
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if(itemEntries.some(entry => entry.isDirectory)){
    const nested = (await Promise.all(itemEntries.map(entry => walkDroppedEntry(entry)))).flat();
    const rootName = itemEntries.find(entry => entry.isDirectory)?.name || nested[0]?.rootName || "导入文件夹";
    return { hasDirectory: true, rootName, files: nested };
  }
  const files = Array.from(dt?.files || []).map(file => ({
    file,
    path: file.webkitRelativePath || file.name,
    rootName: (file.webkitRelativePath || "").split("/")[0] || "",
  }));
  const hasDirectory = files.some(item => item.path.includes("/"));
  return {
    hasDirectory,
    rootName: files.find(item => item.rootName)?.rootName || "导入素材",
    files,
  };
};
const createImageThumbnail = (source, maxSize = 1200) => new Promise((resolve) => {
  const img = new Image();
  let objectUrl = "";
  img.onload = () => {
    try {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
      const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/webp", 0.82));
    } catch {
      resolve(typeof source === "string" ? source : "");
    } finally {
      if(objectUrl) URL.revokeObjectURL(objectUrl);
    }
  };
  img.onerror = () => {
    if(objectUrl) URL.revokeObjectURL(objectUrl);
    resolve(typeof source === "string" ? source : "");
  };
  if(typeof source === "string") img.src = source;
  else {
    objectUrl = URL.createObjectURL(source);
    img.src = objectUrl;
  }
});
const formatBytes = (bytes=0) => {
  if(!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
const assetKindLabel = (kind = "") => ({ image: "图片", video: "视频", audio: "音频", text: "文本" })[kind] || "文件";
const assetKindIcon = (kind = "") => ({ image: "image", video: "video", audio: "audio", text: "text" })[kind] || "note";
const sourceTypeForKind = (kind = "") => ({ image: "source-image", video: "source-video", audio: "source-audio", text: "source-text" })[kind] || "";
const stripFileExt = (name = "") => String(name || "").replace(/\.[a-z0-9]+$/i, "");
const imageExtFor = (fileName = "", mimeType = "") => {
  const fromName = String(fileName || "").match(/\.[a-z0-9]+$/i)?.[0];
  if(fromName) return fromName;
  return ({
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  })[String(mimeType || "").toLowerCase()] || ".png";
};
const compactLabel = (value = "", fallback = "素材图") => String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 48) || fallback;
const sourceDisplayName = (fileName = "", index = 1) => {
  const base = stripFileExt(fileName).trim();
  const machineLike = base.length > 28 || /^hf[_-]/i.test(base) || /[0-9a-f]{8}-[0-9a-f-]{12,}/i.test(base);
  return machineLike || !base ? `素材图 ${index}` : base;
};
const imageReferenceName = (node, latest) => compactLabel(stripFileExt(node?.name || latest?.name || node?.fileName || latest?.fileName || ""), "素材图");
const imageReferenceFileName = (label, node, latest) => `${label}${imageExtFor(node?.fileName || latest?.fileName, node?.mimeType || latest?.data?.mimeType)}`;
const API_BASE = "http://127.0.0.1:8777";
const MEDIA_EXT_RE = /\.(mp4|webm|mov|png|jpe?g|webp|gif)(?:[?#].*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)(?:[?#].*)?$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i;
const isVideoMediaUrl = (url = "") => VIDEO_EXT_RE.test(String(url || "")) || /^data:video\//i.test(String(url || ""));
const isImageMediaUrl = (url = "") => (IMAGE_EXT_RE.test(String(url || "")) || /^data:image\//i.test(String(url || ""))) && !/_poster\.jpe?g(?:[?#].*)?$/i.test(String(url || ""));
const isAudioMediaUrl = (url = "") => /\.(mp3|wav|m4a|aac|ogg|flac)(?:[?#].*)?$/i.test(String(url || "")) || /^data:audio\//i.test(String(url || ""));
const firstMediaValue = (items, key) => Array.isArray(items) ? (items.find(item => item?.[key])?.[key] || "") : "";
const outputUrlFromLocalPath = (value = "") => {
  const clean = String(value || "").replace(/^file:\/+/i, "").replace(/\\\\/g, "\\").trim();
  if(!MEDIA_EXT_RE.test(clean)) return "";
  const fileName = clean.split(/[\\/]/).filter(Boolean).pop();
  return fileName ? `${API_BASE}/output/${encodeURIComponent(fileName)}` : "";
};
const normalizeMediaUrl = (value = "") => {
  const s = String(value || "").trim();
  if(!s || /jimeng\.jianying\.com\/ai-tool\/cli-auth/i.test(s)) return "";
  if(/^blob:/i.test(s) || /^data:(?:image|video|audio|text|application)\//i.test(s)) return s;
  if(/^https?:\/\//i.test(s)) return s;
  if(/^(?:[A-Za-z]:\\|\/)/.test(s) && MEDIA_EXT_RE.test(s)) return outputUrlFromLocalPath(s);
  return "";
};
const collectMediaCandidates = (value, out = []) => {
  if(!value) return out;
  if(typeof value === "string"){
    const direct = normalizeMediaUrl(value);
    if(direct) out.push(direct);
    (value.match(/https?:\/\/[^\s"'<>]+/g) || []).forEach(url => {
      const normalized = normalizeMediaUrl(url);
      if(normalized) out.push(normalized);
    });
    (value.match(/[A-Za-z]:(?:\\\\|\\)[^"'\n\r<>]+?\.(?:mp4|webm|mov|png|jpe?g|webp|gif)/gi) || []).forEach(file => {
      const normalized = outputUrlFromLocalPath(file);
      if(normalized) out.push(normalized);
    });
    return out;
  }
  if(Array.isArray(value)){
    value.forEach(item => collectMediaCandidates(item, out));
    return out;
  }
  if(typeof value === "object") Object.values(value).forEach(item => collectMediaCandidates(item, out));
  return out;
};
const firstMediaCandidate = (value) => [...new Set(collectMediaCandidates(value))][0] || "";
const firstTypedMediaCandidate = (value, predicate) => [...new Set(collectMediaCandidates(value))].find(predicate) || "";
const posterFromVideoUrl = (url = "") => {
  if(!/\/output\/[^?#]+\.mp4(?:[?#].*)?$/i.test(url)) return "";
  const cleanUrl = url.split(/[?#]/)[0];
  return cleanUrl.replace(/\.mp4$/i, "_poster.jpg");
};
const cacheBustedMediaUrl = (url = "", key = "") => {
  if(!url) return "";
  const suffix = encodeURIComponent(String(key || Date.now()));
  return `${url}${url.includes("?") ? "&" : "?"}v=${suffix}`;
};
const downloadMediaUrl = (url = "", filename = "") => {
  if(!url) return "";
  const params = `download=1&filename=${encodeURIComponent(filename || "download")}`;
  return `${url}${url.includes("?") ? "&" : "?"}${params}`;
};
const resultUrlOf = (result = {}) => normalizeMediaUrl(result.url)
  || normalizeMediaUrl(result.urls?.[0])
  || normalizeMediaUrl(result.data?.url)
  || normalizeMediaUrl(result.data?.urls?.[0])
  || normalizeMediaUrl(firstMediaValue(result.media, "url"))
  || normalizeMediaUrl(firstMediaValue(result.data?.media, "url"))
  || normalizeMediaUrl(firstMediaValue(result.data?.data?.result_json?.videos, "url"))
  || normalizeMediaUrl(firstMediaValue(result.data?.data?.result_json?.videos, "path"))
  || normalizeMediaUrl(firstMediaValue(result.data?.result_json?.videos, "url"))
  || normalizeMediaUrl(firstMediaValue(result.data?.result_json?.videos, "path"))
  || firstMediaCandidate(result);
const resultVideoUrlOf = (result = {}) => {
  const candidates = [
    normalizeMediaUrl(result.url),
    ...(Array.isArray(result.urls) ? result.urls.map(normalizeMediaUrl) : []),
    normalizeMediaUrl(result.data?.url),
    ...(Array.isArray(result.data?.urls) ? result.data.urls.map(normalizeMediaUrl) : []),
    normalizeMediaUrl(firstMediaValue(result.media, "url")),
    normalizeMediaUrl(firstMediaValue(result.data?.media, "url")),
    normalizeMediaUrl(firstMediaValue(result.data?.data?.result_json?.videos, "url")),
    normalizeMediaUrl(firstMediaValue(result.data?.data?.result_json?.videos, "path")),
    normalizeMediaUrl(firstMediaValue(result.data?.result_json?.videos, "url")),
    normalizeMediaUrl(firstMediaValue(result.data?.result_json?.videos, "path")),
  ].filter(Boolean);
  return candidates.find(isVideoMediaUrl) || firstTypedMediaCandidate(result, isVideoMediaUrl);
};
const resultImageUrlOf = (result = {}) => {
  const candidates = [
    normalizeMediaUrl(result.url),
    ...(Array.isArray(result.urls) ? result.urls.map(normalizeMediaUrl) : []),
    normalizeMediaUrl(result.data?.url),
    ...(Array.isArray(result.data?.urls) ? result.data.urls.map(normalizeMediaUrl) : []),
    normalizeMediaUrl(firstMediaValue(result.media, "url")),
    normalizeMediaUrl(firstMediaValue(result.data?.media, "url")),
  ].filter(Boolean);
  return candidates.find(isImageMediaUrl) || firstTypedMediaCandidate(result, isImageMediaUrl);
};
const resultPosterOf = (result = {}) => normalizeMediaUrl(result.poster)
  || normalizeMediaUrl(result.posters?.[0])
  || normalizeMediaUrl(result.data?.poster)
  || normalizeMediaUrl(result.data?.posters?.[0])
  || normalizeMediaUrl(firstMediaValue(result.media, "poster"))
  || normalizeMediaUrl(firstMediaValue(result.data?.media, "poster"))
  || posterFromVideoUrl(resultUrlOf(result));
const resultSubmitIdOf = (result = {}) => {
  const direct = result.submitId || result.submit_id || result.taskId || result.task_id || result.data?.submitId || result.data?.submit_id || result.data?.taskId || result.data?.task_id || result.data?.data?.submitId || result.data?.data?.submit_id;
  if(direct) return direct;
  const raw = `${result.text || ""}\n${result.raw || ""}\n${result.data?.raw || ""}`;
  return raw.match(/(?:submit_id|submitId|task_id|taskId)["'\s:=：]+([A-Za-z0-9_-]{12,})/)?.[1]
    || raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
    || "";
};

// ─── 主题配色 (全局变量驱动) ───
const resultStatusOf = (result = {}) => String(result.gen_status || result.status || result.data?.gen_status || result.data?.status || result.data?.data?.gen_status || result.data?.data?.status || "").toLowerCase();
const resultFailReasonOf = (result = {}) => result.fail_reason || result.error || result.data?.fail_reason || result.data?.error || result.data?.data?.fail_reason || result.data?.data?.error || "";
const resultFailed = (result = {}) => resultStatusOf(result) === "fail" || resultStatusOf(result) === "failed" || !!resultFailReasonOf(result);
const resultSucceeded = (result = {}) => ["success", "done", "finish", "finished"].includes(resultStatusOf(result));
const resultMediaUrlOf = (result = {}, nodeType = "") => nodeType === "ai-video"
  ? resultVideoUrlOf(result)
  : (nodeType === "ai-image" || nodeType === "source-image" ? resultImageUrlOf(result) || resultUrlOf(result) : resultUrlOf(result));
const taskVideoUrlOf = (submitId = "") => submitId ? `${API_BASE}/output/task/${encodeURIComponent(submitId)}.mp4` : "";
const taskVideoPosterUrlOf = (submitId = "") => submitId ? `${API_BASE}/output/task/${encodeURIComponent(submitId)}_poster.jpg` : "";
const playableVideoUrlOf = (result = {}) => {
  if(resultFailed(result)) return "";
  const explicitUrl = resultVideoUrlOf(result);
  const submitId = resultSubmitIdOf(result);
  if(explicitUrl) return taskVideoUrlOf(submitId) || explicitUrl;
  return resultSucceeded(result) ? taskVideoUrlOf(submitId) : "";
};
const playableVideoPosterOf = (result = {}) => resultPosterOf(result) || taskVideoPosterUrlOf(resultSubmitIdOf(result)) || posterFromVideoUrl(resultVideoUrlOf(result));

const THEMES = {
  midnight: {
    name: "午夜紫", emoji: "🌌",
    bg: "#080809", bg2: "rgba(22,22,28,0.92)", bg3: "rgba(18,18,22,0.9)",
    accent: "#6366f1", accent2: "#8b5cf6", accentRgb: "99,102,241",
    surface: "rgba(255,255,255,0.04)", surfaceHi: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.5)", textDim: "rgba(255,255,255,0.3)",
  },
  aurora: {
    name: "极光蓝", emoji: "🌊",
    bg: "#0a0e1a", bg2: "rgba(18,24,38,0.94)", bg3: "rgba(16,22,34,0.92)",
    accent: "#06b6d4", accent2: "#3b82f6", accentRgb: "6,182,212",
    surface: "rgba(255,255,255,0.04)", surfaceHi: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.5)", textDim: "rgba(255,255,255,0.3)",
  },
  cyber: {
    name: "赛博粉", emoji: "🌸",
    bg: "#0d0810", bg2: "rgba(28,18,30,0.94)", bg3: "rgba(24,16,26,0.92)",
    accent: "#ec4899", accent2: "#a855f7", accentRgb: "236,72,153",
    surface: "rgba(255,255,255,0.04)", surfaceHi: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.5)", textDim: "rgba(255,255,255,0.3)",
  },
  forest: {
    name: "森林绿", emoji: "🌲",
    bg: "#080c0a", bg2: "rgba(16,24,20,0.94)", bg3: "rgba(14,22,18,0.92)",
    accent: "#10b981", accent2: "#06b6d4", accentRgb: "16,185,129",
    surface: "rgba(255,255,255,0.04)", surfaceHi: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.5)", textDim: "rgba(255,255,255,0.3)",
  },
  sunset: {
    name: "暖橙黄", emoji: "🌅",
    bg: "#0e0a08", bg2: "rgba(26,20,16,0.94)", bg3: "rgba(22,18,14,0.92)",
    accent: "#f59e0b", accent2: "#ef4444", accentRgb: "245,158,11",
    surface: "rgba(255,255,255,0.04)", surfaceHi: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.5)", textDim: "rgba(255,255,255,0.3)",
  },
  light: {
    name: "极简白", emoji: "☀️",
    bg: "#fafafa", bg2: "rgba(255,255,255,0.96)", bg3: "rgba(248,248,250,0.95)",
    accent: "#6366f1", accent2: "#8b5cf6", accentRgb: "99,102,241",
    surface: "rgba(0,0,0,0.04)", surfaceHi: "rgba(0,0,0,0.06)",
    border: "rgba(0,0,0,0.08)", borderHi: "rgba(0,0,0,0.15)",
    text: "rgba(0,0,0,0.85)", textMuted: "rgba(0,0,0,0.55)", textDim: "rgba(0,0,0,0.35)",
  },
  graphite: {
    name: "石墨灰", emoji: "◼",
    bg: "#0b0d0f", bg2: "rgba(20,23,27,0.94)", bg3: "rgba(17,20,24,0.92)",
    accent: "#94a3b8", accent2: "#22d3ee", accentRgb: "148,163,184",
    surface: "rgba(255,255,255,0.045)", surfaceHi: "rgba(255,255,255,0.09)",
    border: "rgba(255,255,255,0.09)", borderHi: "rgba(255,255,255,0.17)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.56)", textDim: "rgba(255,255,255,0.34)",
  },
  lagoon: {
    name: "孔雀青", emoji: "◆",
    bg: "#06100f", bg2: "rgba(12,28,26,0.94)", bg3: "rgba(10,24,22,0.92)",
    accent: "#14b8a6", accent2: "#84cc16", accentRgb: "20,184,166",
    surface: "rgba(255,255,255,0.045)", surfaceHi: "rgba(255,255,255,0.085)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.15)",
    text: "rgba(255,255,255,0.92)", textMuted: "rgba(255,255,255,0.52)", textDim: "rgba(255,255,255,0.32)",
  },
  ember: {
    name: "曜石红", emoji: "✦",
    bg: "#100708", bg2: "rgba(30,16,18,0.94)", bg3: "rgba(26,14,16,0.92)",
    accent: "#ef4444", accent2: "#f97316", accentRgb: "239,68,68",
    surface: "rgba(255,255,255,0.045)", surfaceHi: "rgba(255,255,255,0.085)",
    border: "rgba(255,255,255,0.08)", borderHi: "rgba(255,255,255,0.16)",
    text: "rgba(255,255,255,0.93)", textMuted: "rgba(255,255,255,0.54)", textDim: "rgba(255,255,255,0.33)",
  },
  arctic: {
    name: "冰川银", emoji: "◇",
    bg: "#eef4f8", bg2: "rgba(255,255,255,0.96)", bg3: "rgba(241,247,250,0.96)",
    accent: "#0ea5e9", accent2: "#64748b", accentRgb: "14,165,233",
    surface: "rgba(15,23,42,0.045)", surfaceHi: "rgba(15,23,42,0.075)",
    border: "rgba(15,23,42,0.09)", borderHi: "rgba(15,23,42,0.16)",
    text: "rgba(15,23,42,0.88)", textMuted: "rgba(15,23,42,0.58)", textDim: "rgba(15,23,42,0.38)",
  },
};

// ─── Providers (只移除派欧云，其余链接直达官网/控制台，无邀请码) ───
const PROVIDERS = {
  grsai: { label: "GRSAI", url: "https://grsai.dakka.com.cn", color: "#10b981", keyUrl: "https://grsai.com/zh/dashboard/user-info" },
  apimart: { label: "APIMart", url: "https://api.apimart.ai", color: "#8b5cf6", keyUrl: "https://apimart.ai/zh/register" },
  runninghub: { label: "RunningHUB", url: "https://www.runninghub.cn", color: "#f59e0b", keyUrl: "https://www.runninghub.cn" },
  openai: { label: "OpenAI 兼容", url: "https://api.openai.com", color: "#6b7280", keyUrl: "https://platform.openai.com/api-keys" },
  custom: { label: "自定义 API", url: "", color: "#6366f1", keyUrl: "" },
  dreamina: { label: "即梦", color: "#ec4899", keyUrl: "" },
};

const IMAGE_MODELS = {
  grsai: [
    { id: "gpt-image-2", name: "GPT-image" },
    { id: "nano-banana-2", name: "Nano Banana 2" },
    { id: "nano-banana-pro", name: "Nano Banana Pro" },
    { id: "nano-banana-pro-vt", name: "Nano Banana Pro VT" },
    { id: "nano-banana-pro-cl", name: "Nano Banana Pro CL" },
  ],
  apimart: [
    { id: "apimart/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "apimart/gemini-3-flash-preview-nothinking", name: "Gemini 3 Flash" },
    { id: "apimart/seedream-5.0-lite", name: "Seedream V5 Lite" },
    { id: "apimart/seedream-4.5", name: "Seedream 4.5" },
    { id: "apimart/seedream-4.0", name: "Seedream 4.0" },
  ],
  runninghub: [
    { id: "runninghub-model/rhart-image-v1", name: "NanoBanana 低价版" },
    { id: "runninghub-model/rhart-image-v1-official", name: "NanoBanana 官方版" },
    { id: "runninghub-model/rhart-image-n-pro", name: "BananaPRO 低价版" },
    { id: "runninghub-model/rhart-image-n-pro-official", name: "BananaPRO 官方版" },
    { id: "runninghub-model/seedream-v5-lite", name: "Seedream V5 Lite" },
    { id: "runninghub-model/seedream-v4.5", name: "Seedream V4.5" },
  ],
  dreamina: [
    { id: "dreamina/5.0-lite", name: "即梦 5.0 Lite" },
    { id: "dreamina/5.0", name: "即梦 5.0" },
    { id: "dreamina/4.6", name: "即梦 4.6" },
    { id: "dreamina/4.5", name: "即梦 4.5" },
    { id: "dreamina/4.1", name: "即梦 4.1" },
    { id: "dreamina/4.0", name: "即梦 4.0" },
    { id: "dreamina/3.1", name: "即梦 3.1" },
    { id: "dreamina/3.0", name: "即梦 3.0" },
  ],
};

const TEXT_MODELS = {
  apimart: [
    { id: "apimart/deepseek-v3.2", name: "DeepSeek V3.2" },
    { id: "apimart/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "apimart/gemini-3-flash-preview-nothinking", name: "Gemini 3 Flash" },
  ],
  grsai: [{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }],
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  ],
  custom: [],
};

const VIDEO_MODELS = {
  dreamina: [
    { id: "dreamina/seedance2.0fast", name: "Seedance 2.0 Fast" },
    { id: "dreamina/seedance2.0fast_vip", name: "Seedance 2.0 Fast VIP" },
    { id: "dreamina/seedance2.0_vip", name: "Seedance 2.0 VIP" },
    { id: "dreamina/seedance2.0", name: "Seedance 2.0" },
  ],
  runninghub: [
    { id: "runninghub/2041741496667348994", name: "视频编辑V5.4" },
    { id: "runninghub/2041177685895946242", name: "LTX2.3" },
  ],
};

const AUDIO_MODELS = {
  custom: [{ id: "tts-1", name: "TTS 默认" }],
};

const DEFAULT_CUSTOM_API = {
  apiUrl: "https://api.openai.com",
  endpointPath: "/v1/chat/completions",
  apiKey: "",
  modelId: "",
  authType: "bearer",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  requestFormat: "openai",
  customBody: "",
  responsePath: "choices[0].message.content",
};

const DEFAULT_API_CFG = {
  grsai: { apiKey: "" },
  apimart: { apiKey: "" },
  runninghub: { apiKey: "", modelApiKey: "" },
  openai: { apiUrl: "https://api.openai.com", apiKey: "" },
  custom: DEFAULT_CUSTOM_API,
};

const normalizeDreaminaStatus = (d) => ({
  connected: d?.connected !== false,
  loggedIn: !!d?.loggedIn,
  label: d?.label || (d?.runtime?.phase === "error" ? "准备失败" : d?.loggedIn ? "已登录" : d?.running ? "未登录" : "待授权"),
  error: d?.error || d?.runtime?.lastError || "",
  phase: d?.runtime?.phase || "",
  authUrl: d?.authUrl || d?.verificationUriComplete || "",
  verificationUri: d?.verificationUri || "",
  userCode: d?.userCode || "",
  deviceCode: d?.deviceCode || "",
});

const mergeDreaminaStatus = (next, prev = {}) => {
  const normalized = normalizeDreaminaStatus(next);
  if(normalized.loggedIn) return normalized;
  return {
    ...normalized,
    authUrl: normalized.authUrl || prev.authUrl || "",
    verificationUri: normalized.verificationUri || prev.verificationUri || "",
    userCode: normalized.userCode || prev.userCode || "",
    deviceCode: normalized.deviceCode || prev.deviceCode || "",
  };
};

const readDreaminaResponse = async (res, fallback) => {
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data?.error || data?.runtime?.lastError || fallback);
  return data;
};

const ASSET_DB = "cherry-canvas-assets-v1";
const ASSET_STORE = "assets";

const openAssetDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(ASSET_DB, 1);
  req.onupgradeneeded = () => {
    if(!req.result.objectStoreNames.contains(ASSET_STORE)){
      req.result.createObjectStore(ASSET_STORE, { keyPath: "id" });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error("素材库打开失败"));
});

const assetTx = async (mode, fn) => {
  const db = await openAssetDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, mode);
    const store = tx.objectStore(ASSET_STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("素材库操作失败"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error || new Error("素材库事务失败")); };
  });
};

const putAsset = (asset) => assetTx("readwrite", store => store.put(asset));
const getAsset = (id) => id ? assetTx("readonly", store => store.get(id)).catch(() => null) : Promise.resolve(null);

const persistSourceAssetsInNodes = async (canvasNodes = []) => {
  const patches = new Map();
  for(const node of canvasNodes){
    if(node.type !== "source-image" || !node.imageUrl?.startsWith?.("data:") || node.assetId) continue;
    const assetId = `asset_${uid()}`;
    await putAsset({
      id: assetId,
      dataUrl: node.imageUrl,
      thumbUrl: await createImageThumbnail(node.imageUrl),
      fileName: node.fileName || node.name,
      fileSize: node.fileSize || 0,
      mimeType: node.mimeType || "",
      updatedAt: Date.now(),
    });
    patches.set(node.id, assetId);
  }
  if(!patches.size) return canvasNodes;
  return canvasNodes.map(node => {
    const assetId = patches.get(node.id);
    if(!assetId) return node;
    return {
      ...node,
      assetId,
      results: (node.results || []).map(result => ({ ...result, assetId })),
    };
  });
};

const stripSourceAssetPayload = (node) => {
  if(node.type === "source-image"){
    return {
      ...node,
      imageUrl: "",
      results: (node.results || []).map(r => ({
        ...r,
        url: r.url?.startsWith?.("data:") ? "" : r.url,
      })),
    };
  }
  if(node.type === "source-video" || node.type === "source-audio"){
    return {
      ...node,
      mediaUrl: "",
      results: (node.results || []).map(r => ({
        ...r,
        url: r.url?.startsWith?.("blob:") ? "" : r.url,
      })),
    };
  }
  return node;
};

const serializeCanvasNodes = (canvasNodes = []) => canvasNodes.map(stripSourceAssetPayload);
const hasUnpersistedSourceAssets = (canvasNodes = []) => canvasNodes.some(n => n.type === "source-image" && n.imageUrl?.startsWith?.("data:") && !n.assetId);

const DEFAULT_CANVAS_ID = "canvas_1";
const createCanvasRecord = (overrides = {}, index = 0) => ({
  id: overrides.id || `canvas_${uid()}`,
  name: overrides.name || (index === 0 ? "默认画布" : `新画布 ${index + 1}`),
  nodes: Array.isArray(overrides.nodes) ? overrides.nodes : [],
  edges: Array.isArray(overrides.edges) ? overrides.edges : [],
  savedAt: overrides.savedAt || Date.now(),
});

const normalizeCanvasStorage = (data = {}) => {
  const rawCanvases = Array.isArray(data.canvases) && data.canvases.length
    ? data.canvases
    : [createCanvasRecord({
        id: data.activeCanvasId || DEFAULT_CANVAS_ID,
        name: data.name || "默认画布",
        nodes: data.nodes || [],
        edges: data.edges || [],
        savedAt: data.savedAt,
      })];
  const canvases = rawCanvases.map((canvas, index) => createCanvasRecord(canvas, index));
  const activeCanvasId = canvases.some(c => c.id === data.activeCanvasId) ? data.activeCanvasId : canvases[0].id;
  return { canvases, activeCanvasId };
};

const serializeCanvasRecord = (canvas) => ({
  ...canvas,
  nodes: serializeCanvasNodes(canvas.nodes || []),
  edges: canvas.edges || [],
  savedAt: canvas.savedAt || Date.now(),
});

const hydrateSourceNodes = async (canvasNodes = []) => Promise.all(canvasNodes.map(async node => {
  if(!isSourceAssetType(node.type) || !node.assetId) return node;
  if(node.type !== "source-image" && (node.mediaUrl || node.text)) return node;
  const asset = await getAsset(node.assetId);
  if(!asset) return node;
  if(node.type === "source-video" || node.type === "source-audio"){
    const mediaUrl = asset.blob ? URL.createObjectURL(asset.blob) : "";
    if(!mediaUrl) return node;
    const result = {
      id: node.results?.[0]?.id || uid(),
      ts: node.results?.[0]?.ts || asset.updatedAt || Date.now(),
      url: mediaUrl,
      fileName: asset.fileName || node.fileName,
      assetId: node.assetId,
      data: { mimeType: asset.mimeType || node.mimeType, fileSize: asset.fileSize || node.fileSize },
    };
    return {
      ...node,
      mediaUrl,
      fileName: asset.fileName || node.fileName,
      fileSize: asset.fileSize || node.fileSize,
      mimeType: asset.mimeType || node.mimeType,
      genState: "done",
      results: [result],
    };
  }
  if(node.type === "source-text"){
    const text = asset.text || "";
    return {
      ...node,
      text,
      prompt: node.prompt || text,
      fileName: asset.fileName || node.fileName,
      fileSize: asset.fileSize || node.fileSize,
      mimeType: asset.mimeType || node.mimeType,
      genState: "done",
      results: [{ id: node.results?.[0]?.id || uid(), ts: asset.updatedAt || Date.now(), text, fileName: asset.fileName || node.fileName, assetId: node.assetId }],
    };
  }
  if(!asset?.dataUrl) return node;
  const thumbUrl = asset.thumbUrl || await createImageThumbnail(asset.dataUrl);
  if(!asset.thumbUrl && thumbUrl && thumbUrl !== asset.dataUrl){
    putAsset({ ...asset, thumbUrl }).catch(() => {});
  }
  const result = {
    id: node.results?.[0]?.id || uid(),
    ts: node.results?.[0]?.ts || asset.updatedAt || Date.now(),
    url: thumbUrl || asset.dataUrl,
    fileName: asset.fileName || node.fileName,
    assetId: node.assetId,
    data: { mimeType: asset.mimeType || node.mimeType, fileSize: asset.fileSize || node.fileSize },
  };
  return {
    ...node,
    imageUrl: thumbUrl || asset.dataUrl,
    fileName: asset.fileName || node.fileName,
    fileSize: asset.fileSize || node.fileSize,
    mimeType: asset.mimeType || node.mimeType,
    genState: "done",
    results: [result],
  };
}));

const mergeApiCfg = (stored = {}) => {
  const { ppio, ...rest } = stored || {};
  return {
    ...DEFAULT_API_CFG,
    ...rest,
    grsai: { ...DEFAULT_API_CFG.grsai, ...(rest.grsai || {}) },
    apimart: { ...DEFAULT_API_CFG.apimart, ...(rest.apimart || {}) },
    runninghub: { ...DEFAULT_API_CFG.runninghub, ...(rest.runninghub || {}) },
    openai: { ...DEFAULT_API_CFG.openai, ...(rest.openai || {}) },
    custom: { ...DEFAULT_CUSTOM_API, ...(rest.custom || {}) },
  };
};

const joinApiUrl = (baseUrl = "", endpointPath = "") => {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = String(endpointPath || "").trim();
  if(!path) return base;
  if(/^https?:\/\//i.test(path)) return path;
  return `${base}/${path.replace(/^\/+/, "")}`;
};

const withQueryParam = (url, key, value) => {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

const escapeForJsonTemplate = (value) => String(value)
  .replace(/\\/g, "\\\\")
  .replace(/"/g, '\\"')
  .replace(/\n/g, "\\n")
  .replace(/\r/g, "\\r");

const readResponsePath = (data, path) => {
  if(!path) return data?.text || data?.content;
  return path
    .split(/\[|\]|\./)
    .filter(Boolean)
    .reduce((o, k) => o?.[Number.isNaN(Number(k)) ? k : Number(k)], data);
};

const RATIOS = [{l:"1:1"},{l:"9:16"},{l:"16:9"},{l:"3:4"},{l:"4:3"},{l:"3:2"},{l:"2:3"}];
const VIDEO_DURATIONS = Array.from({ length: 12 }, (_, i) => i + 4);

// 节点尺寸增大
const NTYPES = {
  "ai-image":  { label: "图像生成", icon: "image", w: 380, h: 460, color: "indigo" },
  "ai-text":   { label: "文本生成", icon: "text", w: 360, h: 380, color: "blue" },
  "ai-video":  { label: "视频生成", icon: "video", w: 400, h: 440, color: "purple" },
  "ai-audio":  { label: "音频生成", icon: "audio", w: 360, h: 320, color: "cyan" },
  "source-image": { label: "素材图", icon: "image", w: 320, h: 340, color: "green" },
  "source-video": { label: "素材视频", icon: "video", w: 340, h: 300, color: "purple" },
  "source-audio": { label: "素材音频", icon: "audio", w: 320, h: 230, color: "cyan" },
  "source-text": { label: "文本素材", icon: "text", w: 340, h: 280, color: "blue" },
  "asset-folder": { label: "文件夹", icon: "folder", w: 360, h: 420, color: "gold" },
  "comment-note": { label: "便签", icon: "note", w: 300, h: 220, color: "gold" },
};

const COLOR_MAP = (theme) => ({
  indigo: theme.accent, blue: "#3b82f6", purple: "#8b5cf6", cyan: "#06b6d4",
  green: "#10b981", gold: "#f59e0b", pink: "#ec4899", red: "#ef4444"
});

const PRESETS = [
  { key: "refine", label: "润色优化", text: "请对以下内容进行润色和优化，使其更生动流畅：" },
  { key: "trans-en", label: "翻译为英文", text: "请将以下内容翻译为地道的英文：" },
  { key: "trans-cn", label: "翻译为中文", text: "请将以下内容翻译为流畅的中文：" },
  { key: "expand", label: "扩写", text: "请将以下内容扩写，增加细节和描写：" },
  { key: "summary", label: "总结", text: "请总结以下内容的核心要点：" },
  { key: "prompt-img", label: "图像提示词", text: "请将以下描述扩展为详细的 AI 图像生成提示词（英文，包含光线/构图/风格）：" },
];

const mkNode = (type, x, y, extra={}) => {
  const m = NTYPES[type];
  const defaults = type==="ai-image" ? { provider: "grsai", model: "nano-banana-pro", ratio: "1:1", count: 1 }
    : type==="ai-text" ? { provider: "openai", model: "gpt-4o-mini" }
    : type==="ai-video" ? { provider: "dreamina", model: "dreamina/seedance2.0fast", duration: 4, resolution: "720p" }
    : type==="ai-audio" ? { provider: "custom", model: "tts-1", voice: "默认" }
    : type==="source-image" ? { imageUrl: "", fileName: "", fileSize: 0, mimeType: "" }
    : type==="source-video" || type==="source-audio" ? { mediaUrl: "", fileName: "", fileSize: 0, mimeType: "" }
    : type==="source-text" ? { text: "", fileName: "", fileSize: 0, mimeType: "text/plain" }
    : type==="asset-folder" ? { files: [], counts: {}, expanded: false, expandedNodeIds: [] }
    : {};
  return {
    id: uid(), type, x, y, w: m.w, h: m.h, name: m.label, prompt: "",
    genState: "idle", genProgress: 0, results: [], error: null,
    ...defaults, ...extra
  };
};

// ─── Icons ───
const Icon = ({ name, size=14, c="currentColor", sw=2 }) => {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: c, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const icons = {
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></>,
    text: <><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></>,
    video: <><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></>,
    audio: <><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>,
    note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></>,
    map: <><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></>,
    fit: <><polyline points="4 14 4 20 10 20"/><polyline points="20 10 20 4 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></>,
    undo: <><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></>,
    redo: <><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></>,
    play: <polygon points="5 3 19 12 5 21 5 3" fill={c}/>,
    trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
    x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    folder: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></>,
    minus: <><line x1="5" y1="12" x2="19" y2="12"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    alert: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,
    key: <><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></>,
    spark: <><path d="M12 2l2.4 7.4L22 12l-7.6 2.6L12 22l-2.4-7.4L2 12l7.6-2.6z"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,
    palette: <><circle cx="13.5" cy="6.5" r=".5" fill={c}/><circle cx="17.5" cy="10.5" r=".5" fill={c}/><circle cx="8.5" cy="7.5" r=".5" fill={c}/><circle cx="6.5" cy="12.5" r=".5" fill={c}/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></>,
    code: <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>,
    refresh: <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></>,
    keyboard: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></>,
    info: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
    terminal: <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  };
  return <svg {...p}>{icons[name] || null}</svg>;
};

// ─── History reducer ───
function histR(st, a) {
  if(a.type==="push") return { ...st, nodes: a.n, edges: a.e, past: [...st.past.slice(-30), { n: st.nodes, e: st.edges }], future: [] };
  if(a.type==="commit") return { ...st, nodes: a.n, edges: a.e, past: [...st.past.slice(-30), { n: a.prevN, e: a.prevE }], future: [] };
  if(a.type==="set") return { ...st, nodes: a.n, edges: a.e };
  if(a.type==="setNodes") return { ...st, nodes: a.fn ? a.fn(st.nodes) : a.n };
  if(a.type==="load") return { nodes: a.n, edges: a.e, past: [], future: [] };
  if(a.type==="undo"&&st.past.length){ const p = st.past[st.past.length-1]; return { nodes: p.n, edges: p.e, past: st.past.slice(0,-1), future: [{ n: st.nodes, e: st.edges }, ...st.future.slice(0,30)] }; }
  if(a.type==="redo"&&st.future.length){ const f = st.future[0]; return { nodes: f.n, edges: f.e, past: [...st.past, { n: st.nodes, e: st.edges }], future: st.future.slice(1) }; }
  return st;
}

// ═══════ Main ═══════
export default function CherryCanvas() {
  const wrap = useRef(null);
  const [h, dp] = useReducer(histR, { nodes: [], edges: [], past: [], future: [] });
  const { nodes, edges } = h;
  
  const sN = useCallback((fn) => dp(typeof fn==="function" ? { type: "setNodes", fn } : { type: "setNodes", n: fn }), []);
  const push = useCallback((n,e) => dp({ type: "push", n, e }), []);

  const [themeKey, setThemeKey] = useState(() => {
    try {
      const saved = localStorage.getItem("cc-theme");
      if(saved && THEMES[saved]) return saved;
    } catch {}
    return "midnight";
  });
  const T = THEMES[themeKey];
  const COLORS = COLOR_MAP(T);

  // 多画布
  const [canvases, setCanvases] = useState([createCanvasRecord({ id: DEFAULT_CANVAS_ID, name: "默认画布" })]);
  const [activeCanvasId, setActiveCanvasId] = useState(DEFAULT_CANVAS_ID);

  // 视口与交互状态
  const [vp, setVp] = useState({ x: 120, y: 100, z: 0.75 });
  const [sel, setSel] = useState(new Set());
  const [drag, setDrag] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [pan, setPan] = useState(null);
  const [spacePan, setSpacePan] = useState(false);
  const [rzDrag, setRzDrag] = useState(null);
  const [edgeDraft, setEdgeDraft] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [hover, setHover] = useState(null); // 仅用于显示连接端口和工具栏，不影响选择
  const [edgeHover, setEdgeHover] = useState(null);
  
  // UI
  const [grid, setGrid] = useState(true);
  const [mm, setMm] = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("api");
  const [showProjects, setShowProjects] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showPreview, setShowPreview] = useState(null); // 大图预览
  const [showVideoPlayer, setShowVideoPlayer] = useState(null);
  const [showMention, setShowMention] = useState(null);
  const [showPreset, setShowPreset] = useState(null);
  const [showCustomAdvanced, setShowCustomAdvanced] = useState(false);
  const [dreaminaPollTick, setDreaminaPollTick] = useState(0);

  // API 配置
  const [apiCfg, setApiCfg] = useState(DEFAULT_API_CFG);
  const [dmStatus, setDmStatus] = useState({ connected: false, loggedIn: false, label: "未检测" });

  const [projects, setProjects] = useState([]);
  const [toast, setToast] = useState(null);

  const vpR = useRef(vp); vpR.current = vp;
  const nR = useRef(nodes); nR.current = nodes;
  const eR = useRef(edges); eR.current = edges;
  const selR = useRef(sel); selR.current = sel;
  const hoverR = useRef(hover); hoverR.current = hover;
  const lastPointerFrameR = useRef(0);
  const spacePanR = useRef(spacePan); spacePanR.current = spacePan;
  const apiR = useRef(apiCfg); apiR.current = apiCfg;
  const canvasesR = useRef(canvases); canvasesR.current = canvases;
  const activeCanvasIdR = useRef(activeCanvasId); activeCanvasIdR.current = activeCanvasId;
  const queriedDreaminaResults = useRef(new Map());
  const recoveringDreamina = useRef(false);
  const syncingDreaminaNodes = useRef(new Set());

  const toastFn = useCallback((msg, type="info") => {
    setToast({ msg, type, ts: Date.now() });
    setTimeout(() => setToast(t => (t && Date.now()-t.ts >= 2800) ? null : t), 3000);
  }, []);

  const refreshDreaminaStatus = useCallback(async ({ silent = false } = {}) => {
    try {
      const res = await fetch(`${API_BASE}/api/dreamina/status`, { signal: AbortSignal.timeout(15000) });
      const data = await readDreaminaResponse(res, "即梦状态检测失败");
      setDmStatus(prev => mergeDreaminaStatus(data, prev));
      if(!silent) toastFn("检测完成", "success");
    } catch (err) {
      const msg = err?.message || "即梦状态检测失败";
      setDmStatus({ connected: false, loggedIn: false, label: "服务未连接", error: msg });
      if(!silent) toastFn(msg, "error");
    }
  }, [toastFn]);

  const startDreaminaAuth = useCallback(async (path, pendingMsg) => {
    toastFn(pendingMsg, "info");
    let connected = false;
    try {
      const res = await fetch(`${API_BASE}${path}`, { method: "POST" });
      connected = true;
      const data = await readDreaminaResponse(res, "授权启动失败");
      setDmStatus(prev => mergeDreaminaStatus(data, prev));
      if(data?.authUrl) window.open(data.authUrl, "_blank", "noopener,noreferrer");
      toastFn(data?.userCode ? `授权页已打开，授权码：${data.userCode}` : "授权已发起，请按即梦页面提示继续", "success");
    } catch (err) {
      const msg = err?.message || "授权启动失败";
      setDmStatus({ connected, loggedIn: false, label: connected ? "准备失败" : "服务未连接", error: msg });
      toastFn(msg, "error");
    }
  }, [toastFn]);

  // ─── Load saved ───
  const syncDreaminaNodeResult = useCallback(async (nodeId) => {
    if(syncingDreaminaNodes.current.has(nodeId)) return false;
    const node = nR.current.find(n => n.id === nodeId);
    if(!node) return false;
    const isDreaminaLike = /dreamina|jimeng|即梦|seedance/i.test(`${node.provider || ""} ${node.model || ""}`);
    if(!isDreaminaLike || !(node.type === "ai-video" || node.type === "ai-image")) return false;
    syncingDreaminaNodes.current.add(nodeId);
    const applyResult = (submitId, data) => {
      const resolvedUrl = resultMediaUrlOf(data, node.type);
      const resolvedPoster = node.type === "ai-video" ? playableVideoPosterOf({ ...data, url: resolvedUrl, submitId }) : resultPosterOf({ ...data, url: resolvedUrl });
      const failed = resultFailed(data);
      const failReason = resultFailReasonOf(data) || "即梦生成失败";
      sN(ns => ns.map(n => {
        if(n.id !== nodeId) return n;
        let patched = false;
        const nextResults = (n.results || []).map(result => {
          const rid = resultSubmitIdOf(result);
          if(patched || (rid && submitId && rid !== submitId && resultMediaUrlOf(result, n.type))) return result;
          if(rid && submitId && rid !== submitId && !resolvedUrl) return result;
          patched = true;
          return {
            ...result,
            submitId: submitId || rid,
            url: resolvedUrl || resultMediaUrlOf(result, n.type),
            poster: resolvedPoster || resultPosterOf(result),
            text: data?.text || result.text,
            data: { ...(result.data || {}), ...data, url: resolvedUrl || resultMediaUrlOf(result, n.type), poster: resolvedPoster || resultPosterOf(result) },
          };
        });
        if(!patched){
          nextResults.push({
            id: uid(),
            ts: Date.now(),
            submitId,
            url: resolvedUrl,
            poster: resolvedPoster,
            text: data?.text || `即梦任务同步中：${submitId}`,
            data,
          });
        }
        return {
          ...n,
          genState: failed ? "error" : (resolvedUrl ? "done" : n.genState),
          genProgress: resolvedUrl ? 100 : Math.max(n.genProgress || 0, 95),
          error: failed ? failReason : (resolvedUrl ? null : n.error),
          results: nextResults,
        };
      }));
      return !!resolvedUrl || failed;
    };
    try {
      const knownIds = [...new Set((node.results || []).map(resultSubmitIdOf).filter(Boolean))];
      for(const submitId of knownIds){
        const res = await fetch(`${API_BASE}/api/dreamina/result?submitId=${encodeURIComponent(submitId)}&timeoutMs=60000`);
        const data = await res.json().catch(() => ({}));
        if(res.ok && applyResult(submitId, data)) return true;
      }
      const taskRes = await fetch(`${API_BASE}/api/dreamina/tasks?limit=50`);
      const taskData = await taskRes.json().catch(() => ({}));
      const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
      const corePrompt = String(node.prompt || "").replace(/@\[([^\]]+)\]/g, "").replace(/\s+/g, " ").trim();
      const mentionedIds = new Set([
        ...[...String(node.prompt || "").matchAll(/@\[([^\]]+)\]/g)].map(m => m[1]),
        ...eR.current.filter(e => e.targetId === node.id).map(e => e.sourceId),
      ]);
      const refNames = [...mentionedIds].map(id => nR.current.find(n => n.id === id)?.name || nR.current.find(n => n.id === id)?.title).filter(Boolean);
      const scoreTask = (task = {}) => {
        const status = String(task.gen_status || task.status || "");
        const taskType = String(task.gen_task_type || "");
        const prompt = String(task.prompt || "");
        const taskId = task.submit_id || task.submitId || "";
        let score = 0;
        if(node.type === "ai-video" && taskType.includes("video")) score += 80;
        if(node.type === "ai-image" && taskType.includes("image")) score += 80;
        if(corePrompt && prompt.includes(corePrompt)) score += 80;
        if(knownIds.includes(taskId) && status !== "fail") score += 1000;
        if(status === "success") score += 320;
        else if(status === "querying") score += 180;
        else if(status === "fail") score -= 500;
        refNames.forEach(name => { if(prompt.includes(name)) score += 180; });
        return score;
      };
      const task = tasks
        .filter(t => (t.submit_id || t.submitId) && scoreTask(t) > 0)
        .sort((a, b) => scoreTask(b) - scoreTask(a))[0];
      if(!task) return false;
      const submitId = task.submit_id || task.submitId;
      if(task.gen_status === "fail"){
        sN(ns => ns.map(n => n.id === nodeId ? { ...n, genState: "error", error: task.fail_reason || "即梦生成失败" } : n));
        return false;
      }
      applyResult(submitId, { data: task, submitId, submit_id: submitId, text: `即梦任务同步中：${submitId}` });
      if(String(task.gen_status || "") === "success"){
        const res = await fetch(`${API_BASE}/api/dreamina/result?submitId=${encodeURIComponent(submitId)}&timeoutMs=60000`);
        const data = await res.json().catch(() => ({}));
        if(res.ok && applyResult(submitId, data)) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      syncingDreaminaNodes.current.delete(nodeId);
    }
  }, [sN]);

  useEffect(() => {
    let alive = true;
    try { const s = localStorage.getItem("cc-api-v3"); if(s) setApiCfg(mergeApiCfg(JSON.parse(s))); } catch{}
    try {
      const s = localStorage.getItem("cc-canvas-v3");
      if(s){
        const d = JSON.parse(s);
        const stored = normalizeCanvasStorage(d);
        const activeCanvas = stored.canvases.find(c => c.id === stored.activeCanvasId) || stored.canvases[0];
        setCanvases(stored.canvases);
        setActiveCanvasId(stored.activeCanvasId);
        const loadedNodes = activeCanvas.nodes || [];
        dp({ type: "load", n: loadedNodes, e: activeCanvas.edges || [] });
        hydrateSourceNodes(loadedNodes).then(hydrated => {
          if(alive) dp({ type: "load", n: hydrated, e: activeCanvas.edges || [] });
        });
      }
    } catch{}
    try { const s = localStorage.getItem("cc-projects-v3"); if(s) setProjects(JSON.parse(s)); } catch{}
    refreshDreaminaStatus({ silent: true });
    return () => { alive = false; };
  }, [refreshDreaminaStatus]);

  useEffect(() => {
    if(dmStatus.loggedIn || !(dmStatus.phase === "authorizing" || dmStatus.userCode)) return;
    const t = setInterval(() => refreshDreaminaStatus({ silent: true }), 5000);
    return () => clearInterval(t);
  }, [dmStatus.loggedIn, dmStatus.phase, dmStatus.userCode, refreshDreaminaStatus]);

  useEffect(() => {
    const run = () => {
      nR.current
        .filter(n => (n.type === "ai-video" || n.type === "ai-image")
          && /dreamina|jimeng|即梦|seedance/i.test(`${n.provider || ""} ${n.model || ""}`)
          && n.genState === "generating"
          && (n.genProgress || 0) >= 90
          && !(n.results || []).some(result => resultMediaUrlOf(result, n.type)))
        .forEach(n => syncDreaminaNodeResult(n.id));
    };
    run();
    const t = setInterval(run, 5000);
    return () => clearInterval(t);
  }, [syncDreaminaNodeResult]);

  useEffect(() => { try { localStorage.setItem("cc-api-v3", JSON.stringify(apiCfg)); } catch{} }, [apiCfg]);
  useEffect(() => { try { localStorage.setItem("cc-theme", themeKey); } catch{} }, [themeKey]);
  useEffect(() => {
    const pending = nodes.filter(n => n.type === "source-image" && n.imageUrl?.startsWith?.("data:") && !n.assetId);
    if(!pending.length) return;
    let alive = true;
    (async () => {
      const patches = new Map();
      for(const n of pending){
        const assetId = `asset_${uid()}`;
        await putAsset({
          id: assetId,
          dataUrl: n.imageUrl,
          thumbUrl: await createImageThumbnail(n.imageUrl),
          fileName: n.fileName || n.name,
          fileSize: n.fileSize || 0,
          mimeType: n.mimeType || "",
          updatedAt: Date.now(),
        });
        patches.set(n.id, assetId);
      }
      if(!alive || !patches.size) return;
      sN(ns => ns.map(n => {
        const assetId = patches.get(n.id);
        if(!assetId) return n;
        return {
          ...n,
          assetId,
          results: (n.results || []).map(r => ({ ...r, assetId })),
        };
      }));
    })().catch(() => {});
    return () => { alive = false; };
  }, [nodes, sN]);
  useEffect(() => {
    const pending = [];
    const now = Date.now();
    nodes.forEach(node => {
      (node.results || []).forEach(result => {
        if(resultFailed(result)) return;
        const submitId = resultSubmitIdOf(result);
        const currentUrl = resultMediaUrlOf(result, node.type);
        const currentPoster = node.type === "ai-video" ? playableVideoPosterOf(result) : resultPosterOf(result);
        const needsMedia = !currentUrl || (node.type === "ai-video" && !currentPoster);
        const pollState = queriedDreaminaResults.current.get(submitId) || {};
        if(submitId && needsMedia && !pollState.inFlight && (pollState.nextAt || 0) <= now && (pollState.attempts || 0) < 90){
          pending.push({ nodeId: node.id, nodeType: node.type, resultId: result.id, submitId });
        }
      });
    });
    if(!pending.length) return;
    pending.slice(0, 3).forEach(item => {
      const prevPoll = queriedDreaminaResults.current.get(item.submitId) || {};
      queriedDreaminaResults.current.set(item.submitId, { ...prevPoll, inFlight: true, attempts: (prevPoll.attempts || 0) + 1 });
      const timeoutMs = item.nodeType === "ai-video" ? 60000 : 20000;
      fetch(`${API_BASE}/api/dreamina/result?submitId=${encodeURIComponent(item.submitId)}&timeoutMs=${timeoutMs}`)
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(data?.error || "查询即梦结果失败");
          return data;
        })
        .then(data => {
          const resolvedUrl = resultMediaUrlOf(data, item.nodeType);
          const failed = resultFailed(data);
          if(!resolvedUrl && !failed) return;
          const resolvedPoster = item.nodeType === "ai-video" ? playableVideoPosterOf({ ...data, url: resolvedUrl, submitId: item.submitId }) : resultPosterOf({ ...data, url: resolvedUrl });
          const failReason = resultFailReasonOf(data) || "即梦生成失败";
          queriedDreaminaResults.current.delete(item.submitId);
          sN(ns => ns.map(node => node.id !== item.nodeId ? node : {
            ...node,
            genState: failed ? "error" : "done",
            genProgress: resolvedUrl ? 100 : Math.max(node.genProgress || 0, 95),
            error: failed ? failReason : null,
            results: (node.results || []).map(result => result.id !== item.resultId ? result : {
              ...result,
              url: resolvedUrl,
              poster: resolvedPoster || resultPosterOf(result),
              submitId: data.submitId || data.submit_id || resultSubmitIdOf(result),
              text: data.text || result.text,
              data: { ...(result.data || {}), ...data, url: resolvedUrl, poster: resolvedPoster },
            }),
          }));
        })
        .catch(() => {})
        .finally(() => {
          if(!queriedDreaminaResults.current.has(item.submitId)) return;
          const current = queriedDreaminaResults.current.get(item.submitId) || {};
          queriedDreaminaResults.current.set(item.submitId, { ...current, inFlight: false, nextAt: Date.now() + 5000 });
          setTimeout(() => setDreaminaPollTick(t => t + 1), 5200);
        });
    });
  }, [nodes, edges, sN, dreaminaPollTick]);

  useEffect(() => {
    const latestHasMedia = (n) => {
      const latest = n.results?.[n.results.length - 1];
      return !!latest && (resultFailed(latest) || !!resultMediaUrlOf(latest, n.type) || (n.type === "ai-video" && !!playableVideoUrlOf(latest)));
    };
    const stuckWithMedia = nodes.filter(n => (n.type === "ai-video" || n.type === "ai-image") && n.genState === "generating" && latestHasMedia(n));
    if(!stuckWithMedia.length) return;
    const ids = new Set(stuckWithMedia.map(n => n.id));
    sN(ns => ns.map(n => {
      if(!ids.has(n.id)) return n;
      const latest = n.results?.[n.results.length - 1];
      if(resultFailed(latest)) return { ...n, genState: "error", error: resultFailReasonOf(latest) || "即梦生成失败" };
      return { ...n, genState: "done", genProgress: 100, error: null };
    }));
  }, [nodes, sN]);

  useEffect(() => {
    const isDreaminaLike = (n) => /dreamina|jimeng|鍗虫ⅵ|seedance/i.test(`${n.provider || ""} ${n.model || ""}`);
    const pendingIds = new Set(nodes
      .filter(n => (n.type === "ai-video" || n.type === "ai-image") && isDreaminaLike(n))
      .filter(n => {
        const latest = n.results?.[n.results.length - 1];
        return latest
          && resultSubmitIdOf(latest)
          && !resultFailed(latest)
          && !resultSucceeded(latest)
          && !resultMediaUrlOf(latest, n.type)
          && !(n.type === "ai-video" && playableVideoUrlOf(latest))
          && n.genState !== "generating";
      })
      .map(n => n.id));
    if(!pendingIds.size) return;
    sN(ns => ns.map(n => pendingIds.has(n.id) ? { ...n, genState: "generating", genProgress: Math.max(n.genProgress || 0, 95), error: null } : n));
  }, [nodes, sN]);

  useEffect(() => {
    const isDreaminaLike = (n) => /dreamina|jimeng|即梦|seedance/i.test(`${n.provider || ""} ${n.model || ""}`);
    const stuck = nodes.filter(n => (n.type === "ai-video" || n.type === "ai-image") && isDreaminaLike(n) && n.genState === "generating" && (n.genProgress || 0) >= 90 && !(n.results || []).some(result => resultMediaUrlOf(result, n.type)));
    if(!stuck.length || recoveringDreamina.current) return;
    recoveringDreamina.current = true;
    fetch(`${API_BASE}/api/dreamina/tasks?limit=50`)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data?.error || "list_task failed");
        return Array.isArray(data.tasks) ? data.tasks : [];
      })
      .then(tasks => {
        if(!tasks.length) return;
        const directQueries = [];
        const stuckIds = new Set(stuck.map(n => n.id));
        const nodeById = new Map(nodes.map(item => [item.id, item]));
        const taskIdOf = (task = {}) => task.submit_id || task.submitId || "";
        const statusOf = (task = {}) => String(task.gen_status || task.status || "");
        sN(ns => ns.map(n => {
          if(!stuckIds.has(n.id) || (n.results || []).some(result => resultMediaUrlOf(result, n.type))) return n;
          const corePrompt = String(n.prompt || "").replace(/@\[([^\]]+)\]/g, "").replace(/\s+/g, " ").trim();
          const wantsVideo = n.type === "ai-video";
          const currentSubmitIds = new Set((n.results || []).map(resultSubmitIdOf).filter(Boolean));
          const mentionedIds = new Set([
            ...[...String(n.prompt || "").matchAll(/@\[([^\]]+)\]/g)].map(m => m[1]),
            ...edges.filter(e => e.targetId === n.id).map(e => e.sourceId),
          ]);
          const refNames = [...mentionedIds].map(id => nodeById.get(id)?.name || nodeById.get(id)?.title).filter(Boolean);
          const candidateTasks = tasks.filter(t => {
            const taskType = String(t.gen_task_type || "");
            const typeOk = wantsVideo ? taskType.includes("video") : taskType.includes("image");
            const promptOk = !corePrompt || String(t.prompt || "").includes(corePrompt);
            return typeOk && promptOk && (t.submit_id || t.submitId);
          });
          const scoreTask = (task) => {
            const status = statusOf(task);
            const prompt = String(task.prompt || "");
            let score = 0;
            if(currentSubmitIds.has(taskIdOf(task)) && status !== "fail") score += 1000;
            if(status === "success") score += 320;
            else if(status === "querying") score += 220;
            else if(status === "fail") score -= 500;
            refNames.forEach(name => { if(prompt.includes(name)) score += 180; });
            return score;
          };
          const task = candidateTasks.sort((a, b) => scoreTask(b) - scoreTask(a))[0];
          if(!task) return n;
          const submitId = taskIdOf(task);
          const mediaUrl = resultMediaUrlOf({ data: task }, n.type);
          const mediaPoster = n.type === "ai-video" ? playableVideoPosterOf({ data: task, submitId }) : resultPosterOf({ data: task });
          if(!mediaUrl && statusOf(task) === "success") directQueries.push({ nodeId: n.id, nodeType: n.type, submitId });
          let patched = false;
          const patchedResults = (n.results || []).map(result => {
            if(patched || resultMediaUrlOf(result, n.type)) return result;
            patched = true;
            return {
              ...result,
              data: { ...(result.data || {}), ...task },
              text: `即梦任务同步中：${submitId}`,
              submitId,
              url: mediaUrl,
              poster: mediaPoster,
            };
          });
          if(!patched){
            patchedResults.push({
              id: uid(),
              ts: Date.now(),
              data: task,
              text: `即梦任务同步中：${submitId}`,
              submitId,
              url: mediaUrl,
              poster: mediaPoster,
            });
          }
          if(task.gen_status === "fail") return { ...n, genState: "error", error: task.fail_reason || "即梦生成失败" };
          return {
            ...n,
            genState: mediaUrl ? "done" : "generating",
            genProgress: mediaUrl ? 100 : Math.max(n.genProgress || 0, 95),
            results: patchedResults,
          };
        }));
        directQueries.forEach(item => {
          const pollKey = `recover:${item.submitId}`;
          const prevPoll = queriedDreaminaResults.current.get(pollKey) || {};
          if(prevPoll.inFlight) return;
          queriedDreaminaResults.current.set(pollKey, { inFlight: true });
          fetch(`${API_BASE}/api/dreamina/result?submitId=${encodeURIComponent(item.submitId)}&timeoutMs=60000`)
            .then(async res => {
              const data = await res.json().catch(() => ({}));
              if(!res.ok) throw new Error(data?.error || "查询即梦结果失败");
              return data;
            })
            .then(data => {
              const resolvedUrl = resultMediaUrlOf(data, item.nodeType);
              const failed = resultFailed(data);
              if(!resolvedUrl && !failed) return;
              const resolvedPoster = item.nodeType === "ai-video" ? playableVideoPosterOf({ ...data, url: resolvedUrl, submitId: item.submitId }) : resultPosterOf({ ...data, url: resolvedUrl });
              const failReason = resultFailReasonOf(data) || "即梦生成失败";
              sN(ns => ns.map(node => node.id !== item.nodeId ? node : {
                ...node,
                genState: failed ? "error" : "done",
                genProgress: resolvedUrl ? 100 : Math.max(node.genProgress || 0, 95),
                error: failed ? failReason : null,
                results: (node.results || []).map(result => resultSubmitIdOf(result) && resultSubmitIdOf(result) !== item.submitId ? result : {
                  ...result,
                  submitId: item.submitId,
                  url: resolvedUrl,
                  poster: resolvedPoster || resultPosterOf(result),
                  text: data.text || result.text,
                  data: { ...(result.data || {}), ...data, url: resolvedUrl, poster: resolvedPoster },
                }),
              }));
            })
            .finally(() => queriedDreaminaResults.current.delete(pollKey));
        });
        setDreaminaPollTick(t => t + 1);
      })
      .catch(() => {})
      .finally(() => {
        recoveringDreamina.current = false;
        setTimeout(() => setDreaminaPollTick(t => t + 1), 8000);
      });
  }, [nodes, edges, sN, dreaminaPollTick]);

  useEffect(() => {
    const t = setTimeout(() => {
      if(hasUnpersistedSourceAssets(nodes)) return;
      const savedCanvases = canvases.map(c => c.id === activeCanvasId
        ? serializeCanvasRecord({ ...c, nodes, edges, savedAt: Date.now() })
        : serializeCanvasRecord(c)
      );
      const activeCanvas = savedCanvases.find(c => c.id === activeCanvasId) || savedCanvases[0];
      try {
        localStorage.setItem("cc-canvas-v3", JSON.stringify({
          version: "3.1",
          activeCanvasId,
          canvases: savedCanvases,
          nodes: activeCanvas?.nodes || [],
          edges: activeCanvas?.edges || [],
        }));
      } catch{}
    }, 1000);
    return () => clearTimeout(t);
  }, [nodes, edges, canvases, activeCanvasId]);

  // ─── Wheel ───
  useEffect(() => {
    const el = wrap.current; if(!el) return;
    const fn = (e) => {
      // 在输入框上时允许默认行为
      if(["TEXTAREA","INPUT","SELECT"].includes(e.target.tagName)){
        // 但仍然让画布缩放
        if(!e.ctrlKey && !e.metaKey) return;
      }
      e.preventDefault();
      const v = vpR.current;
      if(e.ctrlKey || e.metaKey){
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const cx = (mx - v.x) / v.z, cy = (my - v.y) / v.z;
        const nz = clamp(v.z * Math.exp(-e.deltaY * 0.002), MIN_Z, MAX_Z);
        setVp({ x: mx - cx * nz, y: my - cy * nz, z: nz });
      } else {
        setVp(p => ({ ...p, x: p.x + (e.shiftKey ? -e.deltaY : -e.deltaX), y: p.y + (e.shiftKey ? 0 : -e.deltaY) }));
      }
    };
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);

  // ─── Hit test (修复版) ───
  const hit = useCallback((sx, sy) => {
    const pt = s2c(sx, sy, vpR.current);
    for(let i = nR.current.length-1; i >= 0; i--){
      const n = nR.current[i];
      if(inR({ x: n.x, y: n.y, w: n.w, h: n.h }, pt.x, pt.y)) return n;
    }
    return null;
  }, []);

  // ─── 修复: Pointer events ───
  const onDown = useCallback((e) => {
    // 关键 fix: 只在确实可交互的元素上阻止
    const tgt = e.target;
    const tagName = tgt.tagName;
    if(spacePanR.current && e.button === 0){
      e.preventDefault();
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
      setCtxMenu(null);
      setShowAddMenu(false);
      setShowMention(null);
      setShowPreset(null);
      setPan({ sx: e.clientX, sy: e.clientY, vx: vpR.current.x, vy: vpR.current.y, mode: "space" });
      return;
    }
    const port = tgt.closest("[data-port]");
    if(port){
      if(e.button !== 0) return;
      const r = wrap.current.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
      setCtxMenu(null);
      setShowAddMenu(false);
      setShowMention(null);
      setShowPreset(null);

      const nid = port.closest("[data-nid]")?.dataset.nid;
      const nd = nR.current.find(n => n.id === nid);
      if(nd && port.dataset.port === "out"){
        const cp = s2c(sx, sy, vpR.current);
        setEdgeDraft({ fid: nid, fx: nd.x + nd.w, fy: nd.y + nd.h/2, tx: cp.x, ty: cp.y });
      }
      return;
    }
    
    // Resize must win over generic interactive blocking.
    const resizeHandle = tgt.closest("[data-rz]");
    if(resizeHandle){
      if(e.button !== 0) return;
      const r = wrap.current.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
      setCtxMenu(null);
      setShowAddMenu(false);
      setShowMention(null);
      setShowPreset(null);
      const nid = resizeHandle.closest("[data-nid]")?.dataset.nid;
      const nd = nR.current.find(n => n.id === nid);
      if(nd) setRzDrag({ nid, sw: nd.w, sh: nd.h, sx: e.clientX, sy: e.clientY, beforeNodes: nR.current, beforeEdges: eR.current });
      return;
    }
    if(tgt.closest("[data-interactive]")) return;
    if(["TEXTAREA","INPUT","SELECT","BUTTON","A"].includes(tagName)) return;
    
    const r = wrap.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    
    setCtxMenu(null);
    setShowAddMenu(false);
    setShowMention(null);
    setShowPreset(null);
    
    // 中键 → pan
    if(e.button === 1){ e.preventDefault(); setPan({ sx: e.clientX, sy: e.clientY, vx: vpR.current.x, vy: vpR.current.y }); return; }
    if(e.button !== 0) return;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
    
    // Resize handle
    const rh = tgt.closest("[data-rz]");
    if(rh){
      const nid = rh.closest("[data-nid]")?.dataset.nid;
      const nd = nR.current.find(n => n.id === nid);
      if(nd) setRzDrag({ nid, sw: nd.w, sh: nd.h, sx: e.clientX, sy: e.clientY, beforeNodes: nR.current, beforeEdges: eR.current });
      return;
    }
    
    // Hit test 节点；节点外露的徽标也算作所属节点的拖拽区域。
    const directNid = tgt.closest("[data-nid]")?.dataset.nid;
    const directNode = nR.current.find(n => n.id === directNid);
    const ht = directNode || hit(sx, sy);
    
    if(ht){
      // 🔧 修复选择逻辑：基于点击的明确意图
      const nx = new Set(selR.current);
      if(e.shiftKey || e.ctrlKey || e.metaKey){
        if(nx.has(ht.id)) nx.delete(ht.id);
        else nx.add(ht.id);
      } else if(!nx.has(ht.id)){
        nx.clear();
        nx.add(ht.id);
      }
      setSel(nx);
      
      const cp = s2c(sx, sy, vpR.current);
      const draggable = new Set(nx);
      if(!draggable.has(ht.id)){ draggable.clear(); draggable.add(ht.id); }
      
      setDrag({
        sx: cp.x, sy: cp.y,
        starts: new Map(nR.current.filter(n => draggable.has(n.id)).map(n => [n.id, { x: n.x, y: n.y }])),
        hitId: ht.id,
        moved: false,
        beforeNodes: nR.current,
        beforeEdges: eR.current,
      });
    } else {
      // 点击空白：不立即清空，等待 onUp 判断是否是 marquee
      if(!e.shiftKey && !e.ctrlKey && !e.metaKey) setSel(new Set());
      const cp = s2c(sx, sy, vpR.current);
      setMarquee({ x1: cp.x, y1: cp.y, x2: cp.x, y2: cp.y, hadMove: false });
    }
  }, [hit]);

  const onMove = useCallback((e) => {
    const now = performance.now();
    if((pan || rzDrag || edgeDraft || drag || marquee) && now - lastPointerFrameR.current < 16) return;
    lastPointerFrameR.current = now;
    const r = wrap.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const cp = s2c(sx, sy, vpR.current);
    
    if(pan){
      setVp(v => ({ ...v, x: pan.vx + e.clientX - pan.sx, y: pan.vy + e.clientY - pan.sy }));
      return;
    }
    
    if(rzDrag){
      const dx = (e.clientX - rzDrag.sx) / vpR.current.z;
      const dy = (e.clientY - rzDrag.sy) / vpR.current.z;
      sN(ns => ns.map(n => n.id === rzDrag.nid ? { ...n, w: Math.max(220, rzDrag.sw + dx), h: Math.max(180, rzDrag.sh + dy) } : n));
      return;
    }
    
    if(edgeDraft){ setEdgeDraft(d => d ? { ...d, tx: cp.x, ty: cp.y } : null); return; }
    
    if(drag){
      const dx = cp.x - drag.sx, dy = cp.y - drag.sy;
      if(!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      sN(ns => ns.map(n => {
        const s = drag.starts.get(n.id);
        if(!s) return n;
        return { ...n, x: grid ? snap(s.x + dx, GRID) : s.x + dx, y: grid ? snap(s.y + dy, GRID) : s.y + dy };
      }));
      setDrag(d => d ? { ...d, moved: true } : null);
      return;
    }
    
    if(marquee){
      const dxm = Math.abs(cp.x - marquee.x1), dym = Math.abs(cp.y - marquee.y1);
      // 🔧 fix: 移动超过阈值才认为是框选
      if(dxm + dym > 4){
        setMarquee(m => m ? { ...m, x2: cp.x, y2: cp.y, hadMove: true } : null);
        const sr = { x: Math.min(marquee.x1, cp.x), y: Math.min(marquee.y1, cp.y), w: Math.abs(cp.x - marquee.x1), h: Math.abs(cp.y - marquee.y1) };
        setSel(new Set(nR.current.filter(n => olap(sr, { x: n.x, y: n.y, w: n.w, h: n.h })).map(n => n.id)));
      }
      return;
    }
    
    // 🔧 hover 只更新端口/工具栏显示，不触发选中
    const nextHover = hit(sx, sy)?.id || null;
    if(nextHover !== hoverR.current){
      hoverR.current = nextHover;
      setHover(nextHover);
    }
  }, [pan, rzDrag, edgeDraft, drag, marquee, grid, hit, sN]);

  const onUp = useCallback((e) => {
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
    if(edgeDraft){
      const r = wrap.current.getBoundingClientRect();
      const ht = hit(e.clientX - r.left, e.clientY - r.top);
      if(ht && ht.id !== edgeDraft.fid && !eR.current.some(ed => ed.sourceId === edgeDraft.fid && ed.targetId === ht.id)){
        push(nR.current, [...eR.current, { id: uid(), sourceId: edgeDraft.fid, targetId: ht.id, createdAt: Date.now() }]);
        toastFn("已连接", "success");
      }
      setEdgeDraft(null);
    }
    if(drag){
      if(drag.moved) dp({ type: "commit", n: nR.current, e: eR.current, prevN: drag.beforeNodes, prevE: drag.beforeEdges });
    }
    if(rzDrag) dp({ type: "commit", n: nR.current, e: eR.current, prevN: rzDrag.beforeNodes, prevE: rzDrag.beforeEdges });
    setDrag(null); setMarquee(null); setPan(null); setRzDrag(null);
  }, [edgeDraft, drag, rzDrag, hit, toastFn, push]);

  const onCtx = useCallback((e) => {
    if(["TEXTAREA","INPUT","SELECT"].includes(e.target.tagName)) return;
    e.preventDefault();
    const r = wrap.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    setCtxMenu({ sx, sy, ...s2c(sx, sy, vpR.current) });
  }, []);

  const addSourceImages = useCallback(async (files, cx, cy) => {
    const images = Array.from(files || []).filter(isImageFile);
    if(!images.length){ toastFn("请拖入图片文件", "error"); return; }
    const m = NTYPES["source-image"];
    const created = [];
    const existingCount = nR.current.filter(n => n.type === "source-image").length;
    for(let i=0; i<images.length; i++){
      const file = images[i];
      try {
        const imageUrl = await readFileAsDataUrl(file);
        const thumbUrl = await createImageThumbnail(file);
        const assetId = `asset_${uid()}`;
        await putAsset({ id: assetId, dataUrl: imageUrl, thumbUrl, fileName: file.name, fileSize: file.size, mimeType: file.type, updatedAt: Date.now() });
        const x = grid ? snap(cx - m.w/2 + i * 36, GRID) : cx - m.w/2 + i * 36;
        const y = grid ? snap(cy - m.h/2 + i * 36, GRID) : cy - m.h/2 + i * 36;
        const displayName = sourceDisplayName(file.name, existingCount + i + 1);
        const result = { id: uid(), ts: Date.now(), url: thumbUrl || imageUrl, fileName: file.name, assetId, data: { mimeType: file.type, fileSize: file.size } };
        created.push(mkNode("source-image", x, y, {
          name: displayName,
          assetId,
          imageUrl: thumbUrl || imageUrl,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          genState: "done",
          results: [result],
        }));
      } catch(err) {
        toastFn(`${file.name || "图片"} 读取失败`, "error");
      }
    }
    if(!created.length) return;
    push([...nR.current, ...created], eR.current);
    setSel(new Set(created.map(n => n.id)));
    setCtxMenu(null);
    setShowAddMenu(false);
    toastFn(`已导入 ${created.length} 张素材图`, "success");
  }, [grid, push, toastFn]);

  const addFolderAssetNode = useCallback(async (entries, cx, cy, folderName = "导入素材") => {
    const supported = Array.from(entries || [])
      .filter(item => item?.file && isSupportedAssetFile(item.file))
      .sort(naturalFileCompare);
    if(!supported.length){
      toastFn("这个文件夹里暂时没有可用素材", "error");
      return;
    }
    toastFn(`正在整理 ${supported.length} 个素材...`, "info");
    const files = [];
    for(let i = 0; i < supported.length; i++){
      const item = supported[i];
      const file = item.file;
      const kind = fileKindOf(file);
      const assetId = `asset_${uid()}`;
      const baseAsset = {
        id: assetId,
        kind,
        fileName: file.name,
        path: item.path || file.name,
        fileSize: file.size || 0,
        mimeType: file.type || "",
        updatedAt: Date.now(),
      };
      try {
        if(kind === "image"){
          const dataUrl = await readFileAsDataUrl(file);
          const thumbUrl = await createImageThumbnail(file);
          await putAsset({ ...baseAsset, dataUrl, thumbUrl });
        } else if(kind === "text"){
          const text = await readFileAsText(file);
          await putAsset({ ...baseAsset, text });
        } else {
          await putAsset({ ...baseAsset, blob: file });
        }
        files.push({
          id: uid(),
          assetId,
          kind,
          name: file.name,
          path: item.path || file.name,
          fileSize: file.size || 0,
          mimeType: file.type || "",
          order: i + 1,
        });
      } catch {
        toastFn(`${file.name || "素材"} 读取失败`, "error");
      }
    }
    if(!files.length) return;
    const counts = files.reduce((acc, file) => ({ ...acc, [file.kind]: (acc[file.kind] || 0) + 1 }), {});
    const m = NTYPES["asset-folder"];
    const x = grid ? snap(cx - m.w / 2, GRID) : cx - m.w / 2;
    const y = grid ? snap(cy - m.h / 2, GRID) : cy - m.h / 2;
    const folderNode = mkNode("asset-folder", x, y, {
      name: folderName || "导入素材",
      folderName: folderName || "导入素材",
      files,
      counts,
      importedAt: Date.now(),
      genState: "done",
    });
    push([...nR.current, folderNode], eR.current);
    setSel(new Set([folderNode.id]));
    setCtxMenu(null);
    setShowAddMenu(false);
    toastFn(`已导入文件夹：${folderNode.name} · ${files.length} 个素材`, "success");
  }, [grid, push, toastFn]);

  const updateSourceImage = useCallback(async (nodeId, file) => {
    if(!isImageFile(file)){ toastFn("请选择图片文件", "error"); return; }
    try {
      const imageUrl = await readFileAsDataUrl(file);
      const thumbUrl = await createImageThumbnail(file);
      const assetId = `asset_${uid()}`;
      await putAsset({ id: assetId, dataUrl: imageUrl, thumbUrl, fileName: file.name, fileSize: file.size, mimeType: file.type, updatedAt: Date.now() });
      const result = { id: uid(), ts: Date.now(), url: thumbUrl || imageUrl, fileName: file.name, assetId, data: { mimeType: file.type, fileSize: file.size } };
      sN(ns => ns.map(n => n.id === nodeId ? {
        ...n,
        name: n.name || sourceDisplayName(file.name, 1),
        assetId,
        imageUrl: thumbUrl || imageUrl,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        genState: "done",
        error: null,
        results: [result],
      } : n));
      toastFn("素材图已更新", "success");
    } catch(err) {
      toastFn(err.message || "图片读取失败", "error");
    }
  }, [sN, toastFn]);

  const onCanvasDragOver = useCallback((e) => {
    if(hasFileDrag(e.dataTransfer)){
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onCanvasDrop = useCallback(async (e) => {
    if(!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = wrap.current.getBoundingClientRect();
    const cp = s2c(e.clientX - r.left, e.clientY - r.top, vpR.current);
    const dropped = await collectDroppedFileEntries(e.dataTransfer);
    const files = dropped.files || [];
    const plainFiles = files.map(item => item.file).filter(Boolean);
    if(dropped.hasDirectory || plainFiles.some(file => !isImageFile(file))){
      addFolderAssetNode(files, cp.x, cp.y, dropped.rootName || "导入素材");
      return;
    }
    if(plainFiles.some(isImageFile)) addSourceImages(plainFiles, cp.x, cp.y);
  }, [addFolderAssetNode, addSourceImages]);

  // ─── Add node ───
  const addNode = useCallback((type, cx, cy, extra={}) => {
    const m = NTYPES[type];
    const x = grid ? snap(cx - m.w/2, GRID) : cx - m.w/2;
    const y = grid ? snap(cy - m.h/2, GRID) : cy - m.h/2;
    const nn = mkNode(type, x, y, extra);
    push([...nR.current, nn], eR.current);
    setSel(new Set([nn.id]));
    setCtxMenu(null);
    setShowAddMenu(false);
    toastFn(`已添加${m.label}`, "success");
  }, [grid, push, toastFn]);

  const onDbl = useCallback((e) => {
    if(["TEXTAREA","INPUT","SELECT","BUTTON"].includes(e.target.tagName)) return;
    if(e.target.closest("[data-interactive]")) return;
    const r = wrap.current.getBoundingClientRect();
    const ht_ = hit(e.clientX - r.left, e.clientY - r.top);
    if(ht_) return;
    const cp = s2c(e.clientX - r.left, e.clientY - r.top, vpR.current);
    addNode("ai-image", cp.x, cp.y);
  }, [hit, addNode]);

  // ─── Operations ───
  const delSel = useCallback(() => {
    if(!selR.current.size) return;
    push(nR.current.filter(n => !selR.current.has(n.id)), eR.current.filter(e => !selR.current.has(e.sourceId) && !selR.current.has(e.targetId)));
    setSel(new Set());
    toastFn("已删除", "info");
  }, [push, toastFn]);
  
  const dupSel = useCallback(() => {
    if(!selR.current.size) return;
    const im = new Map();
    const d = nR.current.filter(n => selR.current.has(n.id)).map(n => {
      const isSource = n.type === "source-image";
      const nn = { ...n, id: uid(), x: n.x + 50, y: n.y + 50, results: isSource ? n.results : [], genState: isSource ? n.genState : "idle", error: null };
      im.set(n.id, nn.id);
      return nn;
    });
    const de = eR.current.filter(e => im.has(e.sourceId) && im.has(e.targetId)).map(e => ({ id: uid(), sourceId: im.get(e.sourceId), targetId: im.get(e.targetId), createdAt: Date.now() }));
    push([...nR.current, ...d], [...eR.current, ...de]);
    setSel(new Set(d.map(n => n.id)));
    toastFn("已复制", "success");
  }, [push, toastFn]);
  
  const fitV = useCallback(() => {
    const ns = nR.current;
    if(!ns.length || !wrap.current){ setVp({ x: 120, y: 100, z: 1 }); return; }
    const b = ns.reduce((a,n) => ({ x0: Math.min(a.x0, n.x), y0: Math.min(a.y0, n.y), x1: Math.max(a.x1, n.x + n.w), y1: Math.max(a.y1, n.y + n.h) }), { x0:1e9, y0:1e9, x1:-1e9, y1:-1e9 });
    const r = wrap.current.getBoundingClientRect();
    const p = 120;
    const z = clamp(Math.min(r.width/(b.x1-b.x0+p*2), r.height/(b.y1-b.y0+p*2)), MIN_Z, 1.5);
    setVp({ x: (r.width - (b.x1-b.x0)*z)/2 - b.x0*z, y: (r.height - (b.y1-b.y0)*z)/2 - b.y0*z, z });
  }, []);

  const resetCanvasInteraction = useCallback(() => {
    setSel(new Set());
    setDrag(null);
    setMarquee(null);
    setPan(null);
    setSpacePan(false);
    setRzDrag(null);
    setEdgeDraft(null);
    setCtxMenu(null);
    setHover(null);
    setEdgeHover(null);
  }, []);

  const captureActiveCanvas = useCallback(async (list = canvasesR.current) => {
    let currentNodes = nR.current;
    if(hasUnpersistedSourceAssets(currentNodes)){
      currentNodes = await persistSourceAssetsInNodes(currentNodes);
    }
    return list.map(canvas => {
      if(canvas.id !== activeCanvasIdR.current) return canvas;
      return {
        ...canvas,
        nodes: serializeCanvasNodes(currentNodes),
        edges: eR.current,
        savedAt: Date.now(),
      };
    });
  }, []);

  const persistCanvasList = useCallback((list, nextActiveCanvasId = activeCanvasIdR.current) => {
    if(list.some(canvas => hasUnpersistedSourceAssets(canvas.nodes || []))) return;
    const savedCanvases = list.map(serializeCanvasRecord);
    const activeCanvas = savedCanvases.find(c => c.id === nextActiveCanvasId) || savedCanvases[0];
    try {
      localStorage.setItem("cc-canvas-v3", JSON.stringify({
        version: "3.1",
        activeCanvasId: nextActiveCanvasId,
        canvases: savedCanvases,
        nodes: activeCanvas?.nodes || [],
        edges: activeCanvas?.edges || [],
      }));
    } catch{}
  }, []);

  const switchCanvas = useCallback(async (canvasId) => {
    if(canvasId === activeCanvasIdR.current) return;
    const savedList = await captureActiveCanvas();
    const target = savedList.find(c => c.id === canvasId);
    if(!target) return;
    const loadedNodes = await hydrateSourceNodes(target.nodes || []);
    setCanvases(savedList);
    setActiveCanvasId(canvasId);
    dp({ type: "load", n: loadedNodes, e: target.edges || [] });
    resetCanvasInteraction();
    persistCanvasList(savedList, canvasId);
    setTimeout(fitV, 80);
  }, [captureActiveCanvas, fitV, persistCanvasList, resetCanvasInteraction]);

  const createCanvas = useCallback(async () => {
    const savedList = await captureActiveCanvas();
    const id = `canvas_${uid()}`;
    const nextCanvas = createCanvasRecord({ id, name: `新画布 ${savedList.length + 1}` }, savedList.length);
    const nextList = [...savedList, nextCanvas];
    setCanvases(nextList);
    setActiveCanvasId(id);
    dp({ type: "load", n: [], e: [] });
    resetCanvasInteraction();
    persistCanvasList(nextList, id);
    setTimeout(fitV, 80);
    toastFn("已新建空白画布，上一画布已自动保存", "success");
  }, [captureActiveCanvas, fitV, persistCanvasList, resetCanvasInteraction, toastFn]);

  const closeCanvas = useCallback(async (canvasId) => {
    const savedList = await captureActiveCanvas();
    if(savedList.length <= 1) return;
    const closingIndex = savedList.findIndex(c => c.id === canvasId);
    if(closingIndex < 0) return;
    const nextList = savedList.filter(c => c.id !== canvasId);
    let nextActiveCanvasId = activeCanvasIdR.current;
    if(canvasId === activeCanvasIdR.current){
      nextActiveCanvasId = nextList[Math.max(0, closingIndex - 1)]?.id || nextList[0].id;
      const target = nextList.find(c => c.id === nextActiveCanvasId) || nextList[0];
      const loadedNodes = await hydrateSourceNodes(target.nodes || []);
      setActiveCanvasId(nextActiveCanvasId);
      dp({ type: "load", n: loadedNodes, e: target.edges || [] });
      resetCanvasInteraction();
      setTimeout(fitV, 80);
    }
    setCanvases(nextList);
    persistCanvasList(nextList, nextActiveCanvasId);
    toastFn("已关闭画布，当前内容已自动保存", "info");
  }, [captureActiveCanvas, fitV, persistCanvasList, resetCanvasInteraction, toastFn]);

  const saveProject = useCallback(() => {
    const name = prompt("画布名称:", canvases.find(c=>c.id===activeCanvasId)?.name || "新画布");
    if(!name) return;
    const data = { id: uid(), name, nodes: serializeCanvasNodes(nodes), edges, savedAt: Date.now() };
    const newProjects = [...projects.filter(p => p.name !== name), data];
    setProjects(newProjects);
    try { localStorage.setItem("cc-projects-v3", JSON.stringify(newProjects)); } catch{}
    toastFn(`已保存: ${name}`, "success");
  }, [nodes, edges, projects, canvases, activeCanvasId, toastFn]);

  const exportJSON = useCallback(() => {
    const data = { name: canvases.find(c=>c.id===activeCanvasId)?.name || "画布", nodes: serializeCanvasNodes(nodes), edges, exportedAt: Date.now(), version: "3.0" };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${data.name}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastFn("已导出 JSON", "success");
  }, [nodes, edges, canvases, activeCanvasId, toastFn]);

  // ─── 下载结果 ───
  const downloadResult = useCallback(async (result, nodeType) => {
    const sourceExt = result.fileName?.includes(".") ? result.fileName.split(".").pop() : "png";
    const ext = nodeType === "ai-video" || nodeType === "source-video" ? "mp4" : nodeType === "ai-audio" || nodeType === "source-audio" ? "mp3" : nodeType === "ai-text" || nodeType === "source-text" ? "txt" : sourceExt;
    const filename = result.fileName || `cherry_${nodeType}_${result.id || Date.now()}.${ext}`;
    if(nodeType === "source-text" && typeof result.text === "string"){
      const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toastFn(`已下载 ${filename}`, "success");
      return;
    }
    if(isSourceAssetType(nodeType) && result.assetId){
      const asset = await getAsset(result.assetId);
      if(asset?.dataUrl){
        const a = document.createElement("a");
        a.href = asset.dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toastFn(`宸蹭笅杞?${filename}`, "success");
        return;
      }
      if(asset?.blob){
        const url = URL.createObjectURL(asset.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toastFn(`已下载 ${filename}`, "success");
        return;
      }
      if(typeof asset?.text === "string"){
        const blob = new Blob([asset.text], { type: asset.mimeType || "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toastFn(`已下载 ${filename}`, "success");
        return;
      }
    }
    
    // 真实环境从 result.url 下载
    const resultUrl = nodeType === "ai-video" ? playableVideoUrlOf(result) : resultMediaUrlOf(result, nodeType);
    if(resultUrl){
      const a = document.createElement("a");
      a.href = downloadMediaUrl(resultUrl, filename);
      a.download = filename;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toastFn(`已下载 ${filename}`, "success");
      return;
    }
    
    // 模拟环境：生成示例文件
    if(nodeType === "ai-text" && result.text){
      const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } else {
      // 生成占位 SVG 图片
      const c = COLORS[NTYPES[nodeType]?.color || "indigo"];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><defs><linearGradient id="g"><stop offset="0" stop-color="${c}" stop-opacity="0.8"/><stop offset="1" stop-color="${c}" stop-opacity="0.3"/></linearGradient></defs><rect width="800" height="800" fill="${T.bg}"/><rect width="800" height="800" fill="url(#g)" opacity="0.4"/><text x="400" y="400" text-anchor="middle" fill="white" font-size="32" font-family="sans-serif">Cherry Canvas 示例输出</text></svg>`;
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename.replace(".png", ".svg"); a.click();
      URL.revokeObjectURL(url);
    }
    toastFn(`已下载 ${filename}`, "success");
  }, [COLORS, T.bg, toastFn]);

  // ─── Generation ───
  const startGen = useCallback(async (nodeId) => {
    const nd = nR.current.find(n => n.id === nodeId);
    if(!nd) return;
    if(!nd.prompt.trim()){ toastFn("请输入提示词", "error"); return; }
    
    // 展开 @ 引用
    let finalPrompt = nd.prompt;
    const mentions = nd.prompt.match(/@\[([^\]]+)\]/g) || [];
    const referenceIds = new Set();
    eR.current.forEach(ed => {
      if(ed.targetId === nodeId) referenceIds.add(ed.sourceId);
    });
    mentions.forEach(m => {
      const refId = m.slice(2,-1);
      referenceIds.add(refId);
      const refNode = nR.current.find(n => n.id === refId);
      if(refNode){
        const latest = refNode.results?.[refNode.results.length - 1];
        const refText = refNode.type === "source-text"
          ? (refNode.text || refNode.prompt || latest?.text || "").slice(0, 300)
          : refNode.type === "source-image" || refNode.type === "ai-image"
          ? imageReferenceName(refNode, latest)
          : (refNode.fileName || refNode.name || refNode.prompt || "").slice(0,80);
        finalPrompt = finalPrompt.replace(m, `[引用${NTYPES[refNode.type]?.label}: ${refText}]`);
      }
    });
    [...referenceIds].forEach(refId => {
      if(mentions.some(m => m.slice(2, -1) === refId)) return;
      const refNode = nR.current.find(n => n.id === refId);
      if(refNode?.type === "source-text" || refNode?.type === "comment-note"){
        const text = String(refNode.text || refNode.prompt || refNode.results?.[refNode.results.length - 1]?.text || "").trim();
        if(text) finalPrompt += `\n\n[引用${NTYPES[refNode.type]?.label}: ${text.slice(0, 2000)}]`;
      }
    });
    const referenceImages = (await Promise.all([...referenceIds]
      .map(id => nR.current.find(n => n.id === id))
      .filter(Boolean)
      .map(async refNode => {
        const latest = refNode.results?.[refNode.results.length - 1];
        const asset = refNode.assetId ? await getAsset(refNode.assetId) : null;
        const refUrl = asset?.dataUrl || (refNode.type === "source-image" ? latest?.url || refNode.imageUrl : refNode.imageUrl || latest?.url);
        if(!refUrl) return null;
        if(refNode.type !== "source-image" && refNode.type !== "ai-image") return null;
        const displayName = imageReferenceName(refNode, latest);
        return {
          name: displayName,
          displayName,
          dataUrl: refUrl.startsWith?.("data:") ? refUrl : "",
          url: refUrl.startsWith?.("data:") ? "" : refUrl,
          fileName: imageReferenceFileName(displayName, refNode, latest),
          mimeType: refNode.mimeType || latest?.data?.mimeType || "",
        };
      }))).filter(Boolean);
    
    sN(ns => ns.map(n => n.id===nodeId ? { ...n, genState: "generating", genProgress: 0, error: null } : n));
    
    try {
      const prov = nd.provider;
      const cfg = apiR.current[prov] || {};
      
      if(prov !== "dreamina" && !cfg.apiKey) throw new Error(`未配置 ${PROVIDERS[prov]?.label || prov} API Key，请先在设置中填写`);
      if(prov === "custom" && nd.type === "ai-text" && !(nd.model || cfg.modelId).trim()) throw new Error("请填写自定义 API 的模型 ID");
      if(prov === "dreamina" && !dmStatus.loggedIn) throw new Error("即梦未登录，请先在设置中执行登录");
      
      const progInterval = setInterval(() => {
        sN(ns => ns.map(n => {
          if(n.id !== nodeId) return n;
          const nextProgress = Math.min(95, (n.genProgress || 0) + 4 + Math.random() * 5);
          return Math.abs(nextProgress - (n.genProgress || 0)) < 0.5 ? n : { ...n, genProgress: nextProgress };
        }));
      }, 1200);
      
      let result = null;
      try {
        // 真实 API 调用
        if(prov === "dreamina" && (nd.type === "ai-image" || nd.type === "ai-video")){
          const res = await fetch(`${API_BASE}/api/dreamina/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: nd.type === "ai-video" ? "video" : "image",
              model: nd.model,
              prompt: finalPrompt,
              ratio: nd.ratio,
              duration: nd.duration,
              resolution: nd.resolution,
              referenceImages,
              poll: nd.type === "ai-video" ? 10 : 12,
            })
          });
          if(!res.ok){ const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
          result = await res.json();
        } else if(nd.type === "ai-image"){
          const res = await fetch(`${API_BASE}/api/v2/proxy/image`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: prov,
              model: nd.model,
              prompt: finalPrompt,
              apiKey: cfg.apiKey,
              modelApiKey: cfg.modelApiKey,
              apiUrl: cfg.apiUrl || PROVIDERS[prov]?.url,
              aspectRatio: nd.ratio,
              count: nd.count || 1
            })
          });
          if(!res.ok){ const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
          result = await res.json();
        } else if(nd.type === "ai-text"){
          if(prov === "custom"){
            const model = nd.model || cfg.modelId;
            if((cfg.requestFormat || "openai") === "openai"){
              const res = await fetch(`${API_BASE}/api/v2/proxy/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  apiUrl: cfg.apiUrl,
                  endpointPath: cfg.endpointPath || "/v1/chat/completions",
                  apiKey: cfg.apiKey,
                  model,
                  stream: false,
                  messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: finalPrompt }
                  ]
                })
              });
              if(!res.ok){ const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
              result = await res.json();
            } else {
              const bodyText = (cfg.customBody || "{}").replaceAll("{{prompt}}", escapeForJsonTemplate(finalPrompt));
              const body = JSON.parse(bodyText);
              const headers = { "Content-Type": "application/json" };
              if(cfg.authType === "bearer") headers.Authorization = `Bearer ${cfg.apiKey}`;
              else if(cfg.authType === "header") headers[cfg.headerName || "Authorization"] = `${cfg.headerPrefix || ""}${cfg.apiKey}`;
              const url = joinApiUrl(cfg.apiUrl, cfg.endpointPath || "/v1/chat/completions");
              const finalUrl = cfg.authType === "query" ? withQueryParam(url, cfg.headerName || "api_key", cfg.apiKey) : url;
              const res = await fetch(finalUrl, { method: "POST", headers, body: JSON.stringify(body) });
              if(!res.ok){ const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
              result = await res.json();
            }
            const text = readResponsePath(result, cfg.responsePath) || JSON.stringify(result).slice(0, 300);
            result = { ...result, text };
          } else {
            const res = await fetch(`${API_BASE}/api/v2/proxy/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                apiUrl: cfg.apiUrl || PROVIDERS[prov]?.url,
                apiKey: cfg.apiKey,
                model: nd.model,
                stream: false,
                messages: [
                  { role: "system", content: "You are a helpful assistant." },
                  { role: "user", content: finalPrompt }
                ]
              })
            });
            if(!res.ok){ const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
            result = await res.json();
            const text = readResponsePath(result, "choices[0].message.content") || result?.text || JSON.stringify(result).slice(0, 300);
            result = { ...result, text };
          }
        } else {
          await new Promise(r => setTimeout(r, 2500));
          result = { ok: true };
        }
      } finally {
        clearInterval(progInterval);
      }
      
      const resultUrl = resultMediaUrlOf(result, nd.type);
      const resultPoster = nd.type === "ai-video" ? playableVideoPosterOf(result) : resultPosterOf(result);
      const resultSubmitId = resultSubmitIdOf(result);
      const failedResult = resultFailed(result);
      const waitingForDreaminaMedia = prov === "dreamina" && (nd.type === "ai-video" || nd.type === "ai-image") && resultSubmitId && !resultUrl && !failedResult;
      sN(ns => ns.map(n => n.id===nodeId ? {
        ...n,
        genState: failedResult ? "error" : (waitingForDreaminaMedia ? "generating" : "done"),
        genProgress: waitingForDreaminaMedia ? 95 : (resultUrl ? 100 : n.genProgress),
        error: failedResult ? (resultFailReasonOf(result) || "即梦生成失败") : null,
        results: [...n.results, { id: uid(), ts: Date.now(), data: result, text: result?.text, url: resultUrl, poster: resultPoster, submitId: resultSubmitId }]
      } : n));
      if(failedResult){
        toastFn(resultFailReasonOf(result) || "即梦生成失败", "error");
      } else if(waitingForDreaminaMedia){
        setDreaminaPollTick(t => t + 1);
        toastFn("即梦任务已提交，正在同步结果", "info");
      } else {
        toastFn("生成完成", "success");
      }
    } catch(err){
      sN(ns => ns.map(n => n.id===nodeId ? { ...n, genState: "error", error: err.message || "生成失败" } : n));
      toastFn(err.message || "生成失败", "error");
    }
  }, [sN, toastFn, dmStatus.loggedIn]);

  const uN = useCallback((id, patch) => sN(ns => ns.map(n => n.id===id ? { ...n, ...patch } : n)), [sN]);

  const expandFolderNode = useCallback(async (folderId) => {
    const folder = nR.current.find(n => n.id === folderId);
    if(!folder || folder.type !== "asset-folder") return;
    const existing = (folder.expandedNodeIds || []).filter(id => nR.current.some(n => n.id === id));
    if(existing.length){
      setSel(new Set(existing));
      toastFn("已选中这个文件夹展开过的素材节点", "info");
      return;
    }
    const files = Array.from(folder.files || []).sort((a, b) => (a.order || 0) - (b.order || 0));
    if(!files.length){
      toastFn("文件夹里没有可展开的素材", "error");
      return;
    }
    toastFn(`正在展开 ${files.length} 个素材节点...`, "info");
    const created = [];
    const baseX = folder.x + folder.w + 90;
    let y = folder.y;
    for(let i = 0; i < files.length; i++){
      const file = files[i];
      const type = sourceTypeForKind(file.kind);
      const m = NTYPES[type];
      if(!type || !m) continue;
      const asset = await getAsset(file.assetId);
      const name = `${String(i + 1).padStart(2, "0")} · ${stripFileExt(file.name || file.path || asset?.fileName || assetKindLabel(file.kind))}`;
      const x = grid ? snap(baseX, GRID) : baseX;
      const nodeY = grid ? snap(y, GRID) : y;
      const common = {
        name,
        assetId: file.assetId,
        folderId,
        folderPath: file.path,
        folderOrder: i + 1,
        fileName: file.name || asset?.fileName || "",
        fileSize: file.fileSize || asset?.fileSize || 0,
        mimeType: file.mimeType || asset?.mimeType || "",
        genState: "done",
      };
      if(type === "source-image" && asset?.dataUrl){
        const url = asset.thumbUrl || asset.dataUrl;
        created.push(mkNode(type, x, nodeY, {
          ...common,
          imageUrl: url,
          results: [{ id: uid(), ts: Date.now(), url, fileName: common.fileName, assetId: file.assetId, data: { mimeType: common.mimeType, fileSize: common.fileSize } }],
        }));
      } else if((type === "source-video" || type === "source-audio") && asset?.blob){
        const mediaUrl = URL.createObjectURL(asset.blob);
        created.push(mkNode(type, x, nodeY, {
          ...common,
          mediaUrl,
          results: [{ id: uid(), ts: Date.now(), url: mediaUrl, fileName: common.fileName, assetId: file.assetId, data: { mimeType: common.mimeType, fileSize: common.fileSize } }],
        }));
      } else if(type === "source-text"){
        const text = asset?.text || "";
        created.push(mkNode(type, x, nodeY, {
          ...common,
          text,
          prompt: text,
          results: [{ id: uid(), ts: Date.now(), text, fileName: common.fileName, assetId: file.assetId }],
        }));
      }
      y += (m?.h || 300) + 28;
    }
    if(!created.length){
      toastFn("素材读取失败，无法展开", "error");
      return;
    }
    const createdIds = created.map(n => n.id);
    const nextNodes = [
      ...nR.current.map(n => n.id === folderId ? { ...n, expanded: true, expandedNodeIds: createdIds } : n),
      ...created,
    ];
    push(nextNodes, eR.current);
    setSel(new Set(createdIds));
    toastFn(`已展开 ${created.length} 个素材节点`, "success");
  }, [grid, push, toastFn]);

  // ─── Keys ───
  useEffect(() => {
    const fn = (e) => {
      const inField = ["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName);
      const key = e.key.toLowerCase();
      const isSpace = e.code === "Space" || e.key === " ";
      
      // Ctrl+S 全局
      if(key === "s" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); saveProject(); return; }
      
      if(!inField && isSpace){
        e.preventDefault();
        if(!e.repeat) setSpacePan(true);
        return;
      }

      if(inField) return;
      
      if(e.key === "Delete" || e.key === "Backspace") delSel();
      if(key === "a" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); setSel(new Set(nR.current.map(n=>n.id))); return; }
      if(key === "d" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); dupSel(); return; }
      if(key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey){ e.preventDefault(); dp({ type: "undo" }); return; }
      if(((key === "z" && e.shiftKey) || key === "y") && (e.ctrlKey || e.metaKey)){ e.preventDefault(); dp({ type: "redo" }); return; }
      if(key === "f") fitV();
      if(e.key === "?") setShowKeyboard(true);
      if(e.key === "Escape"){
        setSel(new Set()); setCtxMenu(null); setShowSettings(false); setShowProjects(false);
        setShowAddMenu(false); setShowMention(null); setShowPreset(null); setShowKeyboard(false);
        setShowPreview(null);
      }
    };
    const up = (e) => {
      if(e.code === "Space" || e.key === " ") setSpacePan(false);
    };
    const clearHand = () => setSpacePan(false);
    window.addEventListener("keydown", fn);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clearHand);
    return () => {
      window.removeEventListener("keydown", fn);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clearHand);
    };
  }, [delSel, dupSel, fitV, saveProject]);

  const ePath = useCallback((fn, tn) => {
    const x1 = fn.x + fn.w, y1 = fn.y + fn.h/2, x2 = tn.x, y2 = tn.y + tn.h/2;
    const d = Math.min(Math.abs(x2-x1)*0.5, 160);
    return `M${x1},${y1} C${x1+d},${y1} ${x2-d},${y2} ${x2},${y2}`;
  }, []);
  
  const delEdge = useCallback((eid) => {
    push(nR.current, eR.current.filter(e => e.id !== eid));
    setEdgeHover(null);
    toastFn("连线已删除", "info");
  }, [push, toastFn]);

  const mmB = useMemo(() => {
    if(!nodes.length) return null;
    const b = nodes.reduce((a,n) => ({ x0: Math.min(a.x0, n.x), y0: Math.min(a.y0, n.y), x1: Math.max(a.x1, n.x + n.w), y1: Math.max(a.y1, n.y + n.h) }), { x0:1e9, y0:1e9, x1:-1e9, y1:-1e9 });
    const p = 80;
    return { ...b, p, w: b.x1-b.x0+p*2, h: b.y1-b.y0+p*2 };
  }, [nodes]);

  const handlePromptInput = useCallback((nodeId, e) => {
    const v = e.target.value;
    uN(nodeId, { prompt: v });
    const cursor = e.target.selectionStart;
    const before = v.slice(0, cursor);
    const atM = before.match(/@(\S*)$/);
    const sM = before.match(/\/(\S*)$/);
    if(atM){
      const rect = e.target.getBoundingClientRect();
      setShowMention({ nodeId, query: atM[1], screenX: rect.left, screenY: rect.bottom });
      setShowPreset(null);
    } else if(sM){
      const rect = e.target.getBoundingClientRect();
      setShowPreset({ nodeId, query: sM[1], screenX: rect.left, screenY: rect.bottom });
      setShowMention(null);
    } else { setShowMention(null); setShowPreset(null); }
  }, [uN]);

  const insertMention = useCallback((nodeId, refId) => {
    const refNode = nR.current.find(n => n.id === refId);
    if(!refNode) return;
    const cur = nR.current.find(n => n.id === nodeId);
    if(!cur) return;
    uN(nodeId, { prompt: cur.prompt.replace(/@\S*$/, `@[${refId}] `) });
    setShowMention(null);
    toastFn(`已引用: ${refNode.name}`, "info");
  }, [uN, toastFn]);

  const insertPreset = useCallback((nodeId, preset) => {
    const cur = nR.current.find(n => n.id === nodeId);
    if(!cur) return;
    uN(nodeId, { prompt: cur.prompt.replace(/\/\S*$/, preset.text) });
    setShowPreset(null);
  }, [uN]);

  const getModels = (nd) => {
    if(!nd) return [];
    const m = nd.type==="ai-image" ? IMAGE_MODELS : nd.type==="ai-text" ? TEXT_MODELS : nd.type==="ai-video" ? VIDEO_MODELS : nd.type==="ai-audio" ? AUDIO_MODELS : {};
    return m[nd.provider] || [];
  };
  const getProvs = (nd) => {
    if(!nd) return [];
    const m = nd.type==="ai-image" ? IMAGE_MODELS : nd.type==="ai-text" ? TEXT_MODELS : nd.type==="ai-video" ? VIDEO_MODELS : nd.type==="ai-audio" ? AUDIO_MODELS : {};
    return Object.keys(m).filter(p => PROVIDERS[p]);
  };

  const copyToClipboard = (text) => {
    const value = String(text || "");
    const fallbackCopy = () => {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      if(ok) toastFn("已复制到剪贴板","success");
      else toastFn("复制失败，请手动选中复制","error");
    };
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(value).then(()=>toastFn("已复制到剪贴板","success")).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  };

  // ═══════ Render ═══════
  return (
    <div className="perf-mode" style={{ width: "100%", height: "100vh", background: T.bg, fontFamily: "'Inter', 'Noto Sans SC', -apple-system, system-ui, sans-serif", overflow: "hidden", position: "relative", userSelect: "none", color: T.text }}>
      <style>{CSS(T, COLORS)}</style>
      
      {/* ═══════ Header ═══════ */}
      <header style={{ position: "absolute", top: 0, left: 0, right: 0, height: 50, display: "flex", alignItems: "center", padding: "0 12px", zIndex: 100, background: `linear-gradient(180deg, ${T.bg}f5, ${T.bg}40)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 100 }}>
          <button className="btn-icon" onClick={()=>setShowProjects(true)} title="项目"><Icon name="folder" size={16}/></button>
          <button className="btn-icon" onClick={()=>setShowKeyboard(true)} title="快捷键 (?)"><Icon name="keyboard" size={16}/></button>
        </div>
        
        <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: 4 }}>
          {canvases.map(c => (
            <button key={c.id} onClick={()=>switchCanvas(c.id)} className={`canvas-tab ${activeCanvasId===c.id ? "active" : ""}`}>
              {c.name}
              {canvases.length > 1 && (
                <span onClick={e=>{ e.stopPropagation(); closeCanvas(c.id); }} className="canvas-tab-x">
                  <Icon name="x" size={10}/>
                </span>
              )}
            </button>
          ))}
          <button onClick={createCanvas} className="canvas-tab-add" title="新建画布"><Icon name="plus" size={12}/></button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 100, justifyContent: "flex-end" }}>
          <button className="btn-icon" onClick={()=>dp({type:"undo"})} disabled={!h.past.length} title="撤销 Ctrl+Z"><Icon name="undo" size={14}/></button>
          <button className="btn-icon" onClick={()=>dp({type:"redo"})} disabled={!h.future.length} title="重做 Ctrl+Y"><Icon name="redo" size={14}/></button>
          <button className="btn-icon" onClick={saveProject} title="保存 Ctrl+S"><Icon name="save" size={14}/></button>
        </div>
      </header>

      {/* ═══════ Canvas ═══════ */}
      <div ref={wrap} className={spacePan ? (pan ? "space-pan is-panning" : "space-pan") : ""} style={{
        position: "absolute", inset: 0,
        cursor: pan ? "grabbing" : spacePan ? "grab" : "default",
        backgroundSize: `${GRID*vp.z}px ${GRID*vp.z}px`,
        backgroundPosition: `${vp.x}px ${vp.y}px`,
        backgroundImage: grid ? `radial-gradient(circle, ${T.text === "rgba(0,0,0,0.85)" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)"} 1px, transparent 1px)` : "none"
      }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
        onDoubleClick={onDbl} onContextMenu={onCtx} onDragEnter={onCanvasDragOver} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
        
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 60% 40% at 50% 50%, rgba(${T.accentRgb}, 0.06), transparent 60%), radial-gradient(ellipse 40% 30% at 80% 20%, rgba(${T.accentRgb}, 0.04), transparent 60%)`, pointerEvents: "none", zIndex: 0 }}/>

        {/* SVG: edges + marquee */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "auto", zIndex: 1 }}>
          <g transform={`translate(${vp.x},${vp.y}) scale(${vp.z})`}>
            {edges.map(ed => {
              const fn = nodes.find(n => n.id === ed.sourceId);
              const tn = nodes.find(n => n.id === ed.targetId);
              if(!fn || !tn) return null;
              const isSel = sel.has(ed.sourceId) || sel.has(ed.targetId);
              const d = ePath(fn, tn);
              const mx = (fn.x + fn.w + tn.x) / 2;
              const my = (fn.y + fn.h/2 + tn.y + tn.h/2) / 2;
              const isEdgeHover = edgeHover === ed.id;
              return (
                <g key={ed.id} style={{ pointerEvents: "auto" }} onMouseEnter={()=>setEdgeHover(ed.id)} onMouseLeave={()=>setEdgeHover(v => v === ed.id ? null : v)}>
                  <path data-edge={ed.id} d={d} fill="none" stroke={T.accent} strokeOpacity={0} strokeWidth={18}
                    style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    onPointerDown={e=>e.stopPropagation()}
                    onClick={e=>{ e.stopPropagation(); delEdge(ed.id); }}/>
                  <path d={d} fill="none" stroke={isSel ? T.accent : (T.text === "rgba(0,0,0,0.85)" ? "rgba(0,0,0,0.25)" : "rgba(200,200,210,0.35)")} strokeWidth={isSel ? 2.5 : 1.8} style={{ pointerEvents: "none", transition: "stroke 0.15s" }}/>
                  {isEdgeHover && (
                    <g data-edge-delete={ed.id} transform={`translate(${mx},${my})`} style={{ cursor: "pointer", pointerEvents: "auto" }}
                      onPointerDown={e=>e.stopPropagation()}
                      onClick={e=>{ e.stopPropagation(); delEdge(ed.id); }}>
                      <circle r="13" fill={T.bg2} stroke={T.borderHi} strokeWidth="1.5"/>
                      <path d="M-4 -4 L4 4 M4 -4 L-4 4" stroke={T.textMuted} strokeWidth="1.8" strokeLinecap="round"/>
                    </g>
                  )}
                </g>
              );
            })}
            {edgeDraft && (
              <path d={`M${edgeDraft.fx},${edgeDraft.fy} C${edgeDraft.fx+80},${edgeDraft.fy} ${edgeDraft.tx-80},${edgeDraft.ty} ${edgeDraft.tx},${edgeDraft.ty}`}
                fill="none" stroke={T.accent} strokeWidth={2.5} strokeDasharray="6 4" opacity={0.8}/>
            )}
          </g>
          {marquee && marquee.hadMove && (() => {
            const a = c2s(marquee.x1, marquee.y1, vp), b = c2s(marquee.x2, marquee.y2, vp);
            return <rect x={Math.min(a.x,b.x)} y={Math.min(a.y,b.y)} width={Math.abs(b.x-a.x)} height={Math.abs(b.y-a.y)} 
              fill={`rgba(${T.accentRgb}, 0.08)`} stroke={T.accent} strokeWidth="1.5" strokeDasharray="6 4" rx="6"/>;
          })()}
        </svg>

        {/* 节点层 */}
        <div style={{ position: "absolute", left: vp.x, top: vp.y, transform: `scale(${vp.z}) translateZ(0)`, transformOrigin: "0 0", zIndex: 2, willChange: "transform" }}>
          {nodes.map(nd => {
            const m = NTYPES[nd.type] || NTYPES["ai-image"];
            const isSel = sel.has(nd.id);
            const isHov = hover === nd.id;
            const isAI = nd.type.startsWith("ai-");
            const isSourceAsset = isSourceAssetType(nd.type);
            const isAssetFolder = nd.type === "asset-folder";
            const c = COLORS[m.color] || T.accent;
            const latestPlayableVideoResult = nd.type === "ai-video" ? [...(nd.results || [])].reverse().find(playableVideoUrlOf) : null;
            const latestPendingVideoResult = nd.type === "ai-video" ? [...(nd.results || [])].reverse().find(result => resultSubmitIdOf(result) && !resultFailed(result) && !playableVideoUrlOf(result)) : null;
            const latestResult = nd.type === "ai-video"
              ? (latestPlayableVideoResult || latestPendingVideoResult || nd.results?.[nd.results.length - 1])
              : ([...(nd.results || [])].reverse().find(resultUrlOf) || nd.results?.[nd.results.length - 1]);
            const sourceImageUrl = nd.imageUrl || resultUrlOf(latestResult);
            const latestAssetUrl = nd.mediaUrl || resultUrlOf(latestResult);
            const latestResultUrl = nd.type === "ai-video" ? resultVideoUrlOf(latestResult) : resultUrlOf(latestResult);
            const latestResultPoster = nd.type === "ai-video" ? playableVideoPosterOf(latestResult) : resultPosterOf(latestResult);
            const latestVideoBaseUrl = nd.type === "ai-video" ? playableVideoUrlOf(latestResult) : "";
            const latestVideoSrc = latestVideoBaseUrl
              ? cacheBustedMediaUrl(latestVideoBaseUrl, resultSubmitIdOf(latestResult) || latestResult?.ts || latestVideoBaseUrl)
              : "";
            const hasGeneratedMedia = nd.type === "ai-video" ? !!latestVideoBaseUrl : !!latestResultUrl;
            const showPendingVideo = nd.type === "ai-video" && !latestVideoBaseUrl && !!latestPendingVideoResult;
            const showGeneratedResult = !isSourceAsset && (hasGeneratedMedia || showPendingVideo) && (nd.genState === "done" || nd.genState === "generating");
            
            return (
              <div key={nd.id} data-nid={nd.id} style={{ position: "absolute", left: nd.x, top: nd.y, width: nd.w, height: nd.h, zIndex: isSel ? 10 : 1, contain: "layout paint style" }}>
                
                {/* 节点上方徽标 */}
                <div data-node-drag="badge" style={{ position: "absolute", left: 0, top: -28, display: "flex", gap: 6, alignItems: "center", pointerEvents: "auto", cursor: "move" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 7, background: `${c}22`, border: `1px solid ${c}45`, color: c, fontSize: 11, fontWeight: 600, backdropFilter: "blur(4px)" }}>
                    <Icon name={m.icon} size={11} c={c}/>
                    {m.label}
                  </div>
                  {nd.results.length > 0 && (
                    <div style={{ padding: "4px 8px", borderRadius: 6, background: "rgba(16,185,129,0.18)", border: "1px solid rgba(16,185,129,0.35)", color: "#34d399", fontSize: 10, fontWeight: 600 }}>
                      {nd.results.length} 结果
                    </div>
                  )}
                </div>

                {/* 选中时的悬浮工具栏 */}
                {isSel && isAI && (
                  <div data-interactive="1" style={{ position: "absolute", right: 0, top: -34, display: "flex", gap: 3, padding: "4px 5px", borderRadius: 9, background: T.bg2, border: `1px solid ${T.borderHi}`, backdropFilter: "blur(20px)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 11 }}>
                    <button className="tb-mini" onClick={()=>startGen(nd.id)} title="生成"><Icon name="play" size={12}/></button>
                    <button className="tb-mini" onClick={()=>{ setSel(new Set([nd.id])); dupSel(); }} title="复制"><Icon name="copy" size={12}/></button>
                    {nd.results.length > 0 && <button className="tb-mini" onClick={()=>setShowPreview({nodeType:nd.type, results:nd.results, name:nd.name})} title="预览"><Icon name="eye" size={12}/></button>}
                    <button className="tb-mini danger" onClick={()=>{ setSel(new Set([nd.id])); delSel(); }} title="删除"><Icon name="trash" size={12}/></button>
                  </div>
                )}

                {/* 节点本体 */}
                <div style={{
                  width: "100%", height: "100%", borderRadius: 16, overflow: "hidden",
                  display: "flex", flexDirection: "column",
                  background: T.bg2,
                  border: `1.5px solid ${isSel ? c : isHov ? `${c}80` : T.border}`,
                  boxShadow: isSel ? `0 0 0 1px ${c}40, 0 10px 40px rgba(0,0,0,0.4)` : "0 4px 24px rgba(0,0,0,0.25)",
                  transition: "border-color 0.15s, box-shadow 0.15s",
                  backdropFilter: "blur(20px)",
                  cursor: "move", // 提示整个节点可拖拽
                }}>
                  
                  {/* Header (大可拖拽区) */}
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10, background: `linear-gradient(135deg, ${c}10, transparent 60%)` }}>
                    <div style={{ width: 28, height: 28, borderRadius: 7, background: `${c}22`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon name={m.icon} size={14} c={c}/>
                    </div>
                    <input data-interactive="1" value={nd.name} onChange={e=>uN(nd.id,{name:e.target.value})}
                      style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: T.text, fontSize: 14, fontWeight: 600, fontFamily: "inherit", minWidth: 0 }}/>
                  </div>

                  {/* Body */}
                  <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, overflow: "hidden", minHeight: 0 }}>
                    {isAssetFolder && (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                          {["image","video","audio","text"].map(kind => (
                            <div key={kind} style={{ padding: "7px 6px", borderRadius: 8, background: `${c}10`, border: `1px solid ${c}24`, textAlign: "center" }}>
                              <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{nd.counts?.[kind] || 0}</div>
                              <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{assetKindLabel(kind)}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 9, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.18)" }}>
                          {(nd.files || []).slice(0, 24).map(file => (
                            <div key={file.id} style={{ display: "grid", gridTemplateColumns: "28px 18px 1fr auto", alignItems: "center", gap: 7, padding: "7px 9px", borderBottom: `1px solid ${T.border}` }}>
                              <span style={{ fontSize: 10, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>{file.order}</span>
                              <Icon name={assetKindIcon(file.kind)} size={13} c={c}/>
                              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: T.text }}>{file.name}</span>
                              <span style={{ fontSize: 10, color: T.textDim }}>{formatBytes(file.fileSize)}</span>
                            </div>
                          ))}
                          {(nd.files || []).length > 24 && (
                            <div style={{ padding: "8px 10px", fontSize: 10, color: T.textDim, textAlign: "center" }}>还有 {(nd.files || []).length - 24} 个素材，展开工作流时会一起生成</div>
                          )}
                        </div>
                        <button data-interactive="1" onClick={()=>expandFolderNode(nd.id)} className="gen-btn" style={{ justifyContent: "center", background: nd.expanded ? "rgba(16,185,129,0.2)" : `linear-gradient(135deg, ${c}, ${c}cc)` }}>
                          <Icon name={nd.expanded ? "check" : "folder"} size={13} c={nd.expanded ? "#34d399" : "white"}/> {nd.expanded ? "已展开，点击选中素材" : "展开为素材工作流"}
                        </button>
                      </>
                    )}

                    {nd.type === "source-text" && (
                      <textarea
                        data-interactive="1"
                        value={nd.text || nd.prompt || ""}
                        onChange={e=>uN(nd.id, { text: e.target.value, prompt: e.target.value })}
                        className="node-prompt"
                        style={{ flex: 1, minHeight: 160, maxHeight: "none" }}
                      />
                    )}
                    
                    {/* Provider + Model */}
                    {isAI && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <select data-interactive="1" value={nd.provider} onChange={e=>{
                          const p = e.target.value;
                          const ms = nd.type==="ai-image" ? IMAGE_MODELS : nd.type==="ai-text" ? TEXT_MODELS : nd.type==="ai-video" ? VIDEO_MODELS : AUDIO_MODELS;
                          uN(nd.id, { provider: p, model: ms[p]?.[0]?.id || "" });
                        }} className="node-select" style={{ flex: "0 0 120px" }}>
                          {getProvs(nd).map(p => <option key={p} value={p}>{PROVIDERS[p]?.label}</option>)}
                        </select>
                        {nd.provider !== "custom" || nd.type === "ai-image" ? (
                          <select data-interactive="1" value={nd.model} onChange={e=>uN(nd.id, {model:e.target.value})} className="node-select" style={{ flex: 1 }}>
                            {getModels(nd).length === 0 ? <option value="">无可用模型</option> : getModels(nd).map(mo => <option key={mo.id} value={mo.id}>{mo.name}</option>)}
                          </select>
                        ) : (
                          <input data-interactive="1" placeholder="模型ID (如 gpt-4o)" value={nd.model} onChange={e=>uN(nd.id,{model:e.target.value})} className="node-input" style={{flex:1}}/>
                        )}
                      </div>
                    )}

                    {/* Ratio (图像) */}
                    {nd.type === "ai-image" && (
                      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: T.textDim, fontWeight: 600, flexShrink: 0 }}>比例</span>
                        {RATIOS.map(r => (
                          <button key={r.l} data-interactive="1" onClick={()=>uN(nd.id, {ratio:r.l})} className={`ratio-pill ${nd.ratio===r.l?"on":""}`}>{r.l}</button>
                        ))}
                      </div>
                    )}

                    {/* 视频参数 */}
                    {nd.type === "ai-video" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <select data-interactive="1" value={nd.duration} onChange={e=>uN(nd.id,{duration:Number(e.target.value)})} className="node-select" style={{flex:1}}>
                          {VIDEO_DURATIONS.map(d => <option key={d} value={d}>{d}秒</option>)}
                        </select>
                        <select data-interactive="1" value={nd.resolution} onChange={e=>uN(nd.id,{resolution:e.target.value})} className="node-select" style={{flex:1}}>
                          {["480p","720p","1080p"].map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    )}

                    {/* Prompt */}
                    {(isAI || nd.type === "comment-note") && (
                      <textarea
                        data-interactive="1"
                        placeholder={nd.type==="comment-note" ? "输入笔记..." : "输入提示词... 输入 @ 引用节点，输入 / 调用预设"}
                        value={nd.prompt}
                        onChange={e=>handlePromptInput(nd.id, e)}
                        className="node-prompt"
                        style={{ minHeight: nd.type==="comment-note" ? 100 : 70, maxHeight: nd.type==="comment-note" ? 400 : 110 }}
                      />
                    )}

                    {/* 预览区 */}
                        {nd.type !== "comment-note" && !isAssetFolder && nd.type !== "source-text" && (
                      <div data-node-drag="preview" data-interactive={latestVideoSrc && nd.type === "ai-video" ? "1" : undefined} style={{
                        flex: 1, minHeight: 60, borderRadius: 9, position: "relative",
                        background: "rgba(0,0,0,0.25)", border: `1px solid ${T.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                        cursor: nd.results.length > 0 ? "grab" : "move",
                      }} onClick={(e)=>{
                        if(nd.results.length > 0){
                          e.stopPropagation();
                          if(nd.type === "ai-video" && latestVideoSrc) setShowVideoPlayer({ url: latestVideoSrc, poster: latestResultPoster, name: nd.name });
                          else setShowPreview({nodeType: nd.type, results: nd.results, name: nd.name});
                        }
                      }}>
                        {nd.type === "source-image" && sourceImageUrl && (
                          <div style={{ width: "100%", height: "100%", position: "relative", background: "rgba(0,0,0,0.35)" }}>
                            <img src={sourceImageUrl} alt={nd.name || nd.fileName} draggable={false} onDragStart={e=>e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", userSelect: "none" }}/>
                            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.36)", opacity: 0, transition: "opacity 0.2s", pointerEvents: "none" }} className="preview-hover">
                              <Icon name="eye" size={20} c="white"/>
                            </div>
                            <div style={{ position: "absolute", left: 8, right: 8, bottom: 8, padding: "5px 7px", borderRadius: 6, background: "rgba(0,0,0,0.55)", color: "white", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {nd.name || nd.fileName || "素材图"} · {formatBytes(nd.fileSize)}
                            </div>
                          </div>
                        )}
                        {nd.type === "source-image" && !sourceImageUrl && (
                          <>
                            <input data-interactive="1" id={`source-file-${nd.id}`} type="file" accept="image/*" style={{ display: "none" }} onChange={e=>{ const f = e.target.files?.[0]; if(f) updateSourceImage(nd.id, f); e.target.value = ""; }}/>
                            <label data-interactive="1" htmlFor={`source-file-${nd.id}`} onClick={e=>e.stopPropagation()} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: T.textMuted, textAlign: "center", padding: 16 }}>
                              <Icon name="image" size={30} c={c}/>
                              <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>点击选择图片</div>
                              <div style={{ fontSize: 10, color: T.textDim }}>也可以直接把图片拖进画布</div>
                            </label>
                          </>
                        )}
                        {nd.type === "source-video" && latestAssetUrl && (
                          <video data-interactive="1" src={latestAssetUrl} controls playsInline preload="metadata" draggable={false} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} style={{ width: "100%", height: "100%", objectFit: "contain", background: "rgba(0,0,0,0.45)" }}/>
                        )}
                        {nd.type === "source-audio" && latestAssetUrl && (
                          <div style={{ width: "100%", height: "100%", padding: 18, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
                            <Icon name="audio" size={34} c={c}/>
                            <audio data-interactive="1" src={latestAssetUrl} controls preload="metadata" onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} style={{ width: "100%" }}/>
                            <div style={{ fontSize: 10, color: T.textDim }}>{nd.fileName} · {formatBytes(nd.fileSize)}</div>
                          </div>
                        )}
                        {(nd.type === "source-video" || nd.type === "source-audio") && !latestAssetUrl && (
                          <div style={{ textAlign: "center", opacity: 0.45 }}>
                            <Icon name={m.icon} size={28} c={c}/>
                            <div style={{ fontSize: 10, marginTop: 6, color: T.textDim }}>素材等待载入</div>
                          </div>
                        )}
                        {!isSourceAsset && nd.genState === "generating" && !showGeneratedResult && (
                          <>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 28, height: 28, border: `3px solid ${c}22`, borderTop: `3px solid ${c}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }}/>
                              <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 500 }}>生成中 {Math.round(nd.genProgress)}%</span>
                            </div>
                            <div style={{ position: "absolute", bottom: 0, left: 0, height: 3, background: c, width: `${nd.genProgress}%`, transition: "width 0.3s" }}/>
                          </>
                        )}
                        {!isSourceAsset && (nd.genState === "done" || showGeneratedResult) && nd.results.length > 0 && (
                          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 10 }}>
                            <div style={{ width: "75%", height: "65%", borderRadius: 8, background: `linear-gradient(135deg, ${c}35, ${c}08)`, border: `1px solid ${c}30`, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
                              {latestVideoSrc && nd.type === "ai-video" ? (
                                <button
                                  data-interactive="1"
                                  onPointerDown={e=>e.stopPropagation()}
                                  onMouseDown={e=>e.stopPropagation()}
                                  onClick={e=>{ e.stopPropagation(); setShowVideoPlayer({ url: latestVideoSrc, poster: latestResultPoster, name: nd.name }); }}
                                  style={{ width: "100%", height: "100%", border: "none", padding: 0, margin: 0, cursor: "pointer", position: "relative", overflow: "hidden", background: "rgba(0,0,0,0.45)" }}
                                >
                                  {latestResultPoster ? <img src={latestResultPoster} alt={nd.name} draggable={false} onDragStart={e=>e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.92 }}/> : <Icon name="video" size={34} c={c}/>}
                                  <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.22)" }}>
                                    <span style={{ width: 44, height: 44, borderRadius: "50%", background: `${c}dd`, color: "white", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}><Icon name="play" size={18} c="white"/></span>
                                  </span>
                                </button>
                              ) : showPendingVideo ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: c }}>
                                  <div style={{ width: 26, height: 26, border: `3px solid ${c}22`, borderTop: `3px solid ${c}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }}/>
                                  <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600 }}>同步结果 {Math.max(95, Math.round(nd.genProgress || 0))}%</span>
                                </div>
                              ) : latestResultUrl && nd.type === "ai-image" ? (
                                <img src={latestResultUrl} alt={nd.name} draggable={false} onDragStart={e=>e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "cover", userSelect: "none" }}/>
                              ) : (
                                <Icon name={m.icon} size={32} c={c}/>
                              )}
                              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", opacity: 0, transition: "opacity 0.2s", borderRadius: 8, pointerEvents: "none" }} className="preview-hover">
                                <Icon name="eye" size={20} c="white"/>
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 4 }}>
                              {nd.results.slice(-5).map(r => <div key={r.id} style={{ width: 26, height: 26, borderRadius: 5, background: `${c}18`, border: `1px solid ${c}30`, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name={m.icon} size={12} c={c}/></div>)}
                            </div>
                          </div>
                        )}
                        {!isSourceAsset && nd.genState === "error" && (
                          <div style={{ textAlign: "center", padding: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                            <Icon name="alert" size={18} c="#ef4444"/>
                            <span style={{ fontSize: 11, color: "#ef4444", lineHeight: 1.4, maxWidth: "90%", wordBreak: "break-all" }}>{nd.error}</span>
                          </div>
                        )}
                        {!isSourceAsset && nd.genState === "idle" && nd.results.length === 0 && (
                          <div style={{ textAlign: "center", opacity: 0.3 }}>
                            <Icon name={m.icon} size={26}/>
                            <div style={{ fontSize: 10, marginTop: 6, color: T.textDim }}>等待生成</div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* 操作按钮组 */}
                    {isAI && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button data-interactive="1" onClick={()=>{if(nd.genState==="generating" && !showGeneratedResult) syncDreaminaNodeResult(nd.id); else startGen(nd.id);}}
                          className={`gen-btn ${showGeneratedResult ? "done" : nd.genState}`} style={ nd.genState==="idle" ? { background: `linear-gradient(135deg, ${c}, ${c}cc)`, flex: 1 } : { flex: 1 } }>
                          {nd.genState === "idle" && <><Icon name="spark" size={13} c="white"/> 生成</>}
                          {nd.genState === "generating" && !showGeneratedResult && <>⏳ 同步结果 {Math.round(nd.genProgress)}%</>}
                          {(nd.genState === "done" || showGeneratedResult) && <><Icon name="refresh" size={12}/> 重新生成</>}
                          {nd.genState === "error" && <><Icon name="alert" size={12}/> 重试</>}
                        </button>
                        {nd.results.length > 0 && (
                          <button data-interactive="1" onClick={()=>downloadResult(latestResult || nd.results[nd.results.length-1], nd.type)} className="gen-btn-icon" title="下载最新结果">
                            <Icon name="download" size={13}/>
                          </button>
                        )}
                      </div>
                    )}
                    {nd.type === "source-image" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <input data-interactive="1" id={`source-file-actions-${nd.id}`} type="file" accept="image/*" style={{ display: "none" }} onChange={e=>{ const f = e.target.files?.[0]; if(f) updateSourceImage(nd.id, f); e.target.value = ""; }}/>
                        <label data-interactive="1" htmlFor={`source-file-actions-${nd.id}`} className="gen-btn" style={{ flex: 1, justifyContent: "center", cursor: "pointer" }}>
                          <Icon name="image" size={13}/> 更换图片
                        </label>
                        {sourceImageUrl && (
                          <button data-interactive="1" onClick={()=>downloadResult(nd.results[nd.results.length-1], nd.type)} className="gen-btn-icon" title="下载素材图">
                            <Icon name="download" size={13}/>
                          </button>
                        )}
                      </div>
                    )}
                    {(nd.type === "source-video" || nd.type === "source-audio" || nd.type === "source-text") && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button data-interactive="1" onClick={()=>downloadResult({ ...(nd.results?.[nd.results.length-1] || {}), assetId: nd.assetId, fileName: nd.fileName, text: nd.text || nd.prompt || nd.results?.[nd.results.length-1]?.text }, nd.type)} className="gen-btn" style={{ flex: 1, justifyContent: "center" }}>
                          <Icon name="download" size={13}/> 下载素材
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 连接端口 */}
                {!isAssetFolder && (<>
                <div data-port="in" data-interactive="1" style={{
                  position: "absolute", left: -8, top: "50%", transform: "translateY(-50%)",
                  width: 16, height: 16, borderRadius: "50%", background: T.bg2, border: `2.5px solid ${c}90`,
                  cursor: "crosshair", zIndex: 10, transition: "all 0.15s",
                  opacity: isSel || isHov ? 1 : 0.6,
                }}/>
                <div data-port="out" data-interactive="1" style={{
                  position: "absolute", right: -8, top: "50%", transform: "translateY(-50%)",
                  width: 16, height: 16, borderRadius: "50%", background: c, border: `2.5px solid ${c}`,
                  boxShadow: `0 0 12px ${c}60`, cursor: "crosshair", zIndex: 10, transition: "all 0.15s",
                  opacity: isSel || isHov ? 1 : 0.7,
                }}/>
                </>)}
                
                {/* Resize */}
                <div data-rz="1" data-interactive="1" style={{
                  position: "absolute", right: 0, bottom: 0, width: 18, height: 18,
                  cursor: "nwse-resize", zIndex: 10, opacity: isSel ? 0.7 : 0, transition: "opacity 0.15s"
                }}>
                  <svg width="18" height="18" viewBox="0 0 16 16"><path d="M14 2L2 14M14 6L6 14M14 10L10 14" stroke={T.textMuted} strokeWidth="1.5" strokeLinecap="round"/></svg>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══════ 左侧 Dock ═══════ */}
      <aside style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 4, padding: 6, background: T.bg3, borderRadius: 16, border: `1px solid ${T.border}`, zIndex: 50, backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
        <button className="dock-btn" onClick={()=>setShowSettings(true)} title="设置"><Icon name="settings" size={17}/></button>
        <button className="dock-btn" onClick={()=>setSettingsTab("theme") || setShowSettings(true)} title="主题"><Icon name="palette" size={17}/></button>
        <div style={{ height: 1, background: T.border, margin: "2px 8px" }}/>
        <div style={{ position: "relative" }}>
          <button className="dock-btn dock-btn-primary" onClick={()=>setShowAddMenu(!showAddMenu)} title="添加节点"><Icon name="plus" size={20} c="white"/></button>
          {showAddMenu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={()=>setShowAddMenu(false)}/>
              <div style={{ position: "absolute", left: 54, top: 0, width: 280, padding: 6, background: T.bg2, border: `1px solid ${T.borderHi}`, borderRadius: 12, zIndex: 60, backdropFilter: "blur(32px)", boxShadow: "0 16px 48px rgba(0,0,0,0.5)", animation: "fadeIn 0.15s ease" }}>
                <div style={{ fontSize: 10, color: T.textDim, padding: "6px 12px 8px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>添加节点</div>
                {Object.entries(NTYPES).map(([t,m_]) => {
                  const c = COLORS[m_.color] || T.accent;
                  return (
                    <button key={t} onClick={()=>{
                      const r = wrap.current.getBoundingClientRect();
                      addNode(t, (r.width/2 - vp.x)/vp.z, (r.height/2 - vp.y)/vp.z);
                    }} className="add-menu-item">
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: `${c}22`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon name={m_.icon} size={15} c={c}/>
                      </div>
                      <div style={{ flex: 1, textAlign: "left" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{m_.label}</div>
                        <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>
                          {t==="ai-image" ? "文生图 / 图生图" : t==="ai-text" ? "对话补全 / 流式输出" : t==="ai-video" ? "文生视频 / 图生视频" : t==="ai-audio" ? "语音合成 / TTS" : t==="source-image" ? "上传图片素材" : t==="source-video" ? "视频素材引用" : t==="source-audio" ? "音频素材引用" : t==="source-text" ? "文本素材引用" : t==="asset-folder" ? "拖入文件夹后自动生成" : "标记备注"}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ═══════ 底部控制条 ═══════ */}
      <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 3, padding: 5, background: T.bg3, borderRadius: 26, border: `1px solid ${T.border}`, zIndex: 50, backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
        <button className={`dock-pill ${grid?"on":""}`} onClick={()=>setGrid(!grid)} title="网格"><Icon name="grid" size={13}/></button>
        <button className={`dock-pill ${mm?"on":""}`} onClick={()=>setMm(!mm)} title="小地图"><Icon name="map" size={13}/></button>
        <div className="dock-pill-sep"/>
        <button className="dock-pill" onClick={()=>setVp(v=>({...v, z:clamp(v.z*0.8, MIN_Z, MAX_Z)}))} title="缩小"><Icon name="minus" size={13}/></button>
        <div className="dock-pill zoom-display">{Math.round(vp.z*100)}%</div>
        <button className="dock-pill" onClick={()=>setVp(v=>({...v, z:clamp(v.z*1.25, MIN_Z, MAX_Z)}))} title="放大"><Icon name="plus" size={13}/></button>
        <button className="dock-pill" onClick={fitV} title="适应画布"><Icon name="fit" size={13}/></button>
      </div>

      {/* ═══════ 小地图 ═══════ */}
      {mm && mmB && (
        <div style={{ position: "absolute", right: 14, bottom: 64, width: 200, height: 140, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", zIndex: 50, backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
          <svg width="200" height="140" viewBox={`${mmB.x0-mmB.p} ${mmB.y0-mmB.p} ${mmB.w} ${mmB.h}`}>
            {edges.map(ed => {
              const fn = nodes.find(n=>n.id===ed.sourceId), tn = nodes.find(n=>n.id===ed.targetId);
              if(!fn||!tn) return null;
              return <path key={"m"+ed.id} d={ePath(fn,tn)} fill="none" stroke={`rgba(${T.accentRgb}, 0.35)`} strokeWidth={3}/>;
            })}
            {nodes.map(n => {
              const c = COLORS[NTYPES[n.type]?.color] || T.accent;
              return <rect key={"m"+n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx={8}
                fill={sel.has(n.id) ? `${c}60` : `${c}30`} stroke={sel.has(n.id) ? c : `${c}50`} strokeWidth={2.5}/>;
            })}
            {wrap.current && (() => {
              const r = wrap.current.getBoundingClientRect();
              return <rect x={-vp.x/vp.z} y={-vp.y/vp.z} width={r.width/vp.z} height={r.height/vp.z}
                fill="none" stroke={T.accent} strokeWidth={2.5} strokeDasharray="6 4" rx={4}/>;
            })()}
          </svg>
        </div>
      )}

      {/* ═══════ 右键菜单 ═══════ */}
      {ctxMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={()=>setCtxMenu(null)} onContextMenu={e=>{e.preventDefault();setCtxMenu(null);}}/>
          <div style={{ position: "absolute", left: ctxMenu.sx, top: ctxMenu.sy, background: T.bg2, border: `1px solid ${T.borderHi}`, borderRadius: 12, padding: 6, minWidth: 220, zIndex: 200, backdropFilter: "blur(32px)", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", animation: "fadeIn 0.15s ease" }}>
            <div style={{ fontSize: 10, color: T.textDim, padding: "6px 12px 4px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>添加节点</div>
            {Object.entries(NTYPES).map(([t,m_]) => {
              const c = COLORS[m_.color] || T.accent;
              return <button key={t} onClick={()=>addNode(t, ctxMenu.x, ctxMenu.y)} className="ctx-item"><Icon name={m_.icon} size={13} c={c}/> {m_.label}</button>;
            })}
            {sel.size > 0 && (
              <>
                <div className="ctx-sep"/>
                <button onClick={()=>{dupSel(); setCtxMenu(null);}} className="ctx-item"><Icon name="copy" size={13}/> 复制 ({sel.size}) <span className="ctx-kbd">⌘D</span></button>
                <button onClick={()=>{delSel(); setCtxMenu(null);}} className="ctx-item danger"><Icon name="trash" size={13}/> 删除 ({sel.size}) <span className="ctx-kbd">Del</span></button>
              </>
            )}
            <div className="ctx-sep"/>
            <button onClick={()=>{fitV(); setCtxMenu(null);}} className="ctx-item"><Icon name="fit" size={13}/> 适应视图 <span className="ctx-kbd">F</span></button>
            <button onClick={()=>{saveProject(); setCtxMenu(null);}} className="ctx-item"><Icon name="save" size={13}/> 保存 <span className="ctx-kbd">⌘S</span></button>
            <button onClick={()=>{exportJSON(); setCtxMenu(null);}} className="ctx-item"><Icon name="download" size={13}/> 导出 JSON</button>
          </div>
        </>
      )}

      {/* ═══════ @ 引用 ═══════ */}
      {showMention && (() => {
        const filtered = nodes.filter(n => n.type !== "asset-folder" && n.id !== showMention.nodeId && (showMention.query === "" || n.name.toLowerCase().includes(showMention.query.toLowerCase())));
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 198 }} onClick={()=>setShowMention(null)}/>
            <div style={{ position: "fixed", left: showMention.screenX, top: showMention.screenY+6, background: T.bg2, border: `1px solid ${T.borderHi}`, borderRadius: 10, padding: 5, minWidth: 260, maxWidth: 340, zIndex: 300, backdropFilter: "blur(32px)", boxShadow: "0 12px 36px rgba(0,0,0,0.5)" }}>
              <div style={{ fontSize: 10, color: T.textDim, padding: "6px 12px 4px", fontWeight: 600 }}>@ 引用节点</div>
              {filtered.length === 0 ? <div style={{ padding: 12, fontSize: 11, color: T.textDim, textAlign: "center" }}>没有可引用的节点</div> : 
                filtered.slice(0,8).map(n => {
                  const mt = NTYPES[n.type], c = COLORS[mt?.color] || T.accent;
                  return (
                    <button key={n.id} onClick={()=>insertMention(showMention.nodeId, n.id)} className="ctx-item">
                      <Icon name={mt.icon} size={12} c={c}/>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
                      <span style={{ marginLeft: "auto", fontSize: 9, color: T.textDim }}>{mt.label}</span>
                    </button>
                  );
                })
              }
            </div>
          </>
        );
      })()}

      {/* ═══════ / 预设 ═══════ */}
      {showPreset && (() => {
        const filtered = PRESETS.filter(p => showPreset.query === "" || p.label.toLowerCase().includes(showPreset.query.toLowerCase()));
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 198 }} onClick={()=>setShowPreset(null)}/>
            <div style={{ position: "fixed", left: showPreset.screenX, top: showPreset.screenY+6, background: T.bg2, border: `1px solid ${T.borderHi}`, borderRadius: 10, padding: 5, minWidth: 240, zIndex: 300, backdropFilter: "blur(32px)", boxShadow: "0 12px 36px rgba(0,0,0,0.5)" }}>
              <div style={{ fontSize: 10, color: T.textDim, padding: "6px 12px 4px", fontWeight: 600 }}>/ 预设命令</div>
              {filtered.map(p => (
                <button key={p.key} onClick={()=>insertPreset(showPreset.nodeId, p)} className="ctx-item">
                  <div style={{ width: 20, height: 20, borderRadius: 4, background: `${T.accent}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: T.accent, fontFamily: "monospace" }}>/</div>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </>
        );
      })()}

      {/* ═══════ 设置面板 ═══════ */}
      {showSettings && (
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget) setShowSettings(false);}}>
          <div className="modal" style={{ width: 820, height: 620 }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>设置</h2>
              <button className="btn-icon" onClick={()=>setShowSettings(false)}><Icon name="x" size={14}/></button>
            </div>
            <div style={{ display: "flex", height: "calc(100% - 56px)" }}>
              <nav style={{ width: 180, borderRight: `1px solid ${T.border}`, padding: "14px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
                {[
                  { k: "api", l: "API 配置", icon: "key" },
                  { k: "dreamina", l: "即梦授权", icon: "terminal" },
                  { k: "theme", l: "主题", icon: "palette" },
                  { k: "about", l: "关于", icon: "info" },
                ].map(t => (
                  <button key={t.k} onClick={()=>setSettingsTab(t.k)} className={`settings-nav-item ${settingsTab===t.k?"active":""}`}>
                    <Icon name={t.icon} size={13}/> {t.l}
                  </button>
                ))}
              </nav>
              <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
                {settingsTab === "api" && (
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>API 配置</h3>
                    <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>平台配置已整理，获取 Key 链接均直达官网或控制台；即梦走本地授权运行时。</p>
                    
                    {["grsai", "apimart", "runninghub", "openai"].map(k => {
                      const prov = PROVIDERS[k];
                      return (
                        <div key={k} className="provider-card" style={{ marginTop: k === "grsai" ? 0 : 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                            <div style={{ width: 34, height: 34, borderRadius: 8, background: `${prov.color}20`, border: `1px solid ${prov.color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="key" size={15} c={prov.color}/></div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{prov.label}</div>
                              <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>
                                {k === "openai" ? "OpenAI 或兼容网关" : k === "runninghub" ? "图像生成 / 工作流 API" : "图像 / 文本模型"}
                              </div>
                            </div>
                            {prov.keyUrl && <a href={prov.keyUrl} target="_blank" rel="noopener" className="link-btn">获取 Key ↗</a>}
                          </div>
                          {k === "openai" && (
                            <>
                              <label className="form-label">接口地址 (Base URL)</label>
                              <input type="text" placeholder="https://api.openai.com" value={apiCfg.openai?.apiUrl || ""} onChange={e=>setApiCfg(c=>({...c, openai:{...c.openai, apiUrl:e.target.value}}))} className="form-input"/>
                            </>
                          )}
                          <label className="form-label" style={{ marginTop: k === "openai" ? 10 : 0 }}>API Key</label>
                          <input type="password" placeholder="sk-..." value={apiCfg[k]?.apiKey || ""} onChange={e=>setApiCfg(c=>({...c, [k]:{...c[k], apiKey:e.target.value}}))} className="form-input"/>
                          {k === "runninghub" && (
                            <>
                              <label className="form-label" style={{ marginTop: 10 }}>模型 API Key (企业级共享，可选)</label>
                              <input type="password" placeholder="选填" value={apiCfg.runninghub?.modelApiKey || ""} onChange={e=>setApiCfg(c=>({...c, runninghub:{...c.runninghub, modelApiKey:e.target.value}}))} className="form-input"/>
                            </>
                          )}
                        </div>
                      );
                    })}
                     
                    {/* 自定义 */}
                    <div className="provider-card" style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: `${T.accent}20`, border: `1px solid ${T.accent}40`, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="code" size={15} c={T.accent}/></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>自定义 API</div>
                          <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>默认按 OpenAI Chat Completions；高级项再展开</div>
                        </div>
                      </div>
                      
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 170px", gap: 12 }}>
                        <div>
                          <label className="form-label">接口地址 (Base URL)</label>
                          <input type="text" placeholder="https://api.openai.com" value={apiCfg.custom?.apiUrl || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, apiUrl:e.target.value}}))} className="form-input"/>
                        </div>
                        <div>
                          <label className="form-label">请求路径</label>
                          <input type="text" placeholder="/v1/chat/completions" value={apiCfg.custom?.endpointPath || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, endpointPath:e.target.value}}))} className="form-input"/>
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>常见填法: Base URL 写域名，请求路径保持 /v1/chat/completions。</div>
                      
                      <label className="form-label" style={{ marginTop: 12 }}>API Key</label>
                      <input type="password" placeholder="sk-..." value={apiCfg.custom?.apiKey || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, apiKey:e.target.value}}))} className="form-input"/>
                      
                      <label className="form-label" style={{ marginTop: 12 }}>默认模型 ID</label>
                      <input type="text" placeholder="gpt-4o, deepseek-chat, claude-opus-4..." value={apiCfg.custom?.modelId || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, modelId:e.target.value}}))} className="form-input"/>
                      <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>节点里也可以单独填写模型 ID；节点优先生效。</div>

                      <button className="btn-ghost" style={{ marginTop: 14 }} onClick={()=>setShowCustomAdvanced(v=>!v)}>
                        <Icon name={showCustomAdvanced ? "minus" : "plus"} size={12}/> 高级设置
                      </button>

                      {showCustomAdvanced && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                              <label className="form-label">认证方式</label>
                              <select value={apiCfg.custom?.authType || "bearer"} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, authType:e.target.value}}))} className="form-input">
                                <option value="bearer">Bearer Token</option>
                                <option value="header">自定义 Header</option>
                                <option value="query">Query 参数</option>
                              </select>
                            </div>
                            <div>
                              <label className="form-label">请求格式</label>
                              <select value={apiCfg.custom?.requestFormat || "openai"} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, requestFormat:e.target.value}}))} className="form-input">
                                <option value="openai">OpenAI 兼容</option>
                                <option value="custom">自定义 JSON</option>
                              </select>
                            </div>
                          </div>

                          {apiCfg.custom?.authType !== "bearer" && (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                              <div>
                                <label className="form-label">{apiCfg.custom?.authType === "query" ? "Query 参数名" : "Header 名"}</label>
                                <input type="text" placeholder={apiCfg.custom?.authType === "query" ? "api_key" : "Authorization"} value={apiCfg.custom?.headerName || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, headerName:e.target.value}}))} className="form-input"/>
                              </div>
                              <div>
                                <label className="form-label">值前缀</label>
                                <input type="text" placeholder="Bearer " value={apiCfg.custom?.headerPrefix || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, headerPrefix:e.target.value}}))} className="form-input"/>
                              </div>
                            </div>
                          )}

                          <label className="form-label" style={{ marginTop: 12 }}>响应取值路径</label>
                          <input type="text" placeholder="choices[0].message.content" value={apiCfg.custom?.responsePath || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, responsePath:e.target.value}}))} className="form-input"/>
                          <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>用于从响应 JSON 中提取生成结果。OpenAI 默认: choices[0].message.content</div>

                          {apiCfg.custom?.requestFormat === "custom" && (
                            <>
                              <label className="form-label" style={{ marginTop: 12 }}>自定义请求体 JSON</label>
                              <textarea placeholder={`{\n  "model": "your-model",\n  "input": "{{prompt}}"\n}`} value={apiCfg.custom?.customBody || ""} onChange={e=>setApiCfg(c=>({...c, custom:{...c.custom, customBody:e.target.value}}))} className="form-input" style={{minHeight:80, fontFamily:"monospace", fontSize:11}}/>
                              <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>使用 <code style={{background:T.surface, padding:"1px 4px", borderRadius:3}}>{`{{prompt}}`}</code> 作为提示词占位符</div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {settingsTab === "dreamina" && (
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>即梦授权</h3>
                    <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>即梦本地能力已集成到系统中，用户只需要网页登录或扫码授权。</p>
                    
                    {/* 运行时准备 */}
                    <div className="provider-card">
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: "#ec489922", border: "1px solid #ec489940", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="terminal" size={15} c="#ec4899"/></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>本地运行时</div>
                          <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>系统会自动准备即梦能力</div>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 10, lineHeight: 1.6 }}>
                        <div>点击「网页登录」或「扫码授权」时，系统会自动检测并准备本地能力。</div>
                        <div style={{ marginTop: 4 }}>准备完成后按即梦页面提示完成授权，回到这里刷新状态即可。</div>
                      </div>
                    </div>
                    
                    {/* 状态检测 */}
                    <div className="provider-card" style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: "#ec489922", border: "1px solid #ec489940", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="link" size={15} c="#ec4899"/></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>服务状态</div>
                          <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>{API_BASE}</div>
                        </div>
                        <div className="status-pill" style={{
                          background: dmStatus.loggedIn ? "rgba(16,185,129,0.15)" : dmStatus.connected ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)",
                          color: dmStatus.loggedIn ? "#34d399" : dmStatus.connected ? "#fbbf24" : "#ef4444",
                          borderColor: dmStatus.loggedIn ? "rgba(16,185,129,0.35)" : dmStatus.connected ? "rgba(245,158,11,0.35)" : "rgba(239,68,68,0.35)"
                        }}>{dmStatus.label}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn-primary" onClick={()=>refreshDreaminaStatus()}><Icon name="refresh" size={12}/> 检测状态</button>
                        <button className="btn-ghost" onClick={()=>startDreaminaAuth("/api/dreamina/web-login", "正在准备本地能力并打开网页登录...")}>网页登录</button>
                        <button className="btn-ghost" onClick={()=>startDreaminaAuth("/api/dreamina/qr-login", "正在准备本地能力并发起扫码授权...")}>扫码授权</button>
                        {dmStatus.loggedIn && <button className="btn-danger" onClick={()=>{ fetch(`${API_BASE}/api/dreamina/logout`, {method:"POST"}).then(()=>{setDmStatus({connected:true, loggedIn:false, label:"未登录"}); toastFn("已登出","info");}); }}>登出</button>}
                      </div>
                      {dmStatus.error && (
                        <div style={{ fontSize: 11, color: "#f87171", marginTop: 10, lineHeight: 1.55, wordBreak: "break-word" }}>
                          {dmStatus.error}
                        </div>
                      )}
                      {(dmStatus.userCode || dmStatus.authUrl) && !dmStatus.loggedIn && (
                        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 10, lineHeight: 1.65, wordBreak: "break-word" }}>
                          {dmStatus.userCode && <div>授权码：<b style={{ color: T.text }}>{dmStatus.userCode}</b></div>}
                          {dmStatus.authUrl && (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ marginBottom: 5, color: T.textDim }}>授权链接</div>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <input
                                  data-interactive="1"
                                  className="node-input"
                                  readOnly
                                  value={dmStatus.authUrl}
                                  onFocus={e=>e.target.select()}
                                  style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                                />
                                <button className="btn-ghost" onClick={()=>copyToClipboard(dmStatus.authUrl)} title="复制授权链接">
                                  <Icon name="copy" size={12}/> 复制
                                </button>
                                <button className="btn-ghost" onClick={()=>window.open(dmStatus.authUrl, "_blank", "noopener,noreferrer")}>打开</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    
                    {/* 支持模型 */}
                    <div className="provider-card" style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>支持的模型</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, marginBottom: 6, letterSpacing: "0.05em" }}>图像</div>
                          {IMAGE_MODELS.dreamina?.map(m_ => <div key={m_.id} style={{ fontSize: 11, padding: "4px 0", color: T.textMuted }}>· {m_.name}</div>)}
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, marginBottom: 6, letterSpacing: "0.05em" }}>视频</div>
                          {VIDEO_MODELS.dreamina?.map(m_ => <div key={m_.id} style={{ fontSize: 11, padding: "4px 0", color: T.textMuted }}>· {m_.name}</div>)}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 10 }}>视频时长支持 4-15 秒，节点内可逐秒选择。</div>
                    </div>
                  </div>
                )}

                {settingsTab === "theme" && (
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>主题配色</h3>
                    <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>选择您喜欢的全局配色方案。所有界面元素将同步切换。</p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                      {Object.entries(THEMES).map(([key, theme]) => {
                        const isActive = themeKey === key;
                        return (
                          <button key={key} onClick={()=>{setThemeKey(key); toastFn(`已切换到 ${theme.name}`, "success");}} style={{
                            background: theme.bg2, border: `2px solid ${isActive ? theme.accent : "transparent"}`,
                            borderRadius: 12, padding: 14, cursor: "pointer", fontFamily: "inherit",
                            display: "flex", flexDirection: "column", gap: 10, transition: "all 0.2s",
                            position: "relative", outline: "none",
                          }}>
                            {isActive && <div style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: "50%", background: theme.accent, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="check" size={11} c="white"/></div>}
                            <div style={{ height: 60, borderRadius: 8, background: theme.bg, border: `1px solid ${theme.border}`, position: "relative", overflow: "hidden" }}>
                              <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 30% 30%, ${theme.accent}40, transparent 60%), radial-gradient(circle at 70% 70%, ${theme.accent2}30, transparent 60%)` }}/>
                              <div style={{ position: "absolute", left: 12, top: 12, width: 32, height: 32, borderRadius: 6, background: theme.accent }}/>
                              <div style={{ position: "absolute", right: 12, top: 12, width: 24, height: 24, borderRadius: 6, background: theme.accent2, opacity: 0.7 }}/>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 18 }}>{theme.emoji}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{theme.name}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {settingsTab === "about" && (
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>关于</h3>
                    <div className="provider-card">
                      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg, ${T.accent}, ${T.accent2})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 8px 24px ${T.accent}40` }}>
                          <Icon name="spark" size={28} c="white"/>
                        </div>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>Cherry Canvas</div>
                          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>v3.0 · 基于节点的 AI 多模态画布编辑器</div>
                        </div>
                      </div>
                      
                      <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.7 }}>
                        <div style={{ marginBottom: 12, color: T.text, fontWeight: 600 }}>核心特性</div>
                        <div>· 🎨 无限画布 · 自由缩放、平移、小地图导航</div>
                        <div>· 🤖 多模态生成 · 图像 / 文本 / 视频 / 音频</div>
                        <div>· 🔌 灵活集成 · GRSAI / APIMart / RunningHub / OpenAI 兼容 / 自定义 API / 即梦本地授权</div>
                        <div>· 💾 项目管理 · 多画布切换、自动缓存、JSON 导入导出</div>
                        <div>· 🎨 主题换肤 · 10 套精选配色方案</div>
                        <div>· ⌨️ 高效操作 · @ 引用 / / 预设 / 完整快捷键</div>
                        <div>· 🔗 节点连线 · 拖拽连接，结果自动流转</div>
                        <div>· 📥 下载导出 · 单个或批量下载生成结果</div>
                      </div>
                      
                      <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.7, marginTop: 16 }}>
                        <div style={{ marginBottom: 8, color: T.text, fontWeight: 600 }}>支持的 API 提供商</div>
                        <div>· GRSAI - 图像 / 文本模型</div>
                        <div>· APIMart - 图像 / 文本模型</div>
                        <div>· RunningHub - 图像生成 / 工作流</div>
                        <div>· OpenAI 兼容 - 文本模型 / 兼容网关</div>
                        <div>· 自定义 API - 任意 OpenAI 兼容接口</div>
                        <div>· 即梦 - 本地授权运行时</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ 项目面板 ═══════ */}
      {showProjects && (
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget) setShowProjects(false);}}>
          <div className="modal" style={{ width: 560, maxHeight: "75vh" }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>项目</h2>
              <button className="btn-icon" onClick={()=>setShowProjects(false)}><Icon name="x" size={14}/></button>
            </div>
            <div style={{ padding: 20, overflowY: "auto", maxHeight: 500 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button className="btn-primary" onClick={saveProject}><Icon name="save" size={13}/> 保存当前</button>
                <button className="btn-ghost" onClick={exportJSON}><Icon name="download" size={13}/> 导出 JSON</button>
                <button className="btn-ghost" onClick={()=>{
                  if(confirm("确定清空当前画布？")){
                    dp({type:"load", n:[], e:[]}); setShowProjects(false); toastFn("已清空","info");
                  }
                }}><Icon name="plus" size={13}/> 新建空白</button>
              </div>
              {projects.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: T.textDim, fontSize: 12 }}>
                  <Icon name="folder" size={32}/>
                  <div style={{ marginTop: 12 }}>暂无已保存项目</div>
                  <div style={{ marginTop: 4, fontSize: 10 }}>按 Ctrl+S 保存当前画布</div>
                </div>
              ) : projects.sort((a,b)=>b.savedAt-a.savedAt).map(p => (
                <div key={p.id} className="project-card">
                  <div style={{ flex: 1, cursor: "pointer" }} onClick={async ()=>{ const loadedNodes = await hydrateSourceNodes(p.nodes||[]); dp({type:"load", n:loadedNodes, e:p.edges||[]}); setShowProjects(false); setTimeout(fitV,100); toastFn(`已加载: ${p.name}`,"success"); }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>{p.nodes?.length||0} 节点 · {p.edges?.length||0} 连线 · {new Date(p.savedAt).toLocaleString("zh-CN", {month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"})}</div>
                  </div>
                  <button className="btn-icon-sm danger" onClick={(e)=>{
                    e.stopPropagation();
                    if(confirm("确定删除？")){
                      const np = projects.filter(x=>x.id!==p.id);
                      setProjects(np); try {localStorage.setItem("cc-projects-v3", JSON.stringify(np));} catch{}
                      toastFn("已删除", "info");
                    }
                  }}><Icon name="trash" size={12}/></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ 快捷键面板 ═══════ */}
      {showKeyboard && (
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget) setShowKeyboard(false);}}>
          <div className="modal" style={{ width: 600, maxHeight: "75vh" }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}><Icon name="keyboard" size={16}/> 快捷键</h2>
              <button className="btn-icon" onClick={()=>setShowKeyboard(false)}><Icon name="x" size={14}/></button>
            </div>
            <div style={{ padding: 24, overflowY: "auto" }}>
              {[
                { title: "画布操作", items: [
                  ["双击空白", "新建图像节点"], ["Ctrl + 滚轮", "缩放画布"], ["滚轮", "平移画布"],
                  ["中键拖拽", "平移画布"], ["右键", "上下文菜单"], ["F", "适应视图"],
                ]},
                { title: "节点操作", items: [
                  ["单击", "选中节点"], ["Shift + 点击", "多选 / 取消选中"], ["框选", "批量选择"],
                  ["拖拽端口", "创建连线"], ["点击连线", "删除连线"], ["拖拽右下角", "调整节点大小"],
                ]},
                { title: "编辑", items: [
                  ["Ctrl + Z", "撤销"], ["Ctrl + Y", "重做"], ["Ctrl + D", "复制选中"],
                  ["Ctrl + A", "全选"], ["Del / Backspace", "删除"], ["Ctrl + S", "保存"],
                ]},
                { title: "提示词", items: [
                  ["@", "引用其他节点"], ["/", "调用预设命令"],
                ]},
                { title: "其他", items: [
                  ["?", "打开此面板"], ["Esc", "关闭所有弹窗"],
                ]},
              ].map(g => (
                <div key={g.title} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>{g.title}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {g.items.map(([k,v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                        <span style={{ color: T.textMuted }}>{v}</span>
                        <kbd style={{ padding: "2px 8px", borderRadius: 4, background: T.surface, border: `1px solid ${T.border}`, fontSize: 11, color: T.text, fontFamily: "inherit" }}>{k}</kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ 结果大图预览 + 下载 ═══════ */}
      {showVideoPlayer && (
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget) setShowVideoPlayer(null);}}>
          <div className="modal" style={{ width: "min(920px, 92vw)", maxHeight: "90vh" }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>{showVideoPlayer.name || "视频预览"}</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-ghost" onClick={()=>window.open(showVideoPlayer.url, "_blank", "noopener,noreferrer")}>新窗口播放</button>
                <button className="btn-icon" onClick={()=>setShowVideoPlayer(null)}><Icon name="x" size={14}/></button>
              </div>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <iframe
                key={showVideoPlayer.url}
                src={showVideoPlayer.url}
                title={showVideoPlayer.name || "video"}
                allow="autoplay; fullscreen"
                style={{ width: "100%", height: "min(70vh, 520px)", display: "block", background: "black", border: "none", borderRadius: 10 }}
              />
              <a href={showVideoPlayer.url} target="_blank" rel="noreferrer" className="btn-primary" style={{ justifyContent: "center", textDecoration: "none" }}>
                新窗口播放
              </a>
            </div>
          </div>
        </div>
      )}

      {showPreview && (
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget) setShowPreview(null);}}>
          <div className="modal" style={{ width: 720, maxHeight: "85vh" }}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>{showPreview.name} · 结果预览</h2>
              <button className="btn-icon" onClick={()=>setShowPreview(null)}><Icon name="x" size={14}/></button>
            </div>
            <div style={{ padding: 20, overflowY: "auto", maxHeight: 600 }}>
              {showPreview.results.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: T.textDim }}>暂无结果</div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                  {showPreview.results.map((r, i) => {
                    const c = COLORS[NTYPES[showPreview.nodeType]?.color] || T.accent;
                    const previewUrl = resultMediaUrlOf(r, showPreview.nodeType);
                    const previewPoster = showPreview.nodeType === "ai-video" ? playableVideoPosterOf(r) : resultPosterOf(r);
                    const previewVideoBaseUrl = showPreview.nodeType === "ai-video" ? playableVideoUrlOf(r) : "";
                    const previewVideoSrc = previewVideoBaseUrl
                      ? cacheBustedMediaUrl(previewVideoBaseUrl, resultSubmitIdOf(r) || r.ts || previewVideoBaseUrl)
                      : "";
                    return (
                      <div key={r.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                        <div style={{ aspectRatio: "1", background: `linear-gradient(135deg, ${c}30, ${c}08)`, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                          {showPreview.nodeType === "ai-text" && r.text ? (
                            <div style={{ padding: 14, fontSize: 11, color: T.text, lineHeight: 1.6, overflow: "auto", maxHeight: "100%" }}>{r.text}</div>
                          ) : showPreview.nodeType === "ai-video" && previewVideoSrc ? (
                            <video key={previewVideoSrc} data-interactive="1" poster={previewPoster || undefined} controls playsInline preload="metadata" draggable={false} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onDragStart={e=>e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "contain", background: "rgba(0,0,0,0.35)" }}>
                              <source src={previewVideoSrc} type="video/mp4" />
                            </video>
                          ) : previewUrl ? (
                            <img src={previewUrl} alt={r.fileName || `结果 ${i+1}`} draggable={false} onDragStart={e=>e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "contain" }}/>
                          ) : (
                            <Icon name={NTYPES[showPreview.nodeType]?.icon || "image"} size={48} c={c}/>
                          )}
                        </div>
                        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textMuted }}>
                            <span>结果 #{i+1}</span>
                            <span>{new Date(r.ts).toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"})}</span>
                          </div>
                          <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={()=>downloadResult(r, showPreview.nodeType)}>
                            <Icon name="download" size={12}/> 下载
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ 空状态 ═══════ */}
      {nodes.length === 0 && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center", pointerEvents: "none", zIndex: 3 }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 84, height: 84, borderRadius: 22, background: `linear-gradient(135deg, ${T.accent}25, ${T.accent2}15)`, border: `1px solid ${T.accent}40`, marginBottom: 22, boxShadow: `0 12px 40px ${T.accent}20` }}>
            <Icon name="spark" size={40} c={T.accent}/>
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8, background: `linear-gradient(135deg, ${T.text}, ${T.textMuted})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Cherry Canvas</h1>
          <p style={{ fontSize: 14, color: T.textMuted, marginBottom: 28 }}>基于节点的 AI 多模态画布</p>
          <div style={{ display: "inline-flex", gap: 10, flexWrap: "wrap", justifyContent: "center", pointerEvents: "auto" }}>
            {[["ai-image","image","图像"], ["ai-text","text","文本"], ["ai-video","video","视频"], ["ai-audio","audio","音频"]].map(([t,i,l]) => {
              const c_ = COLORS[NTYPES[t].color] || T.accent;
              return <button key={t} className="hero-btn" onClick={()=>{ const r = wrap.current.getBoundingClientRect(); addNode(t, (r.width/2-vp.x)/vp.z, (r.height/2-vp.y)/vp.z); }}>
                <Icon name={i} size={14} c={c_}/> {l}生成
              </button>;
            })}
          </div>
          <div style={{ marginTop: 28, fontSize: 11, color: T.textDim, display: "flex", gap: 16, justifyContent: "center" }}>
            <span>双击空白快速建</span><span>·</span><span>拖拽端口连线</span><span>·</span><span>按 ? 查看快捷键</span>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: "absolute", top: 62, left: "50%", transform: "translateX(-50%)",
          padding: "9px 18px", borderRadius: 10, fontSize: 12, fontWeight: 500, zIndex: 1000, pointerEvents: "none",
          animation: "fadeIn 0.2s ease", display: "flex", alignItems: "center", gap: 7,
          background: toast.type==="success" ? "rgba(16,185,129,0.15)" : toast.type==="error" ? "rgba(239,68,68,0.15)" : `rgba(${T.accentRgb}, 0.15)`,
          border: `1px solid ${toast.type==="success" ? "rgba(16,185,129,0.35)" : toast.type==="error" ? "rgba(239,68,68,0.35)" : `rgba(${T.accentRgb}, 0.35)`}`,
          color: toast.type==="success" ? "#34d399" : toast.type==="error" ? "#ef4444" : T.accent,
          backdropFilter: "blur(16px)"
        }}>
          {toast.type==="success" && <Icon name="check" size={13}/>}
          {toast.type==="error" && <Icon name="alert" size={13}/>}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

const CSS = (T, COLORS) => `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${T.borderHi}; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: ${T.textMuted}; }
  code { font-family: 'Fira Code', 'Consolas', monospace; }
  
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  .space-pan, .space-pan * { cursor: grab !important; }
  .space-pan.is-panning, .space-pan.is-panning * { cursor: grabbing !important; }
  .perf-mode, .perf-mode * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  .perf-mode * { transition-duration: 0.08s !important; }
  .perf-mode .modal-overlay { background: rgba(0,0,0,0.72) !important; }
  
  .btn-icon { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: transparent; border: 1px solid transparent; border-radius: 7px; cursor: pointer; color: ${T.textMuted}; transition: all 0.15s; flex-shrink: 0; }
  .btn-icon:hover:not(:disabled) { background: ${T.surfaceHi}; color: ${T.text}; }
  .btn-icon:disabled { opacity: 0.3; cursor: default; }
  .btn-icon-sm { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 6px; cursor: pointer; color: ${T.textDim}; transition: all 0.15s; flex-shrink: 0; }
  .btn-icon-sm:hover { background: ${T.surfaceHi}; color: ${T.text}; }
  .btn-icon-sm.danger:hover { background: rgba(239,68,68,0.15); color: #ef4444; }
  
  .canvas-tab { padding: 6px 14px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: ${T.textMuted}; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all 0.15s; display: flex; align-items: center; gap: 6px; }
  .canvas-tab:hover { background: ${T.surface}; color: ${T.text}; }
  .canvas-tab.active { background: rgba(${T.accentRgb}, 0.15); border-color: rgba(${T.accentRgb}, 0.35); color: ${T.accent}; }
  .canvas-tab-x { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 3px; opacity: 0; transition: all 0.15s; }
  .canvas-tab:hover .canvas-tab-x { opacity: 1; }
  .canvas-tab-x:hover { background: rgba(239,68,68,0.2); color: #ef4444; }
  .canvas-tab-add { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: transparent; border: 1px dashed ${T.borderHi}; border-radius: 7px; color: ${T.textMuted}; cursor: pointer; transition: all 0.15s; }
  .canvas-tab-add:hover { background: ${T.surface}; color: ${T.text}; border-color: ${T.text}; }
  
  .dock-btn { width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 11px; cursor: pointer; color: ${T.textMuted}; transition: all 0.15s; position: relative; }
  .dock-btn:hover { background: ${T.surfaceHi}; color: ${T.text}; }
  .dock-btn-primary { background: linear-gradient(135deg, ${T.accent}e6, ${T.accent2}e6); color: white !important; box-shadow: 0 4px 16px rgba(${T.accentRgb}, 0.4); }
  .dock-btn-primary:hover { box-shadow: 0 6px 22px rgba(${T.accentRgb}, 0.55); transform: translateY(-1px); background: linear-gradient(135deg, ${T.accent}, ${T.accent2}); }
  
  .dock-pill { min-width: 34px; height: 32px; padding: 0 9px; display: flex; align-items: center; justify-content: center; gap: 5px; background: transparent; border: none; border-radius: 16px; cursor: pointer; color: ${T.textMuted}; transition: all 0.15s; font-family: inherit; font-size: 12px; font-weight: 500; }
  .dock-pill:hover { background: ${T.surfaceHi}; color: ${T.text}; }
  .dock-pill.on { background: rgba(${T.accentRgb}, 0.18); color: ${T.accent}; }
  .dock-pill-sep { width: 1px; height: 16px; background: ${T.border}; margin: 0 2px; }
  .zoom-display { min-width: 52px; cursor: default !important; font-variant-numeric: tabular-nums; color: ${T.textMuted}; }
  .zoom-display:hover { background: transparent !important; color: ${T.textMuted} !important; }
  
  .add-menu-item { display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 11px; background: none; border: none; border-radius: 9px; color: ${T.text}; cursor: pointer; font-family: inherit; transition: background 0.1s; }
  .add-menu-item:hover { background: ${T.surfaceHi}; }
  
  .ctx-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 12px; background: none; border: none; border-radius: 8px; color: ${T.text}; font-size: 12px; cursor: pointer; font-family: inherit; transition: background 0.1s; text-align: left; }
  .ctx-item:hover { background: ${T.surfaceHi}; }
  .ctx-item.danger { color: #ef4444; }
  .ctx-item.danger:hover { background: rgba(239,68,68,0.1); }
  .ctx-sep { height: 1px; background: ${T.border}; margin: 4px 8px; }
  .ctx-kbd { margin-left: auto; font-size: 10px; color: ${T.textDim}; padding: 2px 6px; border-radius: 4px; background: ${T.surface}; border: 1px solid ${T.border}; }
  
  .tb-mini { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 6px; cursor: pointer; color: ${T.textMuted}; transition: all 0.12s; }
  .tb-mini:hover { background: ${T.surfaceHi}; color: ${T.text}; }
  .tb-mini.danger:hover { background: rgba(239,68,68,0.18); color: #ef4444; }
  
  .node-select, .node-input { background: rgba(0,0,0,0.3); border: 1px solid ${T.border}; border-radius: 6px; color: ${T.text}; padding: 6px 22px 6px 9px; font-size: 11.5px; font-family: inherit; outline: none; cursor: pointer; transition: border-color 0.2s; min-width: 0; width: 100%; }
  .node-input { padding-right: 9px; cursor: text; }
  .node-select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(T.textMuted)}' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; }
  .node-select:hover, .node-input:hover { border-color: ${T.borderHi}; }
  .node-select:focus, .node-input:focus { border-color: rgba(${T.accentRgb}, 0.6); }
  .node-select option { background: ${T.bg2}; color: ${T.text}; padding: 4px; }
  
  .ratio-pill { padding: 3px 8px; border-radius: 5px; border: 1px solid ${T.border}; background: ${T.surface}; color: ${T.textMuted}; font-size: 10px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.12s; }
  .ratio-pill:hover { background: ${T.surfaceHi}; color: ${T.text}; }
  .ratio-pill.on { background: rgba(${T.accentRgb}, 0.2); border-color: rgba(${T.accentRgb}, 0.45); color: ${T.accent}; }
  
  .node-prompt { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid ${T.border}; border-radius: 8px; color: ${T.text}; padding: 9px 11px; font-size: 12px; font-family: inherit; line-height: 1.55; resize: none; outline: none; transition: all 0.2s; cursor: text; }
  .node-prompt:focus { border-color: rgba(${T.accentRgb}, 0.5); background: rgba(0,0,0,0.4); }
  .node-prompt::placeholder { color: ${T.textDim}; }
  
  .gen-btn { padding: 8px; border-radius: 8px; border: none; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px; color: white; }
  .gen-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(${T.accentRgb}, 0.35); }
  .gen-btn:disabled { opacity: 0.7; cursor: default; transform: none !important; }
  .gen-btn.generating { background: ${T.surface} !important; color: ${T.textMuted}; }
  .gen-btn.done { background: rgba(16,185,129,0.15) !important; color: #34d399; border: 1px solid rgba(16,185,129,0.25); }
  .gen-btn.error { background: rgba(239,68,68,0.15) !important; color: #ef4444; border: 1px solid rgba(239,68,68,0.25); }
  .gen-btn-icon { width: 34px; height: 34px; padding: 0; border-radius: 8px; border: 1px solid ${T.border}; background: ${T.surface}; color: ${T.text}; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
  .gen-btn-icon:hover { background: ${T.surfaceHi}; border-color: ${T.borderHi}; transform: translateY(-1px); }
  
  .modal-overlay { position: absolute; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.65); backdrop-filter: blur(8px); animation: fadeIn 0.2s ease; }
  .modal { background: ${T.bg2}; border: 1px solid ${T.borderHi}; border-radius: 16px; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,0.6); animation: fadeIn 0.2s ease; }
  .modal-header { padding: 16px 20px; border-bottom: 1px solid ${T.border}; display: flex; align-items: center; justify-content: space-between; }
  
  .settings-nav-item { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: none; border: 1px solid transparent; border-radius: 8px; color: ${T.textMuted}; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all 0.15s; text-align: left; }
  .settings-nav-item:hover { background: ${T.surface}; color: ${T.text}; }
  .settings-nav-item.active { background: rgba(${T.accentRgb}, 0.15); border-color: rgba(${T.accentRgb}, 0.35); color: ${T.accent}; }
  
  .provider-card { background: ${T.surface}; border: 1px solid ${T.border}; border-radius: 12px; padding: 16px; }
  .form-label { display: block; font-size: 11px; color: ${T.textMuted}; font-weight: 500; margin-bottom: 6px; }
  .form-input { width: 100%; background: rgba(0,0,0,0.25); border: 1px solid ${T.border}; border-radius: 8px; color: ${T.text}; padding: 8px 12px; font-size: 12px; font-family: inherit; outline: none; transition: border-color 0.2s; }
  .form-input:focus { border-color: rgba(${T.accentRgb}, 0.5); }
  .form-input::placeholder { color: ${T.textDim}; }
  
  .link-btn { font-size: 11px; color: #fbbf24; text-decoration: none; padding: 4px 10px; border-radius: 6px; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); transition: all 0.15s; }
  .link-btn:hover { background: rgba(245,158,11,0.2); }
  
  .status-pill { padding: 4px 11px; border-radius: 20px; font-size: 11px; font-weight: 600; border-width: 1px; border-style: solid; }
  
  .btn-primary { padding: 7px 14px; border-radius: 8px; border: none; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(135deg, ${T.accent}, ${T.accent2}); color: white; }
  .btn-primary:hover { box-shadow: 0 4px 16px rgba(${T.accentRgb}, 0.4); transform: translateY(-1px); }
  .btn-ghost { padding: 7px 14px; border-radius: 8px; border: 1px solid ${T.border}; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; background: ${T.surface}; color: ${T.text}; }
  .btn-ghost:hover { background: ${T.surfaceHi}; }
  .btn-danger { padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(239,68,68,0.3); font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; background: rgba(239,68,68,0.12); color: #ef4444; }
  .btn-danger:hover { background: rgba(239,68,68,0.2); }
  
  .project-card { display: flex; align-items: center; gap: 8px; padding: 13px 14px; background: ${T.surface}; border: 1px solid ${T.border}; border-radius: 10px; margin-bottom: 8px; transition: all 0.15s; }
  .project-card:hover { background: ${T.surfaceHi}; border-color: ${T.borderHi}; }
  
  .hero-btn { padding: 10px 18px; border-radius: 10px; border: 1px solid ${T.borderHi}; background: ${T.surface}; color: ${T.text}; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 8px; transition: all 0.2s; }
  .hero-btn:hover { background: ${T.surfaceHi}; border-color: ${T.text}; transform: translateY(-1px); }
  
  .preview-hover:hover { opacity: 1 !important; }
`;
