"use client";

import { useState, useEffect } from "react";

export default function AdminPanel() {
  const [password, setPassword] = useState("");
  const [isLogged, setIsLogged] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  
  useEffect(() => {
    const saved = localStorage.getItem("scorm_bot_admin_pass");
    if (saved) {
      setPassword(saved);
      checkLogin(saved);
    }
  }, []);

  const checkLogin = async (pass) => {
    try {
      const res = await fetch("/api/admin/users", {
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
        setError("Invalid password");
      }
    } catch(e) {
      setError(String(e));
    }
  };

  const handleAction = async (id, action) => {
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${password}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id, action })
      });
      if (res.ok) {
        checkLogin(password);
      }
    } catch(e) {
      alert("Error: " + e.message);
    }
  };

  if (!isLogged) {
    return (
      <main className="shell" style={{ maxWidth: 400, marginTop: "100px" }}>
        <div className="card">
          <h2>Admin Panel Login</h2>
          {error && <p style={{ color: "red" }}>{error}</p>}
          <div className="form-group" style={{ marginTop: 20 }}>
            <label>Password</label>
            <input 
               type="password" 
               className="input" 
               value={password} 
               onChange={(e) => setPassword(e.target.value)} 
               placeholder="Enter admin password"
            />
          </div>
          <button 
             className="button primary" 
             style={{ width: "100%", marginTop: 20 }}
             onClick={() => checkLogin(password)}
          >
            Login
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="runtime-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
           <span className="runtime-badge">Admin</span>
           <h1>Telegram Bot Users</h1>
        </div>
        <button className="button outline" onClick={() => {
           localStorage.removeItem("scorm_bot_admin_pass");
           setIsLogged(false);
           setPassword("");
        }}>Log Out</button>
      </header>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Global Stats</h2>
        <p>Total Generated Courses in DB: <b>{data?.globals?.generatedCourses || 0}</b></p>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <h2>Users</h2>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse", minWidth: 600 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th style={{ padding: "8px 0" }}>Telegram ID</th>
              <th>Email</th>
              <th>Status</th>
              <th>Files</th>
              <th>Gens</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.users || []).map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td style={{ padding: "10px 0" }}>{u.id}</td>
                <td>{u.email || "N/A"}</td>
                <td>
                  <span style={{ 
                     display: "inline-block", 
                     padding: "2px 8px", 
                     borderRadius: 12, 
                     fontSize: 12,
                     backgroundColor: u.status === "approved" ? "rgba(37, 111, 73, 0.1)" : 
                                      u.status === "banned" ? "rgba(200, 0, 0, 0.1)" : "rgba(0,0,0,0.05)",
                     color: u.status === "approved" ? "var(--success)" : 
                            u.status === "banned" ? "red" : "var(--muted)",
                     textTransform: "capitalize"
                  }}>
                    {u.status}
                  </span>
                </td>
                <td>{u.documentsCount}</td>
                <td>{u.generationsCount}</td>
                <td>
                  {u.status !== "banned" && (
                     <button className="button outline" style={{ transform: "scale(0.85)", marginRight: 5, minHeight: 0, padding: "4px 12px" }} onClick={() => handleAction(u.id, "ban")}>Ban</button>
                  )}
                  {u.status !== "approved" && (
                     <button className="button primary" style={{ transform: "scale(0.85)", minHeight: 0, padding: "4px 12px" }} onClick={() => handleAction(u.id, "unban")}>Approve</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.users?.length === 0 && <p style={{ marginTop: 20 }}>No users found.</p>}
      </div>
    </main>
  );
}
