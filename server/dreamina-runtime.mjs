import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.CHERRY_RUNTIME_PORT || 8777);
const OUTPUT_DIR = path.resolve(process.env.DREAMINA_OUTPUT_DIR || path.join(process.cwd(), "dreamina-output"));
const REF_DIR = path.join(OUTPUT_DIR, ".refs");
const INSTALL_URL = "https://jimeng.jianying.com/cli";
const DOWNLOAD_BASE = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";
const SKILL_URL = `${DOWNLOAD_BASE}/SKILL.md`;
const VERSION_URL = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/version.json";
const CLI_COMMANDS = ["dreamina", "jimeng-cli"];

let loginPollProcess = null;
let installPromise = null;
let currentAuth = null;
let runtimeState = {
  phase: "idle",
  message: "本地运行时待授权",
  lastError: "",
  updatedAt: Date.now(),
};

const runtimeEnv = () => {
  const home = os.homedir();
  const pathCandidates = [
    path.join(home, "bin"),
    path.join(home, ".jimeng", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs", "jimeng-cli", "bin"),
  ];
  return {
    ...process.env,
    PATH: [...pathCandidates, process.env.PATH || ""].join(path.delimiter),
  };
};

const setRuntime = (patch) => {
  runtimeState = { ...runtimeState, ...patch, updatedAt: Date.now() };
};

const decodeOutput = (chunks) => {
  const buffer = Buffer.concat(chunks);
  if(!buffer.length) return "";
  let nullBytes = 0;
  for(const byte of buffer) if(byte === 0) nullBytes++;
  return nullBytes > buffer.length / 8 ? buffer.toString("utf16le") : buffer.toString("utf8");
};

const run = (command, args = [], { timeoutMs = 30000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    env: runtimeEnv(),
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`${command} 执行超时`));
  }, timeoutMs);
  child.stdout?.on("data", d => { stdoutChunks.push(Buffer.from(d)); });
  child.stderr?.on("data", d => { stderrChunks.push(Buffer.from(d)); });
  child.on("error", err => {
    clearTimeout(timer);
    reject(err);
  });
  child.on("close", code => {
    clearTimeout(timer);
    const stdout = decodeOutput(stdoutChunks);
    const stderr = decodeOutput(stderrChunks);
    if(code === 0) resolve({ stdout, stderr });
    else reject(new Error((stderr || stdout || `${command} 退出码 ${code}`).trim()));
  });
});

const lines = (text) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const unique = (items) => [...new Set(items.filter(Boolean))];

const findCommandPaths = async (command) => {
  try {
    const result = process.platform === "win32"
      ? await run("where.exe", [command], { timeoutMs: 6000 })
      : await run("sh", ["-lc", `command -v ${command}`], { timeoutMs: 6000 });
    return lines(result.stdout);
  } catch {
    return [];
  }
};

const findCommand = async (command) => (await findCommandPaths(command))[0] || "";

const findCliCommand = async () => {
  for(const command of CLI_COMMANDS){
    const found = await findCommand(command);
    if(found) return found;
  }
  return "";
};

const commonBashPaths = () => {
  if(process.platform !== "win32") return [];
  const home = os.homedir();
  return [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(home, "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    path.join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"),
  ];
};

const isGitBash = (candidate) => /[\\/]Git[\\/]/i.test(candidate) || /[\\/]scoop[\\/]apps[\\/]git[\\/]/i.test(candidate);

const findUsableBash = async () => {
  const fromPath = await findCommandPaths("bash");
  const candidates = unique([...commonBashPaths(), ...fromPath])
    .filter(candidate => fromPath.includes(candidate) || fs.existsSync(candidate))
    .sort((a, b) => Number(isGitBash(b)) - Number(isGitBash(a)));

  for(const candidate of candidates){
    try {
      const result = await run(candidate, ["-lc", "echo ok"], { timeoutMs: 8000 });
      if(/\bok\b/.test(result.stdout)) return candidate;
    } catch {}
  }
  return "";
};

const isWindowsCommandScript = (file) => process.platform === "win32" && /\.(cmd|bat)$/i.test(file);

const downloadFile = async (url, filePath) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if(!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
};

const mimeForFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json; charset=utf-8",
  })[ext] || "application/octet-stream";
};

const stripExt = (value = "") => String(value || "").replace(/\.[^./\\]+$/u, "");
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const safeName = (value = "file") => {
  const cleaned = String(value || "file")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._\s-]+|[._\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || "file";
};
const contentDisposition = (filename = "download") => {
  const safe = safeName(path.basename(String(filename || "download"))) || "download";
  const ascii = safe.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
};

const extForMime = (mime = "") => ({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
})[String(mime).toLowerCase()] || ".png";

const outputUrlForPath = (filePath) => {
  if(!filePath) return "";
  const resolved = path.resolve(filePath);
  const outputRoot = path.resolve(OUTPUT_DIR);
  if(!resolved.toLowerCase().startsWith(outputRoot.toLowerCase())) return "";
  return `http://127.0.0.1:${PORT}/output/${encodeURIComponent(path.basename(resolved))}`;
};

const isInsideDir = (filePath, dirPath) => {
  const resolved = path.resolve(filePath).toLowerCase();
  const root = path.resolve(dirPath).toLowerCase();
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
};
const isVideoFile = (filePath = "") => /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(filePath);
const isImageFile = (filePath = "") => /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(filePath) && !/_poster\.jpe?g(?:[?#].*)?$/i.test(filePath);
const mediaMatchesType = (value = "", type = "image") => type === "video" ? isVideoFile(value) : isImageFile(value);

const referenceBaseName = (ref = {}, index = 0) => safeName(stripExt(ref.name || ref.displayName || ref.fileName || `reference_${index + 1}`));
const referencePath = (ref = {}, index = 0, mime = "") => path.join(REF_DIR, `${Date.now()}_${index}_${referenceBaseName(ref, index)}${extForMime(mime)}`);

const webVideoPathFor = (filePath) => path.join(OUTPUT_DIR, `${path.basename(filePath, path.extname(filePath))}_web.mp4`);

const playableVideoPath = async (filePath) => {
  if(!filePath || !fs.existsSync(filePath) || path.extname(filePath).toLowerCase() !== ".mp4" || path.basename(filePath).endsWith("_web.mp4")) return filePath;
  const webPath = webVideoPathFor(filePath);
  try {
    if(fs.existsSync(webPath)){
      const [sourceStat, webStat] = await Promise.all([fs.promises.stat(filePath), fs.promises.stat(webPath)]);
      if(webStat.size > 0 && webStat.mtimeMs >= sourceStat.mtimeMs) return webPath;
    }
    const ffmpeg = await findCommand("ffmpeg");
    if(!ffmpeg) return filePath;
    await run(ffmpeg, ["-y", "-i", filePath, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", webPath], { timeoutMs: 60000 });
    return fs.existsSync(webPath) ? webPath : filePath;
  } catch {
    return filePath;
  }
};

const resolveOutputFile = async (requestedPath) => {
  const root = path.resolve(OUTPUT_DIR);
  const resolved = path.resolve(requestedPath);
  if(!resolved.toLowerCase().startsWith(root.toLowerCase())) return "";
  const ext = path.extname(resolved).toLowerCase();
  if(fs.existsSync(resolved)){
    if(ext === ".mp4" && !path.basename(resolved).endsWith("_web.mp4")){
      const webResolved = webVideoPathFor(resolved);
      if(fs.existsSync(webResolved)) return webResolved;
    }
    return resolved;
  }
  if(ext === ".mp4" && path.basename(resolved).endsWith("_web.mp4")){
    const original = resolved.replace(/_web\.mp4$/i, ".mp4");
    if(fs.existsSync(original)) return await playableVideoPath(original);
  }
  const requestedName = path.basename(resolved);
  const submitId = requestedName.match(uuidPattern)?.[0];
  if(!submitId) return "";
  const files = await fs.promises.readdir(OUTPUT_DIR).catch(() => []);
  const candidates = files
    .filter(name => name.toLowerCase().startsWith(submitId.toLowerCase()))
    .map(name => path.join(OUTPUT_DIR, name));
  if(ext === ".jpg" || ext === ".jpeg" || requestedName.includes("poster")){
    return candidates.find(file => /_web_poster\.jpe?g$/i.test(file))
      || candidates.find(file => /_poster\.jpe?g$/i.test(file))
      || "";
  }
  const webMp4 = candidates.find(file => /_web\.mp4$/i.test(file));
  if(webMp4) return webMp4;
  const mp4 = candidates.find(file => /\.mp4$/i.test(file));
  return mp4 ? await playableVideoPath(mp4) : "";
};

const findOutputBySubmitId = async (submitId, { poster = false, type = "video" } = {}) => {
  if(!submitId) return "";
  const files = await fs.promises.readdir(OUTPUT_DIR).catch(() => []);
  const candidates = files
    .filter(name => name.toLowerCase().startsWith(String(submitId).toLowerCase()))
    .map(name => path.join(OUTPUT_DIR, name));
  if(poster){
    return candidates.find(file => /_web_poster\.jpe?g$/i.test(file))
      || candidates.find(file => /_poster\.jpe?g$/i.test(file))
      || "";
  }
  if(type === "image"){
    return candidates.find(file => isImageFile(file)) || "";
  }
  const webMp4 = candidates.find(file => /_web\.mp4$/i.test(file));
  if(webMp4) return webMp4;
  const mp4 = candidates.find(file => /\.mp4$/i.test(file));
  return mp4 ? await playableVideoPath(mp4) : "";
};

const resolveSubmitOutput = async (submitId, opts = {}) => {
  let file = await findOutputBySubmitId(submitId, opts);
  if(file) return { file, payload: null };
  if(opts.poster) return { file: "", payload: null };
  const payload = await queryDreaminaResult(submitId, opts.type === "video" ? 120000 : 60000).catch(err => ({ ok: false, error: err.message }));
  file = await findOutputBySubmitId(submitId, opts);
  return { file, payload };
};

const ensureVideoPoster = async (filePath) => {
  if(!filePath || !fs.existsSync(filePath) || !mimeForFile(filePath).startsWith("video/")) return "";
  const posterPath = path.join(OUTPUT_DIR, `${path.basename(filePath, path.extname(filePath))}_poster.jpg`);
  if(fs.existsSync(posterPath)) return outputUrlForPath(posterPath);
  try {
    const ffmpeg = await findCommand("ffmpeg");
    if(!ffmpeg) return "";
    await run(ffmpeg, ["-y", "-ss", "0.2", "-i", filePath, "-frames:v", "1", "-q:v", "3", posterPath], { timeoutMs: 30000 });
    return fs.existsSync(posterPath) ? outputUrlForPath(posterPath) : "";
  } catch {
    return "";
  }
};

const collectLocalPaths = (value, out = []) => {
  if(!value) return out;
  if(typeof value === "string"){
    if(/^[A-Za-z]:\\/.test(value) || value.startsWith("/") || value.startsWith("file://")){
      out.push(value.startsWith("file://") ? new URL(value).pathname : value);
    }
    return out;
  }
  if(Array.isArray(value)){
    value.forEach(item => collectLocalPaths(item, out));
    return out;
  }
  if(typeof value === "object"){
    Object.values(value).forEach(item => collectLocalPaths(item, out));
  }
  return out;
};

const materializeReference = async (ref = {}, index = 0) => {
  await fs.promises.mkdir(REF_DIR, { recursive: true });
  if(ref.path && fs.existsSync(ref.path)){
    const mime = ref.mimeType || mimeForFile(ref.path);
    const filePath = referencePath(ref, index, mime);
    await fs.promises.copyFile(ref.path, filePath);
    return filePath;
  }

  if(ref.url){
    if(ref.url.startsWith(`http://127.0.0.1:${PORT}/output/`)){
      const local = path.join(OUTPUT_DIR, path.basename(decodeURIComponent(new URL(ref.url).pathname)));
      if(fs.existsSync(local)){
        const mime = ref.mimeType || mimeForFile(local);
        const filePath = referencePath(ref, index, mime);
        await fs.promises.copyFile(local, filePath);
        return filePath;
      }
    }
    const res = await fetch(ref.url, { signal: AbortSignal.timeout(60000) });
    if(!res.ok) throw new Error(`参考图下载失败 ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0] || ref.mimeType || "image/png";
    const filePath = referencePath(ref, index, mime);
    await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
    return filePath;
  }

  if(ref.dataUrl){
    const match = String(ref.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if(!match) throw new Error("参考图数据格式无效");
    const mime = match[1];
    const filePath = referencePath(ref, index, mime);
    await fs.promises.writeFile(filePath, Buffer.from(match[2], "base64"));
    return filePath;
  }

  return "";
};

const materializeReferences = async (refs = []) => {
  const files = [];
  for(const [index, ref] of refs.entries()){
    const file = await materializeReference(ref, index);
    if(file) files.push(file);
  }
  return files;
};

const installCliWindowsDirect = async () => {
  if(process.platform !== "win32") return false;
  if(process.arch !== "x64") throw new Error(`暂不支持当前 Windows 架构: ${process.arch}`);

  const home = os.homedir();
  const installDir = process.env.DREAMINA_INSTALL_DIR || process.env.DREAMINA_CLI_INSTALL_DIR || path.join(home, "bin");
  const targetPath = path.join(installDir, "dreamina.exe");
  setRuntime({ phase: "installing", message: "正在下载即梦官方 Windows CLI", lastError: "" });
  await downloadFile(`${DOWNLOAD_BASE}/dreamina_cli_windows_amd64.exe`, targetPath);
  await downloadFile(SKILL_URL, path.join(home, ".dreamina_cli", "dreamina", "SKILL.md"));
  await downloadFile(VERSION_URL, path.join(home, ".dreamina_cli", "version.json"));
  return true;
};

const runCli = async (args = [], options = {}) => {
  const cliBin = await findCliCommand();
  if(!cliBin) throw new Error("没有找到 dreamina CLI，请先准备本地能力。");
  return run(cliBin, args, options);
};

const parseJsonOutput = (text = "") => {
  const trimmed = text.trim();
  if(!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if(!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
};

const cliAuthStatus = async () => {
  try {
    const result = await runCli(["user_credit"], { timeoutMs: 20000 });
    return {
      loggedIn: true,
      account: parseJsonOutput(result.stdout),
      raw: result.stdout.trim(),
    };
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
};

const parseLoginOutput = (text = "") => {
  const json = parseJsonOutput(text);
  const field = (name) => json?.[name] || json?.[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  const match = (pattern) => text.match(pattern)?.[1]?.trim() || "";
  const verificationUriComplete = field("verification_uri_complete")
    || match(/verification_uri_complete\s*[:=]\s*(https?:\/\/\S+)/i);
  const verificationUri = field("verification_uri")
    || match(/verification_uri\s*[:=]\s*(https?:\/\/\S+)/i);
  const firstUrl = match(/(https?:\/\/\S+)/i);
  return {
    authUrl: verificationUriComplete || verificationUri || firstUrl,
    verificationUri,
    verificationUriComplete,
    userCode: field("user_code") || match(/user_code\s*[:=]\s*([A-Z0-9-]+)/i),
    deviceCode: field("device_code") || match(/device_code\s*[:=]\s*([^\s]+)/i),
    output: text.trim(),
  };
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const readJsonBody = async (req) => {
  const body = await readBody(req);
  if(!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
};

const stripDreaminaPrefix = (model = "") => String(model || "").replace(/^dreamina\//, "");

const dreaminaImageModel = (model = "") => {
  const value = stripDreaminaPrefix(model).replace(/^seedream[-_]?/i, "");
  if(value === "5.0-lite") return "5.0";
  if(["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "5.0"].includes(value)) return value;
  const match = value.match(/\d+\.\d+/);
  return match?.[0] || "";
};

const dreaminaVideoModel = (model = "") => {
  const value = stripDreaminaPrefix(model);
  if(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip"].includes(value)) return value;
  return "";
};

const collectUrls = (value, out = []) => {
  if(!value) return out;
  if(typeof value === "string"){
    const matches = value.match(/https?:\/\/[^\s"'<>\\)]+|file:\/\/[^\s"'<>\\)]+/g) || [];
    out.push(...matches);
    return out;
  }
  if(Array.isArray(value)){
    value.forEach(item => collectUrls(item, out));
    return out;
  }
  if(typeof value === "object"){
    Object.values(value).forEach(item => collectUrls(item, out));
  }
  return out;
};

const findSubmitId = (value, raw = "") => {
  const keys = ["submit_id", "submitId", "task_id", "taskId", "id"];
  const visit = (item) => {
    if(!item || typeof item !== "object") return "";
    for(const key of keys){
      if(typeof item[key] === "string" && item[key]) return item[key];
    }
    for(const child of Object.values(item)){
      const found = visit(child);
      if(found) return found;
    }
    return "";
  };
  return visit(value) || raw.match(/(?:submit_id|submitId|task_id|taskId)\s*[:=]\s*([A-Za-z0-9_-]+)/)?.[1] || "";
};

const dreaminaResultPayload = async (type, stdout = "", stderr = "") => {
  const raw = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
  const data = parseJsonOutput(raw);
  const rawUrls = collectUrls(data || raw);
  const rawLocalPaths = collectLocalPaths(data || raw);
  const hasVideoResult = rawUrls.some(isVideoFile)
    || rawLocalPaths.some(isVideoFile)
    || (Array.isArray(data?.result_json?.videos) && data.result_json.videos.length > 0)
    || (Array.isArray(data?.data?.result_json?.videos) && data.data.result_json.videos.length > 0);
  const mediaType = type === "video" || hasVideoResult ? "video" : "image";
  const urls = [...new Set(rawUrls
    .filter(url => !url.includes("jimeng.jianying.com/ai-tool/cli-auth"))
    .filter(url => mediaMatchesType(url, mediaType)))];
  const discoveredLocalPaths = rawLocalPaths
    .filter(file => fs.existsSync(file))
    .filter(file => isInsideDir(file, OUTPUT_DIR))
    .filter(file => mediaMatchesType(file, mediaType));
  const localPaths = [...new Set(await Promise.all(discoveredLocalPaths.map(file => mediaType === "video" ? playableVideoPath(file) : file)))];
  const outputUrls = localPaths.map(outputUrlForPath).filter(Boolean);
  const allUrls = [...new Set([...outputUrls, ...urls])];
  const media = [];
  for(const [index, url] of allUrls.entries()){
    const localPath = localPaths[index] || "";
    media.push({
      url,
      localPath,
      mimeType: localPath ? mimeForFile(localPath) : "",
      poster: localPath ? await ensureVideoPoster(localPath) : "",
    });
  }
  const posters = media.map(item => item.poster).filter(Boolean);
  const submitId = findSubmitId(data, raw);
  return {
    ok: true,
    provider: "dreamina",
    type,
    submitId,
    url: allUrls[0] || "",
    urls: allUrls,
    poster: posters[0] || "",
    posters,
    media,
    localPaths,
    text: submitId
      ? `即梦任务已提交${allUrls[0] ? "并返回结果" : "，如未返回媒体结果请稍后用任务 ID 查询"}：${submitId}`
      : (allUrls[0] ? "即梦已返回生成结果" : raw.slice(0, 1200)),
    data: data || null,
    raw,
  };
};

const queryDreaminaResult = async (submitId, timeoutMs = 120000) => {
  if(!submitId) return null;
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const result = await runCli(["query_result", `--submit_id=${submitId}`, `--download_dir=${OUTPUT_DIR}`], { timeoutMs });
  return await dreaminaResultPayload("query", result.stdout, result.stderr);
};

const listDreaminaTasks = async (limit = 20) => {
  await installCli();
  const result = await runCli(["list_task", `--limit=${Math.min(Math.max(Number(limit) || 20, 1), 50)}`], { timeoutMs: 30000 });
  const data = parseJsonOutput(result.stdout);
  return {
    ok: true,
    tasks: Array.isArray(data) ? data : (data?.tasks || data?.data || []),
    raw: result.stdout,
  };
};

const runDreaminaGeneration = async (input = {}) => {
  await installCli();
  const auth = await cliAuthStatus();
  if(!auth.loggedIn) throw new Error("即梦未登录，请先在设置里完成网页登录授权。");

  const type = input.type === "video" || input.nodeType === "ai-video" ? "video" : "image";
  const prompt = String(input.prompt || "").trim();
  if(!prompt) throw new Error("请输入提示词");

  const requestedPoll = Number(input.poll);
  const defaultPoll = type === "video" ? 10 : 12;
  const maxPoll = type === "video" ? 30 : 60;
  const poll = Math.min(Math.max(Number.isFinite(requestedPoll) ? requestedPoll : defaultPoll, 1), maxPoll);
  const referenceFiles = await materializeReferences(input.referenceImages || input.references || []);
  const args = [];
  if(type === "image"){
    const modelVersion = dreaminaImageModel(input.model);
    args.push(referenceFiles.length ? "image2image" : "text2image", "--prompt", prompt, "--poll", String(poll));
    if(referenceFiles.length) args.push("--images", referenceFiles.slice(0, 10).join(","));
    if(input.ratio || input.aspectRatio) args.push("--ratio", String(input.ratio || input.aspectRatio));
    if(modelVersion) args.push("--model_version", modelVersion);
  } else {
    const modelVersion = dreaminaVideoModel(input.model);
    if(!modelVersion) throw new Error(`当前即梦 CLI 的文生视频不支持模型：${input.model || "未选择"}`);
    const duration = Math.min(Math.max(Number(input.duration || 5), 4), 15);
    const resolution = String(input.resolution || "720p");
    args.push(referenceFiles.length ? "multimodal2video" : "text2video", "--prompt", prompt, "--duration", String(duration), "--model_version", modelVersion, "--poll", String(poll));
    referenceFiles.slice(0, 9).forEach(file => args.push("--image", file));
    if(input.ratio || input.aspectRatio) args.push("--ratio", String(input.ratio || input.aspectRatio));
    if(modelVersion === "seedance2.0_vip" && ["720p", "1080p"].includes(resolution)) {
      args.push("--video_resolution", resolution);
    } else {
      args.push("--video_resolution", "720p");
    }
  }

  const result = await runCli(args, { timeoutMs: (poll + 45) * 1000 });
  const initialPayload = await dreaminaResultPayload(type, result.stdout, result.stderr);
  let finalPayload = initialPayload;
  if(initialPayload.submitId && !initialPayload.url){
    const queried = await queryDreaminaResult(initialPayload.submitId, type === "video" ? 8000 : 12000).catch(() => null);
    if(queried){
      finalPayload = {
        ...initialPayload,
        ...queried,
        type,
        submitId: queried.submitId || initialPayload.submitId,
        commandOutput: initialPayload.raw,
      };
    }
  }
  return {
    ...finalPayload,
    usedReferences: referenceFiles.length,
    command: ["dreamina", ...args.map(arg => arg === prompt ? "<prompt>" : arg)],
  };
};

const installCli = async () => {
  if(await findCliCommand()) return;
  if(installPromise) return installPromise;

  installPromise = (async () => {
    setRuntime({ phase: "installing", message: "正在自动准备即梦本地能力", lastError: "" });
    const bash = await findUsableBash();
    if(bash){
      await run(bash, ["-lc", `curl -fsSL ${INSTALL_URL} | bash`], { timeoutMs: 180000 });
    } else if(process.platform === "win32"){
      await installCliWindowsDirect();
    } else {
      throw new Error("未找到可用的 bash，无法自动执行即梦官方安装脚本。请先安装 bash/curl 后重试。");
    }
    if(!(await findCliCommand())){
      throw new Error("即梦 CLI 已下载，但没有在运行时 PATH 中找到 dreamina。");
    }
    setRuntime({ phase: "installed", message: "即梦本地能力已准备完成" });
  })().catch(err => {
    setRuntime({ phase: "error", message: "即梦本地能力准备失败", lastError: err.message });
    throw err;
  }).finally(() => {
    installPromise = null;
  });

  return installPromise;
};

const ensureRuntime = async () => {
  await installCli();
};

const statusPayload = async (authOverride = null) => {
  const installed = !!(await findCliCommand());
  const auth = authOverride || (installed ? await cliAuthStatus() : { loggedIn: false });
  const running = installed;
  const loggedIn = !!auth.loggedIn;
  if(loggedIn) currentAuth = null;
  const pendingAuth = loggedIn ? null : currentAuth;
  const label = runtimeState.phase === "installing"
    ? runtimeState.message
    : runtimeState.phase === "error" ? "准备失败"
    : runtimeState.phase === "authorizing" ? "等待授权"
    : loggedIn ? "已登录"
      : installed ? "未登录"
          : "待授权";
  return {
    connected: true,
    installed,
    running,
    loggedIn,
    label,
    authUrl: pendingAuth?.authUrl || "",
    verificationUri: pendingAuth?.verificationUri || "",
    userCode: pendingAuth?.userCode || "",
    deviceCode: pendingAuth?.deviceCode || "",
    runtime: runtimeState,
    account: auth.account || null,
    upstream: auth.raw || auth.error || null,
  };
};

const startLoginPoll = async (deviceCode) => {
  if(!deviceCode) return;
  const cliBin = await findCliCommand();
  if(!cliBin) return;
  if(loginPollProcess && !loginPollProcess.killed) loginPollProcess.kill();

  const shell = isWindowsCommandScript(cliBin);
  const stdoutChunks = [];
  const stderrChunks = [];
  loginPollProcess = spawn(shell ? `"${cliBin}"` : cliBin, ["login", "checklogin", `--device_code=${deviceCode}`, "--poll=180"], {
    shell,
    windowsHide: true,
    env: runtimeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  setRuntime({ phase: "authorizing", message: "等待即梦网页登录授权完成", lastError: "" });
  loginPollProcess.stdout?.on("data", d => stdoutChunks.push(Buffer.from(d)));
  loginPollProcess.stderr?.on("data", d => stderrChunks.push(Buffer.from(d)));
  loginPollProcess.on("exit", code => {
    const stdout = decodeOutput(stdoutChunks).trim();
    const stderr = decodeOutput(stderrChunks).trim();
    loginPollProcess = null;
    if(code === 0){
      currentAuth = null;
      setRuntime({ phase: "authorized", message: "即梦授权已完成", lastError: "" });
    } else {
      setRuntime({ phase: "error", message: "即梦授权未完成", lastError: stderr || stdout || `dreamina login checklogin 退出码 ${code ?? "unknown"}` });
    }
  });
};

const beginCliLogin = async () => {
  await installCli();
  const existing = await cliAuthStatus();
  if(existing.loggedIn){
    currentAuth = null;
    setRuntime({ phase: "authorized", message: "已复用当前即梦登录态", lastError: "" });
    return { ...(await statusPayload(existing)), output: "已复用当前本地 OAuth 登录态。" };
  }

  setRuntime({ phase: "authorizing", message: "正在获取即梦网页登录授权", lastError: "" });
  const result = await runCli(["login", "--headless"], { timeoutMs: 30000 });
  const auth = parseLoginOutput(`${result.stdout}\n${result.stderr}`);
  if(!auth.authUrl && !auth.deviceCode){
    throw new Error(auth.output || "即梦 CLI 未返回授权链接，请稍后重试。");
  }
  currentAuth = auth;
  await startLoginPoll(auth.deviceCode);
  return {
    connected: true,
    installed: true,
    running: true,
    loggedIn: false,
    label: "等待授权",
    authUrl: auth.authUrl,
    verificationUri: auth.verificationUri,
    userCode: auth.userCode,
    deviceCode: auth.deviceCode,
    runtime: runtimeState,
    upstream: auth.output,
  };
};

const logoutCli = async () => {
  await installCli();
  await runCli(["logout"], { timeoutMs: 30000 }).catch(() => {});
  if(loginPollProcess && !loginPollProcess.killed) loginPollProcess.kill();
  currentAuth = null;
  setRuntime({ phase: "idle", message: "已退出即梦登录态", lastError: "" });
  return statusPayload({ loggedIn: false });
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const serveOutputFile = async (req, res, filePath) => {
  const stat = await fs.promises.stat(filePath);
  const range = req.headers.range;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const wantsDownload = url.searchParams.get("download") === "1" || url.searchParams.get("dl") === "1";
  const attachmentName = url.searchParams.get("filename") || path.basename(filePath);
  const downloadHeaders = wantsDownload ? { "Content-Disposition": contentDisposition(attachmentName) } : {};
  if(range){
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    const chunkStart = Math.max(0, Math.min(start, stat.size - 1));
    const chunkEnd = Math.max(chunkStart, Math.min(end, stat.size - 1));
    res.writeHead(206, {
        ...corsHeaders,
        ...downloadHeaders,
        "Content-Type": mimeForFile(filePath),
      "Content-Range": `bytes ${chunkStart}-${chunkEnd}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkEnd - chunkStart + 1,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath, { start: chunkStart, end: chunkEnd }).pipe(res);
    return;
  }
  res.writeHead(200, {
      ...corsHeaders,
      ...downloadHeaders,
      "Content-Type": mimeForFile(filePath),
    "Accept-Ranges": "bytes",
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(async (req, res) => {
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  try {
    if(pathname === "/health"){
      sendJson(res, 200, { ok: true, port: PORT, cli: await findCliCommand() });
      return;
    }

    if(pathname.startsWith("/output/task/")){
      const tail = decodeURIComponent(pathname.slice("/output/task/".length));
      const submitId = tail.match(uuidPattern)?.[0] || url.searchParams.get("submitId") || "";
      const wantsPoster = /poster|\.jpe?g$/i.test(tail) || url.searchParams.get("poster") === "1";
      const wantsImage = /\.(png|jpe?g|webp|gif)$/i.test(tail);
      const { file: resolved, payload } = await resolveSubmitOutput(submitId, { poster: wantsPoster, type: wantsImage ? "image" : "video" });
      if(!resolved){
        const status = payload?.data?.gen_status || payload?.data?.status || "";
        const reason = payload?.data?.fail_reason || payload?.error || "Output not found";
        sendJson(res, 404, { error: reason, status, submitId });
        return;
      }
      await serveOutputFile(req, res, resolved);
      return;
    }

    if(pathname.startsWith("/output/")){
      const filename = path.basename(decodeURIComponent(pathname.slice("/output/".length)));
      const filePath = path.join(OUTPUT_DIR, filename);
      const resolved = await resolveOutputFile(filePath);
      if(!resolved){
        sendJson(res, 404, { error: "Output not found" });
        return;
      }
      await serveOutputFile(req, res, resolved);
      return;
    }

    if(pathname === "/api/dreamina/status" || pathname === "/api/v2/dreamina/status"){
      sendJson(res, 200, await statusPayload());
      return;
    }

    if(pathname === "/api/dreamina/prepare"){
      await ensureRuntime();
      sendJson(res, 200, await statusPayload());
      return;
    }

    if(pathname === "/api/v2/dreamina/login/runtime"){
      sendJson(res, 200, await statusPayload());
      return;
    }

    if(pathname === "/api/dreamina/web-login" || pathname === "/api/v2/dreamina/login/web" || pathname === "/api/dreamina/qr-login" || pathname === "/api/v2/dreamina/login"){
      sendJson(res, 200, await beginCliLogin());
      return;
    }

    if(pathname === "/api/dreamina/logout" || pathname === "/api/v2/dreamina/logout"){
      sendJson(res, 200, await logoutCli());
      return;
    }

    if(pathname === "/api/dreamina/generate" || pathname === "/api/v2/dreamina/generate"){
      const body = await readJsonBody(req);
      sendJson(res, 200, await runDreaminaGeneration(body));
      return;
    }

    if(pathname === "/api/dreamina/result" || pathname === "/api/v2/dreamina/result"){
      const submitId = url.searchParams.get("submitId") || url.searchParams.get("submit_id");
      if(!submitId) throw new Error("缺少 submitId");
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeoutMs") || url.searchParams.get("timeout") || 20000), 5000), 60000);
      const payload = await queryDreaminaResult(submitId, timeoutMs);
      sendJson(res, 200, payload);
      return;
    }

    if(pathname === "/api/dreamina/tasks" || pathname === "/api/v2/dreamina/tasks"){
      const limit = url.searchParams.get("limit") || 20;
      sendJson(res, 200, await listDreaminaTasks(limit));
      return;
    }

    if(pathname.startsWith("/api/dreamina/") || pathname.startsWith("/api/v2/dreamina/") || pathname.startsWith("/output/")){
      sendJson(res, 404, { error: "当前官方 dreamina CLI 不提供本地 server API；请使用网页登录、状态检测或 CLI 命令集成。" });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message, runtime: runtimeState });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[cherry-runtime] http://127.0.0.1:${PORT} -> dreamina cli`);
});
