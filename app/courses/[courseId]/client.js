"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { CourseEditor } from "@/components/course-editor";

export default function CourseClientPage({ initialCourse }) {
    const router = useRouter();
    const [course, setCourse] = useState(initialCourse);
    const [publishing, setPublishing] = useState(false);
    const [pubResult, setPubResult] = useState(null);
    const [showChamilo, setShowChamilo] = useState(false);
    const [chamilo, setChamilo] = useState({
        baseUrl: "",
        username: "admin",
        password: "admin",
        courseCode: "TEST"
    });

    // Load Chamilo settings
    useEffect(() => {
        fetch("/api/settings").then(r => r.json()).then(d => {
            if (d.chamilo) setChamilo(prev => ({ ...prev, ...d.chamilo }));
        }).catch(() => { });
    }, []);

    const refreshCourse = useCallback(async () => {
        try {
            const resp = await fetch(`/api/courses/${course.id}`);
            if (resp.ok) {
                const data = await resp.json();
                setCourse(data);
            }
        } catch { }
    }, [course.id]);

    const handlePublish = async () => {
        setPublishing(true);
        setPubResult(null);
        try {
            // Save chamilo settings first
            const settingsResp = await fetch("/api/settings");
            const settings = await settingsResp.json();
            await fetch("/api/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, chamilo })
            });

            const resp = await fetch(`/api/courses/${course.id}/publish-chamilo`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(chamilo)
            });
            const data = await resp.json();
            setPubResult(data);
        } catch (err) {
            setPubResult({ error: err.message });
        } finally {
            setPublishing(false);
        }
    };

    const handleExportScorm = async () => {
        window.open(`/api/courses/${course.id}/export-scorm`, "_blank");
    };

    const updateChamilo = (key, value) => {
        setChamilo(prev => ({ ...prev, [key]: value }));
    };

    return (
        <main className="page-shell stack">
            <section className="hero">
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
                    <button
                        className="ghost-button"
                        onClick={() => router.push("/")}
                        style={{ padding: "6px 14px", fontSize: "13px" }}
                    >
                        ← Назад
                    </button>
                </div>
                <span className="eyebrow">Course Workspace</span>
                <h1>{course.title}</h1>
                <p>{course.description}</p>
            </section>

            <div className="topbar-actions" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button className="button" onClick={handleExportScorm}>
                    📦 Экспорт SCORM
                </button>
                <button
                    className="ghost-button"
                    onClick={() => setShowChamilo(!showChamilo)}
                >
                    {showChamilo ? "▲ Скрыть" : "🚀 Опубликовать в Chamilo"}
                </button>
            </div>

            {showChamilo && (
                <div className="panel">
                    <div className="tree-header">
                        <h3>🚀 Публикация в Chamilo</h3>
                        <span className="meta">Укажите адрес и логин Chamilo LMS</span>
                    </div>
                    <div className="field-grid">
                        <div className="field">
                            <label htmlFor="chamiloUrl">URL Chamilo</label>
                            <input
                                id="chamiloUrl"
                                placeholder="http://192.168.8.31/chamilo/"
                                value={chamilo.baseUrl}
                                onChange={(e) => updateChamilo("baseUrl", e.target.value)}
                            />
                        </div>
                        <div className="field">
                            <label htmlFor="chamiloUser">Логин</label>
                            <input
                                id="chamiloUser"
                                value={chamilo.username}
                                onChange={(e) => updateChamilo("username", e.target.value)}
                            />
                        </div>
                        <div className="field">
                            <label htmlFor="chamiloPass">Пароль</label>
                            <input
                                id="chamiloPass"
                                type="password"
                                value={chamilo.password}
                                onChange={(e) => updateChamilo("password", e.target.value)}
                            />
                        </div>
                        <div className="field">
                            <label htmlFor="chamiloCode">Код курса</label>
                            <input
                                id="chamiloCode"
                                placeholder="TEST"
                                value={chamilo.courseCode}
                                onChange={(e) => updateChamilo("courseCode", e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="actions" style={{ marginTop: "12px" }}>
                        <button className="button" onClick={handlePublish} disabled={publishing || !chamilo.baseUrl}>
                            {publishing ? "⏳ Публикация..." : "🚀 Опубликовать"}
                        </button>
                    </div>
                </div>
            )}

            {pubResult && (
                <div className={pubResult.error ? "status warning" : "status success"}>
                    {pubResult.error ? `❌ ${pubResult.error}` : "✅ Опубликовано!"}
                </div>
            )}

            <CourseEditor course={course} onCourseUpdate={refreshCourse} />

            <div className="panel" style={{ marginTop: "16px" }}>
                <div className="tree-header">
                    <h3>📊 Статистика</h3>
                </div>
                <div className="field-grid">
                    <div className="field">
                        <label>Модулей</label>
                        <span style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent-strong)" }}>
                            {course.modules?.length || 0}
                        </span>
                    </div>
                    <div className="field">
                        <label>Экранов</label>
                        <span style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent-strong)" }}>
                            {course.modules?.reduce((acc, m) =>
                                acc + (m.sections?.reduce((a2, s) =>
                                    a2 + (s.scos?.reduce((a3, sco) => a3 + (sco.screens?.length || 0), 0) || 0), 0) || 0), 0) || 0}
                        </span>
                    </div>
                    <div className="field">
                        <label>Вопросов</label>
                        <span style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent-strong)" }}>
                            {course.finalTest?.questions?.length || 0}
                        </span>
                    </div>
                </div>
            </div>
        </main>
    );
}
