"use client";

import { useState, useEffect } from "react";

const CARD_STYLE = {
  background: "var(--surface, #1e1e2e)",
  borderRadius: 12,
  padding: "20px 24px",
  border: "1px solid var(--line, #333)",
  marginBottom: 16
};

const STAT_CARD = {
  ...CARD_STYLE,
  textAlign: "center",
  flex: "1 1 180px",
  minWidth: 160
};

const BADGE_COLORS = {
  completed: { bg: "rgba(52, 168, 83, 0.15)", color: "#34a853" },
  failed: { bg: "rgba(234, 67, 53, 0.15)", color: "#ea4335" },
  started: { bg: "rgba(251, 188, 4, 0.15)", color: "#fbbc04" },
  approved: { bg: "rgba(52, 168, 83, 0.15)", color: "#34a853" },
  guest: { bg: "rgba(255,255,255,0.06)", color: "#9aa0a6" },
  banned: { bg: "rgba(234, 67, 53, 0.15)", color: "#ea4335" }
};

function StatusBadge({ status }) {
  const s = BADGE_COLORS[status] || BADGE_COLORS.guest;
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 12,
      fontSize: 11, fontWeight: 600, background: s.bg, color: s.color,
      textTransform: "capitalize"
    }}>{status}</span>
  );
}

function StatCard({ label, value, icon, color }) {
  return (
    <div style={STAT_CARD}>
      <div style={{ fontSize: 28, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || "var(--fg)" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted, #9aa0a6)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function MiniBarChart({ data, maxHeight = 80 }) {
  const max = Math.max(1, ...data.map(d => d.count));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: maxHeight }}>
      {data.map((d, i) => (
        <div key={i} title={`${d.date}: ${d.count}`} style={{
          flex: 1,
          height: Math.max(2, (d.count / max) * maxHeight),
          background: d.count > 0 ? "var(--primary, #1a73e8)" : "rgba(255,255,255,0.05)",
          borderRadius: "3px 3px 0 0",
          transition: "height 0.3s ease",
          cursor: "pointer",
          minWidth: 4
        }} />
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [password, setPassword] = useState("");
  const [isLogged, setIsLogged] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("scorm_bot_admin_pass");
    if (saved) { setPassword(saved); loadDashboard(saved); }
  }, []);

  const loadDashboard = async (pass) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/dashboard", {
        headers: { "Authorization": `Bearer ${pass}` }
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setIsLogged(true);
        localStorage.setItem("scorm_bot_admin_pass", pass);
      } else {
        localStorage.removeItem("scorm_bot_admin_pass");
        setIsLogged(false);
        setError("Неверный пароль");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (!isLogged) {
    return (
      <main className="shell" style={{ maxWidth: 400, marginTop: "100px" }}>
        <div style={CARD_STYLE}>
          <h2 style={{ marginBottom: 16 }}>📊 Dashboard</h2>
          {error && <p style={{ color: "#ea4335", fontSize: 13 }}>{error}</p>}
          <input
            type="password" className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            onKeyDown={(e) => e.key === "Enter" && loadDashboard(password)}
            style={{ width: "100%", marginBottom: 12 }}
          />
          <button className="button primary" style={{ width: "100%" }}
            onClick={() => loadDashboard(password)}>
            {loading ? "..." : "Войти"}
          </button>
        </div>
      </main>
    );
  }

  const o = data?.overview || {};

  return (
    <main className="shell" style={{ maxWidth: 960 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>📊 Dashboard</h1>
          <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>Аналитика генерации курсов</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button outline" onClick={() => loadDashboard(password)}
            style={{ minHeight: 0, padding: "6px 14px", fontSize: 12 }}>🔄 Обновить</button>
          <button className="button outline" onClick={() => {
            localStorage.removeItem("scorm_bot_admin_pass");
            setIsLogged(false);
          }} style={{ minHeight: 0, padding: "6px 14px", fontSize: 12 }}>Выйти</button>
        </div>
      </header>

      {/* Overview Cards */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <StatCard icon="👥" label="Пользователей" value={o.totalUsers || 0} />
        <StatCard icon="✅" label="Одобренных" value={o.approvedUsers || 0} color="#34a853" />
        <StatCard icon="📦" label="Генераций" value={o.totalGenerations || 0} />
        <StatCard icon="🎯" label="Успешность" value={`${o.successRate || 0}%`} color="#1a73e8" />
        <StatCard icon="📚" label="Курсов" value={o.totalCourses || 0} />
      </div>

      {/* Daily Chart */}
      <div style={CARD_STYLE}>
        <h3 style={{ marginBottom: 12, fontSize: 14 }}>📈 Генерации за 30 дней</h3>
        <MiniBarChart data={data?.dailyStats || []} maxHeight={100} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--muted)" }}>
          <span>{data?.dailyStats?.[0]?.date || ""}</span>
          <span>{data?.dailyStats?.[data.dailyStats.length - 1]?.date || ""}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Top Users */}
        <div style={{ ...CARD_STYLE, flex: "1 1 380px" }}>
          <h3 style={{ marginBottom: 12, fontSize: 14 }}>🏆 Топ пользователей</h3>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)", color: "var(--muted)", fontSize: 11 }}>
                <th style={{ textAlign: "left", padding: "6px 0" }}>ID</th>
                <th style={{ textAlign: "left" }}>Email</th>
                <th style={{ textAlign: "right" }}>Генер.</th>
                <th style={{ textAlign: "center" }}>Статус</th>
              </tr>
            </thead>
            <tbody>
              {(data?.topUsers || []).map((u) => (
                <tr key={u.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "8px 0", fontFamily: "monospace", fontSize: 12 }}>{u.id}</td>
                  <td>{u.email || "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{u.generations}</td>
                  <td style={{ textAlign: "center" }}><StatusBadge status={u.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.topUsers || []).length === 0 && <p style={{ color: "var(--muted)", fontSize: 13 }}>Нет данных</p>}
        </div>

        {/* Recent Generations */}
        <div style={{ ...CARD_STYLE, flex: "1 1 380px" }}>
          <h3 style={{ marginBottom: 12, fontSize: 14 }}>🕐 Последние генерации</h3>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {(data?.recentGenerations || []).map((g) => (
              <div key={g.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 13
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {g.title || "Без названия"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                    {new Date(g.createdAt).toLocaleString("ru-RU")}
                  </div>
                </div>
                <StatusBadge status={g.status} />
              </div>
            ))}
          </div>
          {(data?.recentGenerations || []).length === 0 && <p style={{ color: "var(--muted)", fontSize: 13 }}>Нет данных</p>}
        </div>
      </div>
    </main>
  );
}
