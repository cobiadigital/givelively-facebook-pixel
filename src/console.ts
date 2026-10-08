/**
 * A tiny admin page served at "/". It holds no data itself: it asks for the admin
 * token (kept only in this browser) and calls /status, /run and /sample with an
 * Authorization header, which a phone browser cannot send on its own.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>CAPI Worker Admin</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1b1f24; --muted:#5b6470; --line:#d8dde3; --accent:#1f6feb; --accent-text:#fff; --code:#eef1f4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1216; --card:#171b21; --text:#e6e9ed; --muted:#9aa4af; --line:#2a313a; --accent:#4c8dff; --accent-text:#0b0d10; --code:#0b0e12; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width:720px; margin:0 auto; padding:16px; }
  h1 { font-size:1.25rem; margin:8px 0 4px; }
  p { color:var(--muted); margin:0 0 16px; font-size:.9rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:12px; }
  label { display:block; font-size:.85rem; color:var(--muted); margin:8px 0 4px; }
  input { width:100%; padding:10px 12px; font-size:16px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
  button { padding:12px; font-size:15px; font-weight:600; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  button.primary { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
  pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; font-size:12.5px; white-space:pre-wrap; word-break:break-word; min-height:4em; margin:0; }
  .status { font-size:.85rem; color:var(--muted); margin:0 0 6px; }
</style>
</head>
<body>
<main>
  <h1>Give Lively to Meta CAPI</h1>
  <p>Admin console. Your token is stored only in this browser.</p>

  <div class="card">
    <label for="token">Admin token</label>
    <input id="token" type="password" autocomplete="current-password" placeholder="ADMIN_TOKEN">
    <div class="row">
      <button class="primary" data-act="status">Status</button>
      <button data-act="dry">Dry run</button>
      <button data-act="run">Run now</button>
      <button data-act="backfill">Send look-back</button>
      <button data-act="forget">Forget token</button>
    </div>
  </div>

  <div class="card">
    <label>Test the Give Lively endpoints from this Worker</label>
    <div class="row">
      <button class="primary" data-act="probe">Test Give Lively</button>
      <button data-act="probe-noua">Test, no User-Agent</button>
    </div>
  </div>

  <div class="card">
    <label for="hours">Look-back window in hours (Sample and Dry run)</label>
    <input id="hours" type="number" inputmode="numeric" value="24" min="1">
    <label for="values">Show values for fields (comma separated, optional)</label>
    <input id="values" type="text" placeholder="e.g. status, line_item_type, event_name" autocapitalize="off" autocorrect="off">
    <div class="row">
      <button class="primary" data-act="sample">Sample schema</button>
      <button data-act="copy">Copy output</button>
    </div>
  </div>

  <div class="card">
    <div class="status" id="state">Ready.</div>
    <pre id="out"></pre>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const store = {
    get() { try { return localStorage.getItem("capi_admin_token") || ""; } catch { return ""; } },
    set(v) { try { localStorage.setItem("capi_admin_token", v); } catch {} },
    clear() { try { localStorage.removeItem("capi_admin_token"); } catch {} },
  };
  $("token").value = store.get();

  async function call(method, path) {
    const token = $("token").value.trim();
    if (!token) { $("state").textContent = "Enter the admin token first."; return; }
    store.set(token);
    $("state").textContent = method + " " + path.split("?")[0] + " ...";
    try {
      const res = await fetch(path, { method, headers: { authorization: "Bearer " + token } });
      const text = await res.text();
      let body = text;
      try { body = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      $("state").textContent = "HTTP " + res.status + " at " + new Date().toLocaleTimeString();
      $("out").textContent = body;
    } catch (e) {
      $("state").textContent = "Request failed: " + e;
    }
  }

  document.addEventListener("click", (ev) => {
    const act = ev.target && ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    if (act === "status") call("GET", "/status");
    if (act === "probe") call("GET", "/probe");
    if (act === "probe-noua") call("GET", "/probe?ua=none");
    if (act === "dry") call("POST", "/run?dry=1&hours=" + encodeURIComponent($("hours").value || "24"));
    if (act === "run" && confirm("Run one poll now? If sending is enabled, new ticket sales go to Meta.")) call("POST", "/run");
    if (act === "backfill") {
      const h = $("hours").value || "24";
      if (confirm("Send every unsent purchase from the last " + h + " hours to Meta? (Meta ignores anything older than 7 days.)")) {
        call("POST", "/run?hours=" + encodeURIComponent(h));
      }
    }
    if (act === "forget") { store.clear(); $("token").value = ""; $("state").textContent = "Token forgotten."; }
    if (act === "sample") {
      const q = new URLSearchParams({ hours: $("hours").value || "24" });
      const v = $("values").value.trim();
      if (v) q.set("values", v);
      call("GET", "/sample?" + q.toString());
    }
    if (act === "copy") {
      navigator.clipboard.writeText($("out").textContent).then(
        () => { $("state").textContent = "Copied."; },
        () => { $("state").textContent = "Copy failed. Long-press the output to select it."; });
    }
  });
</script>
</body>
</html>`;
