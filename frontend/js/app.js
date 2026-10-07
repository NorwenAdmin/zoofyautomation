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
const revenueBody = document.getElementById("revenue-body");
const revenueEmpty = document.getElementById("revenue-empty");

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  subscriptions: document.getElementById("tab-subscriptions"),
  appointments: document.getElementById("tab-appointments"),
  facturen: document.getElementById("tab-facturen"),
  map: document.getElementById("tab-map"),
  bookkeeping: document.getElementById("tab-bookkeeping"),
  revenue: document.getElementById("tab-revenue"),
};

let leafletMap = null;
let mapMarkers = null;

const STALE_PENDING_DAYS = 60;
const DEFAULT_TAB = "subscriptions";
const ACTIVE_TAB_KEY = "zoofyautomation:activeTab";

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
  return d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// "Completed" is checked FIRST, ahead of cancellation — a real factuur means the job actually
// happened and got invoiced, which takes priority even over a stray cancellation email for the
// same klusnummer. Once that's ruled out, the stale-pending fallback below is safe to use: it
// used to risk mislabeling genuinely-completed old visits as cancelled, but now that a real
// completion is caught first, anything left really is just an old visit nobody followed up on.
function appointmentStatus(row, completedKlusnummers) {
  if (completedKlusnummers.has(row.klusnummer)) return "✅ Completed";
  if (row.cancelled_at) return "❌ Cancelled";
  if (row.appointment_date) {
    const staleCutoff = new Date();
    staleCutoff.setDate(staleCutoff.getDate() - STALE_PENDING_DAYS);
    if (new Date(row.appointment_date) < staleCutoff) return "❌ Cancelled via support";
  }
  return "Pending";
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
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Open</a>` : ""}</td>
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
      <td>${link ? `<a href="${link}" target="_blank">Open</a>` : ""}</td>
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
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Open</a>` : ""}</td>
      <td>${row.pdf_url ? `<a href="${row.pdf_url}" target="_blank">PDF</a>` : ""}</td>
    `;
    facturenBody.appendChild(tr);
  }
}

// Grasweg 3L3, 1031HW Amsterdam — geocoded once via Nominatim, hardcoded since it never changes.
const HOME_COORDS = [52.3882496, 4.9038942];

// WoW item-rarity colors, indexed by price tier (0 = Poor .. 5 = Legendary). Boundaries are the
// real quartiles/percentiles of facturen.totaal (p25≈65, p50≈96→100, p75≈150, p90≈276, p97≈439),
// not guessed round numbers.
const TIER_COLORS = ["#9d9d9d", "#ffffff", "#1eff00", "#0070dd", "#a335ee", "#ff8000"];

function priceTier(totaal) {
  if (totaal == null) return 0;
  if (totaal < 65) return 0;
  if (totaal < 100) return 1;
  if (totaal < 150) return 2;
  if (totaal < 275) return 3;
  if (totaal < 440) return 4;
  return 5;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bonus for being close to home: super-close (<500m) jobs are rarer-feeling than the price alone
// would suggest, down to "it's basically next door" — tapering off to 0 past Utrecht's distance.
function geoBonus(lat, lng) {
  const km = haversineKm(HOME_COORDS[0], HOME_COORDS[1], lat, lng);
  if (km < 0.5) return 3;
  if (km < 15) return 2;
  if (km < 36.25) return 1;
  return 0;
}

function tierColor(row) {
  const tier = Math.min(5, priceTier(row.totaal) + geoBonus(row.lat, row.lng));
  return TIER_COLORS[tier];
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
  L.circleMarker(HOME_COORDS, {
    radius: 9,
    color: "#ffffff",
    weight: 2,
    fillColor: "#e60000",
    fillOpacity: 1,
  })
    .bindPopup("🏠 Home")
    .addTo(leafletMap);
}

async function loadMap() {
  ensureMap();
  const rows = await api("/api/facturen");
  const withCoords = rows.filter((r) => r.lat != null && r.lng != null);
  mapEmpty.hidden = withCoords.length > 0;

  mapMarkers.clearLayers();
  for (const row of withCoords) {
    const marker = L.circleMarker([row.lat, row.lng], {
      radius: 7,
      color: "#1a1a1a",
      weight: 1.5,
      fillColor: tierColor(row),
      fillOpacity: 0.9,
    });
    marker.bindPopup(`
      <strong>${row.klusomschrijving || "Job"}</strong><br>
      ${row.klusadres || ""}<br>
      ${formatAmount(row.totaal)}<br>
      ${formatDate(row.factuurdatum)}${row.thread_link ? ` · <a href="${row.thread_link}" target="_blank">Email</a>` : ""}
    `);
    mapMarkers.addLayer(marker);
  }

  // The map's container was hidden (display:none) until this tab was opened, so Leaflet's
  // internal size calculation needs a nudge once it's actually visible.
  setTimeout(() => {
    leafletMap.invalidateSize();
    if (withCoords.length > 0) {
      leafletMap.fitBounds([...withCoords.map((r) => [r.lat, r.lng]), HOME_COORDS], { padding: [20, 20] });
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
      <td>${row.thread_link ? `<a href="${row.thread_link}" target="_blank">Open</a>` : ""}</td>
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

async function loadRevenue() {
  const rows = await api("/api/facturen/revenue-by-week");
  revenueBody.innerHTML = "";
  revenueEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.week_number}</td>
      <td>${formatDate(row.week_start)} – ${formatDate(row.week_end)}</td>
      <td>${formatAmount(row.total)}</td>
      <td>${row.invoice_count}</td>
      <td>${formatAmount(row.total / row.invoice_count)}</td>
    `;
    revenueBody.appendChild(tr);
  }
}

function switchTab(name) {
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const [key, panel] of Object.entries(tabPanels)) {
    panel.hidden = key !== name;
  }
  // Per-viewer convenience only (which tab was open) — safe to lose in a private window or
  // with site data cleared, so every access is wrapped rather than assumed to succeed.
  try {
    localStorage.setItem(ACTIVE_TAB_KEY, name);
  } catch {}
  if (name === "map") loadMap();
  if (name === "bookkeeping") loadBookkeepingCompare();
  if (name === "revenue") loadRevenue();
}

function restoreActiveTab() {
  let saved = null;
  try {
    saved = localStorage.getItem(ACTIVE_TAB_KEY);
  } catch {}
  switchTab(saved && tabPanels[saved] ? saved : DEFAULT_TAB);
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

async function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  await Promise.all([loadSubscriptions(), loadAppointments(), loadFacturen()]);
  restoreActiveTab();
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
