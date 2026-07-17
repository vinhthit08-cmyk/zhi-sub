import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicSnapshot, mergeRecords } from './data-pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_FILE = path.join(ROOT, 'site', 'index.html');
const SOURCE_DIR = path.join(ROOT, 'src');
const QUICKFORM_APIS = String(process.env.QUICKFORM_APIS || '').split(',').map(value => value.trim()).filter(Boolean);
const PUBLIC_DATA_SALT = process.env.PUBLIC_DATA_SALT || 'local-build-only-change-this-in-github-secrets';
const SEED_DATA_DIR = process.env.SEED_DATA_DIR ? path.resolve(process.env.SEED_DATA_DIR) : '';

const sourceId = url => url.split('/').filter(Boolean).slice(-2, -1)[0] || 'quickform';
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function readPreviousSnapshot() {
  try {
    const html = await fs.readFile(SITE_FILE, 'utf8');
    const match = html.match(/<script id="initialData" type="application\/json">([\s\S]*?)<\/script>/);
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

async function fetchSource(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      const payload = await response.json();
      if (payload?.error === 'quota_exceeded') throw new Error('QuickForm 流量额度不足');
      if (!response.ok || payload?.error) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      const rows = Array.isArray(payload) ? payload : (payload?.submissions || payload?.data || payload?.records || []);
      if (!Array.isArray(rows) || !rows.length) throw new Error('接口返回空数据，拒绝覆盖上一版');
      return { id: sourceId(url), ok: true, mode: 'online', rowCount: rows.length, lastSuccessAt: new Date().toISOString(), rows };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { id: sourceId(url), ok: false, mode: 'unavailable', rowCount: 0, error: lastError?.message || '获取失败', rows: [] };
}

async function loadSeedSources() {
  if (!SEED_DATA_DIR) return [];
  const files = await fs.readdir(SEED_DATA_DIR, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const payload = await readJson(path.join(SEED_DATA_DIR, file.name));
    const rows = Array.isArray(payload) ? payload : (payload?.submissions || []);
    if (Array.isArray(rows) && rows.length) {
      results.push({ id: path.basename(file.name, '.json'), ok: true, mode: 'seed', rowCount: rows.length, lastSuccessAt: new Date().toISOString(), rows });
    }
  }
  return results;
}

function recomputeClasses(students) {
  const map = new Map();
  for (const student of students) {
    const item = map.get(student.className) || { className: student.className, studentCount: 0, total: 0, certificateCount: 0, chapters: [0, 0, 0, 0, 0, 0] };
    item.studentCount++;
    item.total += asNumber(student.totalScore);
    item.certificateCount += student.hasCertificate ? 1 : 0;
    for (let id = 1; id <= 6; id++) item.chapters[id - 1] += asNumber(student.chapterScores?.[id]);
    map.set(student.className, item);
  }
  return Array.from(map.values()).map(item => ({
    className: item.className,
    studentCount: item.studentCount,
    averageScore: item.studentCount ? Math.round(item.total / item.studentCount * 10) / 10 : 0,
    certificateCount: item.certificateCount,
    chapterAverages: item.chapters.map(total => item.studentCount ? Math.round(total / item.studentCount * 10) / 10 : 0)
  })).sort((a, b) => a.className.localeCompare(b.className, 'zh-CN'));
}

function mergeSnapshots(previous, current, hadSuccessfulFetch) {
  if (!previous) return current;
  if (previous.schemaVersion !== current.schemaVersion || previous.identitySpace !== current.identitySpace) return current;
  const students = new Map(previous.students.map(student => [student.id, student]));
  for (const incoming of current.students) {
    const old = students.get(incoming.id);
    if (!old) { students.set(incoming.id, incoming); continue; }
    const chapterScores = {};
    const abilities = {};
    for (let id = 1; id <= 6; id++) chapterScores[id] = Math.max(asNumber(old.chapterScores?.[id]), asNumber(incoming.chapterScores?.[id]));
    for (const name of current.abilities) abilities[name] = Math.max(asNumber(old.abilities?.[name]), asNumber(incoming.abilities?.[name]));
    students.set(incoming.id, {
      ...old, ...incoming,
      totalScore: Math.max(asNumber(old.totalScore), asNumber(incoming.totalScore)),
      completedChapters: Math.max(asNumber(old.completedChapters), asNumber(incoming.completedChapters)),
      totalTimeSeconds: Math.max(asNumber(old.totalTimeSeconds), asNumber(incoming.totalTimeSeconds)),
      chapterScores, abilities,
      hasCertificate: old.hasCertificate || incoming.hasCertificate
    });
  }
  const mergedStudents = Array.from(students.values()).sort((a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id));
  const mergeDetails = (oldItems = [], newItems = []) => {
    const map = new Map(oldItems.map(item => [String(item.id), item]));
    for (const item of newItems) {
      const id = String(item.id);
      map.set(id, { ...(map.get(id) || {}), ...item });
    }
    return Array.from(map.values()).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''), 'zh-CN'));
  };
  const messages = mergeDetails(previous.messages, current.messages);
  const notes = mergeDetails(previous.notes, current.notes);
  const previousSources = new Map((previous.sources || []).map(source => [source.id, source]));
  const sources = current.sources.map(source => {
    const old = previousSources.get(source.id);
    if (source.ok || !old) return source;
    return { ...source, mode: old.rowCount ? 'cached' : source.mode, rowCount: Math.max(source.rowCount, old.rowCount || 0), lastSuccessAt: old.lastSuccessAt || null };
  });
  const total = mergedStudents.reduce((sum, item) => sum + asNumber(item.totalScore), 0);
  return {
    ...current,
    generatedAt: hadSuccessfulFetch ? current.generatedAt : previous.generatedAt,
    students: mergedStudents,
    messages,
    notes,
    classes: recomputeClasses(mergedStudents),
    sources,
    summary: {
      studentCount: mergedStudents.length,
      averageScore: mergedStudents.length ? Math.round(total / mergedStudents.length * 10) / 10 : 0,
      certificateCount: mergedStudents.filter(item => item.hasCertificate).length,
      messageCount: messages.length,
      noteCount: notes.length,
      likeCount: messages.reduce((sum, message) => sum + asNumber(message.likes), 0),
      aiImageCount: Math.max(asNumber(previous.summary?.aiImageCount), asNumber(current.summary?.aiImageCount))
    }
  };
}

async function buildSinglePage(snapshot) {
  const [original, adapter] = await Promise.all([
    fs.readFile(path.join(SOURCE_DIR, 'original-layout.html'), 'utf8'),
    fs.readFile(path.join(SOURCE_DIR, 'original-adapter.js'), 'utf8')
  ]);
  const permanentMatch = original.match(/const PERMANENT_AI_IMAGES = (\[[\s\S]*?\]);\s*let supabaseClient/);
  const permanentImages = permanentMatch ? JSON.parse(permanentMatch[1]) : [];
  const anonymousAuthors = new Map();
  const galleryImages = permanentImages.map(([author, url]) => {
    if (!anonymousAuthors.has(author)) anonymousAuthors.set(author, `创作者-${String(anonymousAuthors.size + 1).padStart(2, '0')}`);
    return { author: anonymousAuthors.get(author), url };
  });
  const pageSnapshot = { ...snapshot, images: galleryImages };
  const safeJson = JSON.stringify(pageSnapshot).replaceAll('<', '\\u003c').replaceAll('&', '\\u0026');
  let html = original
    .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
    .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';")
    .replace(/const QUICKFORM_API = '[^']*';/, "const QUICKFORM_API = '';")
    .replace(/const QUICKFORM_NEW_API = '[^']*';/, "const QUICKFORM_NEW_API = '';")
    .replace(/const QUICKFORM_APIS = \[[^\]]*\];/, 'const QUICKFORM_APIS = [];')
    .replace(/const ARK_API_KEY = '[^']*';/, "const ARK_API_KEY = '';")
    .replace(/const PERMANENT_AI_IMAGES = \[[\s\S]*?(?=    let supabaseClient)/, 'const PERMANENT_AI_IMAGES = [];\n    \n')
    .replace("refreshBtn.addEventListener('click', fetchAndRender);", "refreshBtn.addEventListener('click', () => window.location.reload());")
    .replace(/^\s*fetchAndRender\(\);\s*$/m, '');
  // Put the snapshot before the dashboard's main script, then run the adapter
  // inside that same script. The original page uses top-level `let` bindings;
  // keeping initialization in one script avoids cross-script TDZ failures.
  const mainScriptStart = html.lastIndexOf('<script>');
  const mainScriptEnd = html.indexOf('</script>', mainScriptStart);
  if (mainScriptStart < 0 || mainScriptEnd < 0) throw new Error('找不到原页面主程序');
  html = `${html.slice(0, mainScriptStart)}`
    + `<script id="initialData" type="application/json">${safeJson}</script>\n`
    + `${html.slice(mainScriptStart, mainScriptEnd)}\n${adapter}\n${html.slice(mainScriptEnd)}`;
  await fs.mkdir(path.dirname(SITE_FILE), { recursive: true });
  await fs.writeFile(SITE_FILE, html, 'utf8');
}

const previous = await readPreviousSnapshot();
const onlineSources = QUICKFORM_APIS.length ? await Promise.all(QUICKFORM_APIS.map(fetchSource)) : [];
const seedSources = await loadSeedSources();
const sources = onlineSources.length ? onlineSources : seedSources;
if (!sources.length && !previous) throw new Error('首次构建必须提供 QUICKFORM_APIS 或 SEED_DATA_DIR');
const rows = mergeRecords([], sources.flatMap(source => source.rows));
const current = rows.length
  ? buildPublicSnapshot({ quickformRows: rows, supabaseTables: {}, sourceStatus: sources, salt: PUBLIC_DATA_SALT })
  : previous;
const merged = mergeSnapshots(previous, current, sources.some(source => source.ok && source.mode === 'online'));
await buildSinglePage(merged);
console.log(JSON.stringify({ generatedAt: merged.generatedAt, students: merged.summary.studentCount, sources: merged.sources }, null, 2));
