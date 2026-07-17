import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CHAPTER_NAMES = ['时空溯源', '匠心辨物', '风筝大观园', '巧夺天工', '乘风破浪', '蔚然成风'];
const ABILITY_NAMES = ['美术创作', '科学探究', '动手实践', '合作交流', '创新思维', '文化理解'];

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
};

export function normalizeClass(value) {
  const text = String(value || '').trim();
  const digit = text.match(/([1-9])/);
  if (digit) return `五年级${digit[1]}班`;
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const index = chinese.findIndex(char => text.includes(char));
  return `五年级${index >= 0 ? index + 1 : 1}班`;
}

export function recordKey(row) {
  if (row?.id !== undefined && row?.id !== null) return `id:${row.id}`;
  if (row?.submission_id) return `submission:${row.submission_id}`;
  const parts = [
    row?.dataType, row?.record_type, row?.dataset_id, row?.global_chunk_index,
    row?.messageId, row?.commentId, row?.noteId, row?.timestamp, row?.submitted_at,
    row?.submitTime, row?.messageTime, row?.likeTime, row?.name, row?.studentName,
    row?.userName, row?.messageContent, row?.commentContent, row?.imageUrl
  ].map(value => value === undefined || value === null ? '' : String(value));
  return parts.join('|') || JSON.stringify(row);
}

export function mergeRecords(existing = [], incoming = []) {
  const merged = new Map();
  for (const row of [...existing, ...incoming]) {
    if (row && typeof row === 'object') merged.set(recordKey(row), row);
  }
  return Array.from(merged.values());
}

function expandVerifiedJsonBundles(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row?.record_type !== 'json_export_bundle_chunk' || !row.payload_chunk) continue;
    const key = `${row.dataset_id || ''}\u0000${row.file_name || ''}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const recovered = [];
  for (const chunks of groups.values()) {
    chunks.sort((a, b) => asNumber(a.file_chunk_index) - asNumber(b.file_chunk_index));
    const expected = asNumber(chunks[0]?.file_chunk_count, chunks.length);
    if (!expected || chunks.length !== expected) continue;
    try {
      const packed = Buffer.from(chunks.map(row => String(row.payload_chunk)).join(''), 'base64');
      const expectedPackedHash = String(chunks[0]?.file_gzip_sha256 || '');
      if (expectedPackedHash && crypto.createHash('sha256').update(packed).digest('hex') !== expectedPackedHash) continue;
      const unpacked = zlib.gunzipSync(packed);
      const expectedDataHash = String(chunks[0]?.file_original_sha256 || '');
      if (expectedDataHash && crypto.createHash('sha256').update(unpacked).digest('hex') !== expectedDataHash) continue;
      const payload = JSON.parse(unpacked.toString('utf8'));
      if (Array.isArray(payload)) recovered.push(...payload.filter(item => item && typeof item === 'object'));
    } catch {
      // 不完整或损坏的历史数据包不能参与统计。
    }
  }
  return mergeRecords(rows, recovered);
}

function extractEmbeddedTables(rows) {
  const tables = { students: [], scores: [], notes: [], messages: [], message_likes: [] };
  for (const row of rows) {
    if (row.record_type === 'csv_bundle_chunk' && row.table_name && row.rows_json && tables[row.table_name]) {
      const parsed = parseJson(row.rows_json);
      if (Array.isArray(parsed)) tables[row.table_name].push(...parsed.filter(item => item && typeof item === 'object'));
    }
    if (row.dataType === 'Supabase全量同步-学生数据' && row.studentsJson) {
      const parsed = parseJson(row.studentsJson);
      if (Array.isArray(parsed)) tables.students.push(...parsed.filter(item => item && typeof item === 'object'));
    }
  }
  for (const key of Object.keys(tables)) tables[key] = mergeRecords([], tables[key]);
  return tables;
}

function readAbilities(row, totalScore) {
  const parsed = parseJson(row.abilitiesJson);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return Object.fromEntries(ABILITY_NAMES.map(name => [name, Math.max(0, Math.min(100, asNumber(parsed[name], totalScore)))]));
  }
  const direct = {
    美术创作: row.abilityArt,
    科学探究: row.abilityScience,
    动手实践: row.abilityPractice,
    合作交流: row.abilityCooperation,
    创新思维: row.abilityInnovation,
    文化理解: row.abilityCulture
  };
  return Object.fromEntries(ABILITY_NAMES.map(name => [name, Math.max(0, Math.min(100, asNumber(direct[name], totalScore)))]));
}

function readCompletedChapterCount(row) {
  const value = row.completed_chapters ?? row.completedChapters;
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    return new Set(parsed.map(asNumber).filter(id => id >= 1 && id <= 6)).size;
  }
  return Math.max(0, Math.min(6, asNumber(parsed, 0)));
}

function readChapterScores(row) {
  const packed = parseJson(row.chapter_scores ?? row.chapterScores);
  const currentChapter = asNumber(row.currentChapter ?? row.current_chapter, 0);
  return Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const id = index + 1;
    const value = row[`chapter${id}Score`]
      ?? (packed && typeof packed === 'object' && !Array.isArray(packed) ? packed[id] ?? packed[String(id)] : undefined)
      ?? (currentChapter === id ? row.chapterScore : undefined);
    return [id, Math.max(0, Math.min(20, asNumber(value, 0)))];
  }));
}

function pseudonym(name, className, salt) {
  const digest = crypto.createHmac('sha256', salt).update(`${className}\u0000${name}`).digest('hex').slice(0, 6).toUpperCase();
  return `学员-${digest}`;
}

function collectImageUrls(value, bucket, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return;
  const parsed = parseJson(value);
  if (parsed !== value) return collectImageUrls(parsed, bucket, depth + 1);
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(value) || /upload|image|img/i.test(value))) bucket.add(value);
    return;
  }
  if (Array.isArray(value)) return value.forEach(item => collectImageUrls(item, bucket, depth + 1));
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/image|img|photo|picture|作品|图片|生图/i.test(key)) collectImageUrls(nested, bucket, depth + 1);
    }
  }
}

export function buildPublicSnapshot({ quickformRows = [], supabaseTables = {}, sourceStatus = [], salt }) {
  const completeRows = expandVerifiedJsonBundles(quickformRows);
  const embedded = extractEmbeddedTables(completeRows);
  const tables = {};
  for (const table of Object.keys(embedded)) tables[table] = mergeRecords(embedded[table], supabaseTables[table] || []);

  const studentMap = new Map();
  const sourceIdToStudent = new Map();
  const upsertStudent = raw => {
    const name = String(raw.name || raw.studentName || '').trim();
    if (!name || name === '1' || name === '测试同学') return;
    const className = normalizeClass(raw.class_name || raw.className || raw.studentClass);
    const key = `${name}\u0000${className}`;
    const totalScore = asNumber(raw.total_score ?? raw.totalScore, 0);
    const completedChapters = readCompletedChapterCount(raw);
    const totalTimeSeconds = Math.max(0, asNumber(raw.total_time ?? raw.totalTimeSeconds ?? raw.totalTime, 0));
    const chapterScores = readChapterScores(raw);
    const abilities = readAbilities(raw, totalScore);
    const current = studentMap.get(key) || {
      name, className, totalScore: 0, completedChapters: 0, totalTimeSeconds: 0,
      chapterScores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      abilities: Object.fromEntries(ABILITY_NAMES.map(ability => [ability, 0])),
      sourceIds: new Set()
    };
    current.totalScore = Math.max(current.totalScore, totalScore);
    current.completedChapters = Math.max(current.completedChapters, completedChapters);
    current.totalTimeSeconds = Math.max(current.totalTimeSeconds, totalTimeSeconds);
    for (let id = 1; id <= 6; id++) current.chapterScores[id] = Math.max(current.chapterScores[id], chapterScores[id]);
    for (const ability of ABILITY_NAMES) current.abilities[ability] = Math.max(current.abilities[ability], abilities[ability]);
    for (const sourceId of [raw.id, raw.student_id]) if (sourceId !== undefined && sourceId !== null) current.sourceIds.add(String(sourceId));
    studentMap.set(key, current);
  };

  tables.students.forEach(upsertStudent);
  completeRows.forEach(row => {
    if ((row.name || row.studentName) && row.totalScore !== undefined && row.totalScore !== null && row.totalScore !== '') upsertStudent(row);
  });
  for (const student of studentMap.values()) for (const id of student.sourceIds) sourceIdToStudent.set(id, student);
  for (const score of tables.scores) {
    const student = sourceIdToStudent.get(String(score.student_id));
    const chapterId = asNumber(score.chapter_id, 0);
    if (student && chapterId >= 1 && chapterId <= 6) student.chapterScores[chapterId] = Math.max(student.chapterScores[chapterId], Math.min(20, asNumber(score.score, 0)));
  }

  const messages = new Map(tables.messages.map(item => [String(item.id), { ...item, likes: asNumber(item.likes) }]));
  const notes = new Map(tables.notes.map(item => [String(item.id), item]));
  const likeCounts = new Map();
  for (const like of tables.message_likes) {
    const messageId = String(like.message_id || like.messageId || '');
    if (messageId) likeCounts.set(messageId, (likeCounts.get(messageId) || 0) + 1);
  }
  for (const row of completeRows) {
    if (row.messageContent) {
      const id = String(row.messageId || recordKey(row));
      const old = messages.get(id) || {};
      messages.set(id, { ...old, ...row, likes: Math.max(asNumber(old.likes), asNumber(row.messageLikes), asNumber(row.likesCount)) });
    }
    if (row.commentContent) {
      const commentId = `comment:${row.commentId || recordKey(row)}`;
      messages.set(commentId, { ...row, id: commentId, likes: 0 });
    }
    if (/笔记/.test(row.dataType || '') && (row.noteContent || row.content)) notes.set(String(row.noteId || row.id || recordKey(row)), row);
    if (row.messageId && row.likesCount !== undefined) {
      const messageId = String(row.messageId);
      likeCounts.set(messageId, Math.max(likeCounts.get(messageId) || 0, asNumber(row.likesCount)));
    }
  }

  for (const [messageId, count] of likeCounts) {
    const message = messages.get(messageId);
    if (message) message.likes = Math.max(asNumber(message.likes), count);
  }

  const publicMessages = Array.from(messages.values()).map(message => ({
    id: String(message.id || message.messageId || message.commentId || recordKey(message)),
    author: String(message.author || message.messageAuthor || message.studentName || message.name || '匿名'),
    class_name: normalizeClass(message.class_name || message.messageAuthorClass || message.className || message.studentClass),
    content: String(message.content || message.messageContent || (message.commentContent ? `评论：${message.commentContent}` : '')),
    created_at: String(message.created_at || message.messageTime || message.commentTime || message.timestamp || message.submitted_at || ''),
    likes: asNumber(message.likes)
  })).filter(message => message.content).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at), 'zh-CN'));

  const publicNotes = Array.from(notes.values()).map(note => ({
    id: String(note.id || note.noteId || recordKey(note)),
    student_name: String(note.student_name || note.studentName || note.author || note.name || '匿名'),
    class_name: normalizeClass(note.class_name || note.className || note.studentClass),
    content: String(note.content || note.noteContent || ''),
    created_at: String(note.created_at || note.noteTime || note.timestamp || note.submitted_at || '')
  })).filter(note => note.content).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at), 'zh-CN'));

  const imageUrls = new Set();
  completeRows.forEach(row => collectImageUrls(row, imageUrls));
  const students = Array.from(studentMap.values()).map(student => ({
    id: pseudonym(student.name, student.className, salt),
    name: student.name,
    className: student.className,
    totalScore: Math.round(student.totalScore * 10) / 10,
    completedChapters: student.completedChapters,
    totalTimeSeconds: student.totalTimeSeconds,
    chapterScores: student.chapterScores,
    abilities: student.abilities,
    hasCertificate: student.totalScore >= 80
  })).sort((a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id));

  const classMap = new Map();
  for (const student of students) {
    const item = classMap.get(student.className) || { className: student.className, count: 0, totalScore: 0, certificates: 0, chapterTotals: [0, 0, 0, 0, 0, 0] };
    item.count++;
    item.totalScore += student.totalScore;
    item.certificates += student.hasCertificate ? 1 : 0;
    for (let id = 1; id <= 6; id++) item.chapterTotals[id - 1] += asNumber(student.chapterScores[id], 0);
    classMap.set(student.className, item);
  }
  const classes = Array.from(classMap.values()).map(item => ({
    className: item.className,
    studentCount: item.count,
    averageScore: item.count ? Math.round(item.totalScore / item.count * 10) / 10 : 0,
    certificateCount: item.certificates,
    chapterAverages: item.chapterTotals.map(total => item.count ? Math.round(total / item.count * 10) / 10 : 0)
  })).sort((a, b) => a.className.localeCompare(b.className, 'zh-CN'));

  const averageScore = students.length ? Math.round(students.reduce((sum, item) => sum + item.totalScore, 0) / students.length * 10) / 10 : 0;
  return {
    schemaVersion: 5,
    identitySpace: crypto.createHmac('sha256', salt).update('kite-public-identity-space').digest('hex').slice(0, 16),
    generatedAt: new Date().toISOString(),
    privacy: {
      mode: 'named-public',
      notice: '按发布要求显示学生姓名、班级、留言和笔记正文；IP与接口密钥不公开。'
    },
    chapters: CHAPTER_NAMES,
    abilities: ABILITY_NAMES,
    summary: {
      studentCount: students.length,
      averageScore,
      certificateCount: students.filter(item => item.hasCertificate).length,
      messageCount: publicMessages.length,
      noteCount: publicNotes.length,
      likeCount: publicMessages.reduce((sum, message) => sum + asNumber(message.likes), 0),
      aiImageCount: 235 + imageUrls.size
    },
    classes,
    students,
    messages: publicMessages,
    notes: publicNotes,
    sources: sourceStatus.map(source => ({
      id: source.id,
      ok: Boolean(source.ok),
      mode: source.mode,
      rowCount: asNumber(source.rowCount, 0),
      lastSuccessAt: source.lastSuccessAt || null,
      error: source.ok ? null : String(source.error || '暂不可用').slice(0, 160)
    }))
  };
}
