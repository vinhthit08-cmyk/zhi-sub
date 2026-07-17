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
            images: allAIImages.images.length
        }));

        const hint = document.getElementById('progressHint');
        if (hint) {
            hint.classList.add('show');
            hint.innerText = `✅ 已载入${allStudents.length}名学生的公开统计；更新时间：${generatedAt}`;
            setTimeout(() => hint.classList.remove('show'), 3500);
        }
    };

    window.loadEmbeddedSnapshot();
    window.setInterval(() => window.location.reload(), 5 * 60 * 1000);
})();
