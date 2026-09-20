const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

const subscriptionsBody = document.getElementById("subscriptions-body");
const subscriptionsEmpty = document.getElementById("subscriptions-empty");
const appointmentsBody = document.getElementById("appointments-body");
const appointmentsEmpty = document.getElementById("appointments-empty");
const facturenBody = document.getElementById("facturen-body");
const facturenEmpty = document.getElementById("facturen-empty");
const mapEmpty = document.getElementById("map-empty");
const missingInBookkeepingBody = document.getElementById("missing-in-bookkeeping-body");
const missingInBookkeepingEmpty = document.getElementById("missing-in-bookkeeping-empty");
const missingInFacturenBody = document.getElementById("missing-in-facturen-body");
const missingInFacturenEmpty = document.getElementById("missing-in-facturen-empty");

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  subscriptions: document.getElementById("tab-subscriptions"),
  appointments: document.getElementById("tab-appointments"),
  facturen: document.getElementById("tab-facturen"),
  map: document.getElementById("tab-map"),
  bookkeeping: document.getElementById("tab-bookkeeping"),
};

let leafletMap = null;
let mapMarkers = null;

const STALE_PENDING_DAYS = 60;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatAmount(amount) {
  if (amount === null || amount === undefined) return "";
  return `€ ${Number(amount).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return "";
  return value;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// "Выполнено" is checked FIRST, ahead of cancellation — a real factuur means the job actually
// happened and got invoiced, which takes priority even over a stray cancellation email for the
// same klusnummer. Once that's ruled out, the stale-pending fallback below is safe to use: it
// used to risk mislabeling genuinely-completed old visits as cancelled, but now that a real
// completion is caught first, anything left really is just an old visit nobody followed up on.
function appointmentStatus(row, completedKlusnummers) {
  if (completedKlusnummers.has(row.klusnummer)) return "✅ Выполнено";
  if (row.cancelled_at) return "❌ Отменено";
  if (row.appointment_date) {
    const staleCutoff = new Date();
    staleCutoff.setDate(staleCutoff.getDate() - STALE_PENDING_DAYS);
    if (new Date(row.appointment_date) < staleCutoff) return "❌ Отменено через саппорт";
  }
  return "Ожидается";
}

async function loadSubscriptions() {
  const rows = await api("/api/subscriptions");
  subscriptionsBody.innerHTML = "";
  subscriptionsEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.factuur}</td>
      <td>${row.kenmerk}</td>
      <td>${formatDate(row.factuurdatum)}</td>
      <td>${formatDate(row.vervaldatum)}</td>
      <td>${formatAmount(row.amount)}</td>
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Открыть</a>` : ""}</td>
      <td>${row.pdf_url ? `<a href="${row.pdf_url}" target="_blank">PDF</a>` : ""}</td>
    `;
    subscriptionsBody.appendChild(tr);
  }
}

async function loadAppointments() {
  const [rows, facturen] = await Promise.all([api("/api/appointments"), api("/api/facturen")]);
  const completedKlusnummers = new Set(facturen.map((f) => f.klusnummer).filter(Boolean));
  appointmentsBody.innerHTML = "";
  appointmentsEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const link = row.cancelled_thread_link || row.thread_link;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.klusnummer}</td>
      <td>${row.klus || ""}</td>
      <td>${formatDate(row.appointment_date)}</td>
      <td>${formatDateTime(row.start_time)}</td>
      <td>${formatDateTime(row.end_time)}</td>
      <td>${appointmentStatus(row, completedKlusnummers)}</td>
      <td>${link ? `<a href="${link}" target="_blank">Открыть</a>` : ""}</td>
    `;
    appointmentsBody.appendChild(tr);
  }
}

async function loadFacturen() {
  const rows = await api("/api/facturen");
  facturenBody.innerHTML = "";
  facturenEmpty.hidden = rows.length > 0;

  const totalsByFactuur = {};
  for (const row of rows) {
    (totalsByFactuur[row.factuur] ||= new Set()).add(row.totaal);
  }

  for (const row of rows) {
    const hasDiscrepancy = totalsByFactuur[row.factuur].size > 1;
    const tr = document.createElement("tr");
    if (hasDiscrepancy) tr.classList.add("discrepancy");
    tr.innerHTML = `
      <td>${row.factuur}</td>
      <td>${row.klant || ""}</td>
      <td>${row.klusnummer || ""}</td>
      <td>${row.klusomschrijving || ""}</td>
      <td>${row.klusadres || ""}</td>
      <td>${formatDate(row.factuurdatum)}</td>
      <td>${formatDate(row.vervaldatum)}</td>
      <td>${formatAmount(row.totaal)}</td>
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Открыть</a>` : ""}</td>
      <td>${row.pdf_url ? `<a href="${row.pdf_url}" target="_blank">PDF</a>` : ""}</td>
    `;
    facturenBody.appendChild(tr);
  }
}

function ensureMap() {
  if (leafletMap) return;
  // Amsterdam-centered default view — every job so far is in/near NL, and there's nothing
  // to fit bounds to before the first load.
  leafletMap = L.map("map").setView([52.3676, 4.9041], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(leafletMap);
  mapMarkers = L.layerGroup().addTo(leafletMap);
}

async function loadMap() {
  ensureMap();
  const rows = await api("/api/facturen");
  const withCoords = rows.filter((r) => r.lat != null && r.lng != null);
  mapEmpty.hidden = withCoords.length > 0;

  mapMarkers.clearLayers();
  for (const row of withCoords) {
    const marker = L.marker([row.lat, row.lng]);
    marker.bindPopup(`
      <strong>${row.klusomschrijving || "Klus"}</strong><br>
      ${row.klusadres || ""}<br>
      ${formatDate(row.factuurdatum)}${row.thread_link ? ` · <a href="${row.thread_link}" target="_blank">Письмо</a>` : ""}
    `);
    mapMarkers.addLayer(marker);
  }

  // The map's container was hidden (display:none) until this tab was opened, so Leaflet's
  // internal size calculation needs a nudge once it's actually visible.
  setTimeout(() => {
    leafletMap.invalidateSize();
    if (withCoords.length > 0) {
      leafletMap.fitBounds(withCoords.map((r) => [r.lat, r.lng]), { padding: [20, 20] });
    }
  }, 0);
}

async function loadBookkeepingCompare() {
  const { missing_in_bookkeeping, missing_in_facturen } = await api("/api/bookkeeping/compare");

  missingInBookkeepingBody.innerHTML = "";
  missingInBookkeepingEmpty.hidden = missing_in_bookkeeping.length > 0;
  for (const row of missing_in_bookkeeping) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.factuur}</td>
      <td>${row.kenmerk || ""}</td>
      <td>${row.klant || ""}</td>
      <td>${formatAmount(row.totaal)}</td>
      <td>${formatDate(row.factuurdatum)}</td>
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Открыть</a>` : ""}</td>
    `;
    missingInBookkeepingBody.appendChild(tr);
  }

  missingInFacturenBody.innerHTML = "";
  missingInFacturenEmpty.hidden = missing_in_facturen.length > 0;
  for (const row of missing_in_facturen) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.invoice_number || ""}</td>
      <td>${row.file_name || ""}</td>
      <td>${row.customer_name || ""}</td>
      <td>${formatAmount(row.amount_incl)}</td>
      <td>${formatDate(row.invoice_date)}</td>
      <td>${row.state || ""}</td>
    `;
    missingInFacturenBody.appendChild(tr);
  }
}

function switchTab(name) {
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const [key, panel] of Object.entries(tabPanels)) {
    panel.hidden = key !== name;
  }
  if (name === "map") loadMap();
  if (name === "bookkeeping") loadBookkeepingCompare();
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

async function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  await Promise.all([loadSubscriptions(), loadAppointments(), loadFacturen()]);
}

async function init() {
  try {
    await api("/api/auth/me");
    await showApp();
  } catch {
    loginView.hidden = false;
    appView.hidden = true;
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    await showApp();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  loginView.hidden = false;
  appView.hidden = true;
});

init();
