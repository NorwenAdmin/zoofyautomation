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

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  subscriptions: document.getElementById("tab-subscriptions"),
  appointments: document.getElementById("tab-appointments"),
  facturen: document.getElementById("tab-facturen"),
};

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

// "Выполнено" isn't computed here yet — that needs a join against `facturen`, which doesn't
// exist as a table/endpoint yet (planned in workflow 6). Until it does, the "stale → cancelled
// via support" fallback below is disabled: without a "Выполнено" check first, it would wrongly
// flag genuinely-completed old visits as cancelled, since there's currently no way to tell them
// apart. Re-enable once facturen exists and this function checks it first.
function appointmentStatus(row) {
  if (row.cancelled_at) return "❌ Отменено";
  if (false && row.appointment_date) {
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
  const rows = await api("/api/appointments");
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
      <td>${appointmentStatus(row)}</td>
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

function switchTab(name) {
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const [key, panel] of Object.entries(tabPanels)) {
    panel.hidden = key !== name;
  }
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
