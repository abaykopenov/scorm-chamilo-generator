// Fix: update all exercises to set finishText to empty string via web form
const BASE = "http://192.168.8.179/chamilo";
const cookies = {};
function ec(r) { for (const h of r.headers.getSetCookie?.() || []) { const m = h.match(/^([^=]+)=([^;]*)/); if (m) cookies[m[1]] = m[2]; } }
function ch() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "); }

// Login
const lp = await fetch(`${BASE}/index.php`, { redirect: "manual" }); ec(lp);
const lh = await lp.text();
const hd = {}; let m;
const ir = /<input[^>]*>/gi;
while ((m = ir.exec(lh))) { const t = m[0]; if (!/hidden/i.test(t)) continue; const n = t.match(/name=["']([^"']*)/i); const v = t.match(/value=["']([^"']*)/i); if (n) hd[n[1]] = v?.[1] || ""; }
const lb = new URLSearchParams(); for (const [k, v] of Object.entries(hd)) lb.set(k, v); lb.set("login", "admin"); lb.set("password", "admin");
const lr = await fetch(`${BASE}/index.php`, { method: "POST", headers: { Cookie: ch(), "Content-Type": "application/x-www-form-urlencoded" }, body: lb, redirect: "manual" }); ec(lr);
if (lr.status >= 300) { const loc = lr.headers.get("location"); if (loc) { const r = await fetch(new URL(loc, BASE).toString(), { headers: { Cookie: ch() }, redirect: "manual" }); ec(r); } }
console.log("Logged in ✅\n");

// Get exercise list
const exListResp = await fetch(`${BASE}/main/exercise/exercise.php?cidReq=TEST`, { headers: { Cookie: ch() } });
const exListHtml = await exListResp.text();
const exIds = [...new Set((exListHtml.match(/exerciseId=(\d+)/g) || []).map(s => s.split("=")[1]))];
console.log("Found exercises:", exIds.join(", "));

// For each exercise, open edit form and find the finish text field
for (const exId of exIds) {
    const editUrl = `${BASE}/main/exercise/exercise_admin.php?cidReq=TEST&modifyExercise=yes&exerciseId=${exId}`;
    const editResp = await fetch(editUrl, { headers: { Cookie: ch() } }); ec(editResp);
    const editHtml = await editResp.text();

    // Check what fields exist for finish/end text
    const finishFields = [];
    for (const pattern of ["finish", "end_message", "EndMessage", "text_when", "onSuccessMessage", "onFailureMessage"]) {
        const re = new RegExp(`name\\s*=\\s*["']([^"']*${pattern}[^"']*)`, "gi");
        while ((m = re.exec(editHtml))) finishFields.push(m[1]);
    }

    if (finishFields.length > 0) {
        console.log(`\nExercise ${exId}: finish-related fields: ${finishFields.join(", ")}`);
    }

    // Extract ALL hidden fields and form fields
    const allHiddens = {};
    const inputRe = /<input[^>]*>/gi;
    while ((m = inputRe.exec(editHtml))) {
        const tag = m[0];
        if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
        const nm = tag.match(/name\s*=\s*["']([^"']*)/i);
        const vl = tag.match(/value\s*=\s*["']([^"']*)/i);
        if (nm) allHiddens[nm[1]] = vl?.[1] || "";
    }

    // Find the title
    const titleMatch = editHtml.match(/name\s*=\s*["']exerciseTitle["'][^>]*value\s*=\s*["']([^"']*)/i)
        || editHtml.match(/value\s*=\s*["']([^"']*)[^>]*name\s*=\s*["']exerciseTitle["']/i);
    const title = titleMatch ? titleMatch[1] : `Exercise ${exId}`;

    // Build and POST the edit form
    const postUrl = editUrl;
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(allHiddens)) body.set(k, v);
    body.set("exerciseTitle", title);
    body.set("exerciseDescription", "");
    body.set("exerciseFeedbackType", "0");
    body.set("results_disabled", "0");
    body.set("exerciseType", "2");
    body.set("exerciseAttempts", "0");
    body.set("pass_percentage", "50");
    // Set ALL finish text fields
    for (const field of finishFields) {
        body.set(field, "");
    }
    body.set("submitExercise", "");

    const resp = await fetch(postUrl, {
        method: "POST",
        headers: { Cookie: ch(), "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual"
    });
    ec(resp);
    console.log(`Exercise ${exId} ("${title}"): status=${resp.status}`);
    if (resp.status >= 300) {
        const loc = resp.headers.get("location");
        if (loc) { const r = await fetch(new URL(loc, postUrl).toString(), { headers: { Cookie: ch() } }); ec(r); }
    }
}

console.log("\n✅ Done! Try the test again.");
