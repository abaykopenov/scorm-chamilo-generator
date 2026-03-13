// ---------------------------------------------------------------------------
// lib/scorm/themes.js — SCORM slide theme definitions
// ---------------------------------------------------------------------------

const defaultTheme = {
  name: "default",
  label: "Warm Classic",
  vars: {
    bg: "#f2ede4",
    surface: "rgba(255,255,255,0.92)",
    line: "rgba(38,20,13,0.12)",
    ink: "#26140d",
    muted: "#6c564a",
    accent: "#af3d1e",
    accentStrong: "#8e2e14",
    success: "#256f49"
  },
  bodyGradient: "linear-gradient(160deg, #f5efe6, #eadac4)",
  headingFont: '"Iowan Old Style", Georgia, serif',
  bodyFont: '"Avenir Next", "Segoe UI", sans-serif'
};

const darkTheme = {
  name: "dark",
  label: "Dark Mode",
  vars: {
    bg: "#1a1a2e",
    surface: "rgba(30,30,50,0.94)",
    line: "rgba(255,255,255,0.1)",
    ink: "#e0e0e0",
    muted: "#8888a0",
    accent: "#e94560",
    accentStrong: "#c73050",
    success: "#4ecca3"
  },
  bodyGradient: "linear-gradient(160deg, #16213e, #0f3460)",
  headingFont: '"Segoe UI", "Helvetica Neue", sans-serif',
  bodyFont: '"Segoe UI", "Helvetica Neue", sans-serif'
};

const corporateTheme = {
  name: "corporate",
  label: "Corporate Blue",
  vars: {
    bg: "#f0f4f8",
    surface: "rgba(255,255,255,0.96)",
    line: "rgba(0,30,60,0.1)",
    ink: "#1a2332",
    muted: "#5a6a7a",
    accent: "#2563eb",
    accentStrong: "#1d4ed8",
    success: "#16a34a"
  },
  bodyGradient: "linear-gradient(160deg, #f0f4f8, #dbeafe)",
  headingFont: '"Inter", "Segoe UI", sans-serif',
  bodyFont: '"Inter", "Segoe UI", sans-serif'
};

const THEMES = {
  default: defaultTheme,
  dark: darkTheme,
  corporate: corporateTheme
};

export function getTheme(name) {
  const key = `${name || ""}`.trim().toLowerCase();
  return THEMES[key] || THEMES.default;
}

export function getAvailableThemes() {
  return Object.values(THEMES).map(t => ({ name: t.name, label: t.label }));
}

export function buildThemeCss(theme) {
  const t = typeof theme === "string" ? getTheme(theme) : (theme || defaultTheme);

  return `:root {
  --bg: ${t.vars.bg};
  --surface: ${t.vars.surface};
  --line: ${t.vars.line};
  --ink: ${t.vars.ink};
  --muted: ${t.vars.muted};
  --accent: ${t.vars.accent};
  --accent-strong: ${t.vars.accentStrong};
  --success: ${t.vars.success};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: ${t.bodyGradient};
  color: var(--ink);
  font-family: ${t.bodyFont};
}
.shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}
.runtime-header {
  margin-bottom: 20px;
}
.runtime-badge {
  display: inline-flex;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(175,61,30,0.12);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1, h2, h3 { font-family: ${t.headingFont}; }
.card {
  padding: 22px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 20px 50px rgba(61,33,17,0.1);
}
.screen-meta,
.status {
  color: var(--muted);
}
.nav {
  display: flex;
  gap: 12px;
  margin-top: 20px;
  flex-wrap: wrap;
}
button {
  min-height: 42px;
  border-radius: 999px;
  border: none;
  padding: 0 16px;
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  color: #fff;
  font: inherit;
  cursor: pointer;
}
button.secondary {
  background: rgba(255,255,255,0.84);
  color: var(--ink);
  border: 1px solid var(--line);
}
.result.ok { color: var(--success); }
.question {
  display: grid;
  gap: 10px;
  padding: 16px 0;
  border-bottom: 1px solid rgba(38,20,13,0.08);
}
.question:last-child { border-bottom: none; }
.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.timer {
  display: inline-flex;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(38,20,13,0.06);
}
a { color: var(--accent-strong); }`;
}
