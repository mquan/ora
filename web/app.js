/**
 * Bootstrap timeline view — a minimal vanilla replacement for the React SPA that lands in a later task.
 * Its only jobs: prove the DoD (the served page fetches the timeline JSON from the daemon) and establish
 * the token-handling contract the real SPA will reuse.
 *
 * Token (Jupyter model): the daemon's JSON API is bearer-authed, but this static code ships no secret.
 * `gregorian ui` opens the page with `?token=<token>` in the URL; we read it, stash it in sessionStorage,
 * and immediately strip it from the address bar (history.replaceState) so it doesn't linger in history or
 * leak via Referer. Every API call sends it as `Authorization: Bearer`.
 */

const TOKEN_KEY = "gregorian.token";

/** Read the token from `?token=` (first load) or sessionStorage (subsequent navigations). */
function resolveToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

/** GET a JSON API route with the bearer token. Throws on a non-2xx so the caller can surface it. */
async function api(path, token) {
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

/** Escape text for safe insertion into HTML (the daemon's data is local, but never trust-by-default). */
function esc(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Render the events table, joining each event to its latest run for status/exit. */
function render(events, runs) {
  const app = document.getElementById("app");
  if (!events.length) {
    app.innerHTML = '<p class="empty">No events scheduled yet. Add one with <code>gregorian add …</code>.</p>';
    return;
  }
  const latestByEvent = new Map();
  for (const run of runs) {
    if (run.role && run.role !== "run") continue;
    latestByEvent.set(run.event_id, run); // runs arrive in order; last wins
  }
  const rows = events
    .map((e) => {
      const run = latestByEvent.get(e.id);
      return `<tr>
        <td>${esc(e.scheduled_at)}</td>
        <td>${esc(e.engine)}</td>
        <td class="status">${esc(e.status)}</td>
        <td>${esc(run?.exit_code)}</td>
        <td>${esc(e.title)}</td>
      </tr>`;
    })
    .join("");
  app.innerHTML = `<table>
    <thead><tr><th>When</th><th>Engine</th><th>Status</th><th>Exit</th><th>Title</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function main() {
  const token = resolveToken();
  try {
    const [{ events }, { runs }] = await Promise.all([api("/events", token), api("/runs", token)]);
    render(events ?? [], runs ?? []);
  } catch (err) {
    const app = document.getElementById("app");
    app.innerHTML = `<p class="error">Could not load the timeline: ${esc(err.message)}.<br />
      If this says 401, reopen with <code>gregorian ui</code> so the page gets a fresh token.</p>`;
  }
}

main();
