(() => {
    const readSnapshot = () => {
        const node = document.getElementById('initialData');
        if (!node) throw new Error('页面中没有找到公开数据快照');
        return JSON.parse(node.textContent || '{}');
    };

    const makePlaceholders = (count, factory) => Array.from(
        { length: Math.max(0, Number(count) || 0) },
        (_, index) => factory(index)
    );

    const LIVE_QUICKFORM_APIS = [
        'https://quickform.cn/api/hrisktqeyo/all',
        'https://quickform.cn/api/ot5fx3ctmo/all'
    ];
    const LIVE_POLL_INTERVAL_MS = 30 * 1000;
    let lastLiveSignature = '';
    let livePollInFlight = false;

    const parseLiveJson = value => {
        if (typeof value !== 'string') return value;
        const text = value.trim();
        if (!text || !/^[\[{]/.test(text)) return value;
        try { return JSON.parse(text); } catch { return value; }
    };

    const liveContentSignature = text => {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    };

    const readLiveCompletedCount = row => {
        const parsed = parseLiveJson(row.completed_chapters ?? row.completedChapters);
        if (Array.isArray(parsed)) {
            return new Set(parsed.map(Number).filter(id => id >= 1 && id <= 6)).size;
        }
        return Math.max(0, Math.min(6, Number(parsed) || 0));
    };

    const readLiveChapterScores = row => {
        const packed = parseLiveJson(row.chapter_scores ?? row.chapterScores);
        const currentChapter = Number(row.currentChapter ?? row.current_chapter) || 0;
        return Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
            const id = index + 1;
            const raw = row[`chapter${id}Score`]
                ?? (packed && typeof packed === 'object' && !Array.isArray(packed) ? packed[id] ?? packed[String(id)] : undefined)
                ?? (currentChapter === id ? row.chapterScore : undefined);
            return [id, Math.max(0, Math.min(20, Number(raw) || 0))];
        }));
    };

    const refreshClassOptions = () => {
        const selected = currentClassFilter;
        const classes = Array.from(new Set(allStudents.map(student => student.className).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));
        classFilterSelect.innerHTML = '<option value="all">🌐 全部班级</option>'
            + classes.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
        currentClassFilter = classes.includes(selected) ? selected : 'all';
        classFilterSelect.value = currentClassFilter;
    };

    const mergeLiveRows = rows => {
        let changed = false;
        const studentMap = new Map(allStudents.map(student => [`${student.name}\u0000${student.className}`, student]));

        for (const row of rows) {
            const name = String(row.name || row.studentName || '').trim();
            if (!name || row.totalScore === undefined || row.totalScore === null || row.totalScore === '') continue;
            const className = normalizeClass(row.class_name || row.className || row.studentClass);
            const key = `${name}\u0000${className}`;
            const totalScore = Math.max(0, Number(row.total_score ?? row.totalScore) || 0);
            const completedChapters = readLiveCompletedCount(row);
            const totalTimeSeconds = Math.max(0, Number(row.total_time ?? row.totalTimeSeconds ?? row.totalTime) || 0);
            const chapterScores = readLiveChapterScores(row);
            let student = studentMap.get(key);

            if (!student) {
                student = {
                    id: `live_${name}_${className}`,
                    name,
                    className,
                    totalScore,
                    completedChapters,
                    totalTimeSeconds,
                    chapterScores,
                    abilities: Object.fromEntries(abilityNames.map(ability => [ability, totalScore])),
                    hasCertificate: totalScore >= 80
                };
                allStudents.push(student);
                studentMap.set(key, student);
                changed = true;
                continue;
            }

            const previous = `${student.totalScore}|${student.completedChapters}|${student.totalTimeSeconds}|${JSON.stringify(student.chapterScores)}`;
            student.totalScore = Math.max(Number(student.totalScore) || 0, totalScore);
            student.completedChapters = Math.max(Number(student.completedChapters) || 0, completedChapters);
            student.totalTimeSeconds = Math.max(Number(student.totalTimeSeconds) || 0, totalTimeSeconds);
            for (let id = 1; id <= 6; id++) {
                student.chapterScores[id] = Math.max(Number(student.chapterScores[id]) || 0, chapterScores[id]);
            }
            student.hasCertificate = student.totalScore >= 80;
            const next = `${student.totalScore}|${student.completedChapters}|${student.totalTimeSeconds}|${JSON.stringify(student.chapterScores)}`;
            if (next !== previous) changed = true;
        }

        const communityRows = rows.map(row => {
            const kind = `${row.dataType || ''} ${row.eventType || ''} ${row.record_type || ''}`;
            let normalized = row;
            if (/message|留言/i.test(kind) && !row.messageContent && row.content) {
                normalized = { ...normalized, messageContent: row.content };
            }
            if (/note|笔记/i.test(kind) && !row.noteContent && row.content) {
                normalized = { ...normalized, noteContent: row.content, dataType: `${row.dataType || ''} 笔记` };
            }
            return normalized;
        });
        const communityBefore = JSON.stringify([allMessages, allNotes]);
        const community = parseMessagesAndNotes(communityRows, allNotes, allMessages, []);
        allMessages = community.messages;
        allNotes = community.notes;
        if (JSON.stringify([allMessages, allNotes]) !== communityBefore) changed = true;

        const imageMap = new Map((allAIImages.images || []).map(image => [image.url, image]));
        let addedImages = 0;
        for (const row of rows) {
            const candidates = [];
            collectImageCandidates(row, row.name || row.studentName || row.student_name || '未知', candidates);
            for (const image of candidates) {
                if (!image.url || imageMap.has(image.url)) continue;
                imageMap.set(image.url, image);
                addedImages++;
            }
        }
        if (addedImages) {
            allAIImages.images = Array.from(imageMap.values());
            allAIImages.totalCount += addedImages;
            changed = true;
        }

        if (!changed) return false;
        allStudents.sort((a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name, 'zh-CN'));
        refreshClassOptions();
        renderGallery();
        renderAll();
        return true;
    };

    const pollLiveQuickForm = async () => {
        if (livePollInFlight || document.hidden) return;
        livePollInFlight = true;
        try {
            const results = await Promise.allSettled(LIVE_QUICKFORM_APIS.map(async api => {
                const response = await fetch(`${api}?_=${Date.now()}`, {
                    cache: 'no-store',
                    headers: { accept: 'application/json' }
                });
                if (!response.ok) throw new Error(`${api}: HTTP ${response.status}`);
                const text = await response.text();
                const payload = JSON.parse(text);
                if (payload?.error) throw new Error(`${api}: ${payload.message || payload.error}`);
                const rows = Array.isArray(payload) ? payload : (payload.submissions || payload.data || payload.records || []);
                if (!Array.isArray(rows)) throw new Error(`${api}: 接口没有返回记录数组`);
                return { api, text, rows };
            }));
            const successful = results.filter(result => result.status === 'fulfilled').map(result => result.value);
            if (!successful.length) throw results[0]?.reason || new Error('两个实时接口均不可用');
            for (const failed of results.filter(result => result.status === 'rejected')) {
                console.warn('[dashboard] one live source failed:', failed.reason);
            }
            const rowMap = new Map();
            for (const source of successful) {
                for (const row of source.rows) {
                    const key = String(row.id || row.submission_id || [
                        row.dataType, row.eventType, row.timestamp, row.submitted_at,
                        row.name, row.studentName, row.messageId, row.noteId, row.imageUrl
                    ].map(value => value ?? '').join('|') || JSON.stringify(row));
                    rowMap.set(key, row);
                }
            }
            const rows = Array.from(rowMap.values());
            const signature = successful
                .map(source => `${source.api}:${source.rows.length}:${liveContentSignature(source.text)}`)
                .join('|');
            if (signature === lastLiveSignature) return;
            lastLiveSignature = signature;
            if (!mergeLiveRows(rows)) return;
            const hint = document.getElementById('progressHint');
            if (hint) {
                hint.classList.add('show');
                hint.innerText = `✅ 发现新数据，已实时更新；当前 ${allStudents.length} 名学生`;
                setTimeout(() => hint.classList.remove('show'), 3500);
            }
            console.info('[dashboard] live data merged ' + JSON.stringify({
                records: rows.length,
                students: allStudents.length,
                messages: allMessages.length,
                notes: allNotes.length,
                images: allAIImages.images.length,
                renderedMessages: messageBoardDiv.querySelectorAll('.msg-item').length,
                renderedNotes: notesListDiv.querySelectorAll('.msg-item').length,
                renderedImages: aiGalleryDiv.querySelectorAll('.gallery-item').length
            }));
        } catch (error) {
            console.warn('[dashboard] live check failed; snapshot retained:', error);
        } finally {
            livePollInFlight = false;
        }
    };

    window.loadEmbeddedSnapshot = () => {
        const snapshot = readSnapshot();
        const summary = snapshot.summary || {};
        const generatedAt = snapshot.generatedAt
            ? new Date(snapshot.generatedAt).toLocaleString('zh-CN', { hour12: false })
            : '未知时间';

        allStudents = (snapshot.students || []).map(student => ({
            id: student.id,
            name: student.name || student.id,
            className: student.className,
            totalScore: Number(student.totalScore) || 0,
            completedChapters: Number(student.completedChapters) || 0,
            totalTimeSeconds: Number(student.totalTimeSeconds) || 0,
            chapterScores: student.chapterScores || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            abilities: student.abilities || Object.fromEntries(abilityNames.map(name => [name, 0])),
            hasCertificate: Boolean(student.hasCertificate)
        }));

        allMessages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
        allNotes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
        allAIImages = {
            images: Array.isArray(snapshot.images) ? snapshot.images : [],
            totalCount: Number(summary.aiImageCount) || 0
        };

        const classes = (snapshot.classes || []).map(item => item.className).filter(Boolean);
        classFilterSelect.innerHTML = '<option value="all">🌐 全部班级</option>'
            + classes.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
        classFilterSelect.value = classes.includes(currentClassFilter) ? currentClassFilter : 'all';
        currentClassFilter = classFilterSelect.value;

        renderGallery();
        renderAll();
        console.info('[dashboard] snapshot rendered ' + JSON.stringify({
            students: allStudents.length,
            messages: allMessages.length,
            notes: allNotes.length,
            images: allAIImages.images.length,
            renderedMessages: messageBoardDiv.querySelectorAll('.msg-item').length,
            renderedNotes: notesListDiv.querySelectorAll('.msg-item').length,
            renderedImages: aiGalleryDiv.querySelectorAll('.gallery-item').length
        }));

        const hint = document.getElementById('progressHint');
        if (hint) {
            hint.classList.add('show');
            hint.innerText = `✅ 已载入${allStudents.length}名学生的公开统计；更新时间：${generatedAt}`;
            setTimeout(() => hint.classList.remove('show'), 3500);
        }
    };

    window.loadEmbeddedSnapshot();
    pollLiveQuickForm();
    window.setInterval(pollLiveQuickForm, LIVE_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollLiveQuickForm();
    });
})();
