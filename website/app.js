const STORAGE_KEY = "imphotogenic-prototype-v1";

function apiBase() {
  return String(window.IMPHOTOGENIC_API_URL || "").replace(/\/$/, "");
}

const defaultState = () => ({
  user: null,
  token: null,
  authMode: "login",
  uploadedDataUrl: null,
  uploadedName: null,
  gallery: [],
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const saved = JSON.parse(raw) || {};
    return { ...defaultState(), ...saved };
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    const light = {
      user: state.user,
      token: state.token,
      authMode: state.authMode,
      uploadedName: state.uploadedName,
      // Keep large images out of localStorage; the API owns gallery bytes.
      uploadedDataUrl: null,
      gallery: [],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(light));
  } catch {
    // Ignore persistence failures — in-memory flow must keep working.
  }
}

let state = loadState();
const pages = [...document.querySelectorAll(".page")];
const toastEl = document.getElementById("toast");

function animateHeroHeadline() {
  const question = document.getElementById("heroQuestion");
  const text = document.getElementById("heroTypingText");
  const promise = document.getElementById("heroPromise");
  const placeholder = question?.querySelector(".hero-question-placeholder");
  if (!question || !text || !promise || !placeholder) return;

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const characters = Array.from(placeholder.textContent.trim());
  text.textContent = "";
  question.classList.add("is-typing");
  promise.classList.add("is-pending");

  let index = 0;
  function typeNextCharacter() {
    text.textContent += characters[index];
    index += 1;
    if (index < characters.length) {
      window.setTimeout(typeNextCharacter, characters[index - 1] === " " ? 24 : 42);
      return;
    }

    question.classList.add("typing-complete");
    window.setTimeout(() => {
      promise.classList.remove("is-pending");
      promise.classList.add("is-visible");
    }, 2000);
  }

  typeNextCharacter();
}

animateHeroHeadline();

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "home";
  const [path, query = ""] = hash.split("?");
  const params = Object.fromEntries(new URLSearchParams(query));
  return { path, params };
}

function requireAuth(path) {
  return ["upload", "gallery"].includes(path);
}

function updateAuthChrome() {
  const loggedIn = Boolean(state.user && state.token);
  document.querySelectorAll(".auth-only").forEach((el) => {
    el.classList.toggle("hidden", !loggedIn);
  });
  document.querySelectorAll(".guest-only").forEach((el) => {
    el.classList.toggle("hidden", loggedIn);
  });
  const logoutBtn = document.getElementById("logoutBtn");
  logoutBtn.classList.toggle("hidden", !loggedIn);
}

function setAuthMode(mode) {
  state.authMode = mode === "signup" ? "signup" : "login";
  const isSignup = state.authMode === "signup";

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === state.authMode);
  });
  document.querySelectorAll(".signup-only").forEach((el) => {
    el.classList.toggle("hidden", !isSignup);
  });

  document.getElementById("authTitle").textContent = isSignup
    ? "Create your account"
    : "Welcome back";
  document.getElementById("authSub").textContent = isSignup
    ? "Sign up to unlock Pose Direct and your gallery."
    : "Log in to continue to Pose Direct & Upload.";
  document.getElementById("authSubmit").textContent = isSignup ? "Sign up" : "Log in";
  document.getElementById("authSwitchText").textContent = isSignup
    ? "Already have an account?"
    : "Need an account?";
  document.getElementById("authSwitch").textContent = isSignup ? "Log in" : "Sign up";
}

function clearUpload() {
  state.uploadedDataUrl = null;
  state.uploadedName = null;
  saveState();

  const fileInput = document.getElementById("fileInput");
  if (fileInput) fileInput.value = "";

  renderUpload();
}

async function api(pathname, options = {}) {
  const base = apiBase();
  if (!base) {
    throw new Error(
      "The account service is not configured for this site. Set IMPHOTOGENIC_API_URL to the deployed API address.",
    );
  }

  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const res = await fetch(`${base}${pathname}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return body;
}

async function refreshGallery() {
  if (!state.token) {
    state.gallery = [];
    return;
  }
  try {
    const data = await api("/api/gallery");
    // Inspiration uploads remain stored for pose coaching, but only Chert
    // captures belong in the user's visible gallery.
    state.gallery = (data.items || []).filter((item) => item.source === "chert").map((item) => ({
      id: item.id,
      url: item.url,
      name: item.originalName || (item.source === "chert" ? "Chert capture" : "Inspiration upload"),
      note: item.note || (item.source === "chert" ? "Captured by Chert" : "Saved to your gallery"),
      source: item.source,
      at: item.createdAt,
    }));
  } catch (err) {
    console.warn("gallery fetch failed", err);
    toast(err.message || "Could not load gallery");
  }
}

function renderUpload() {
  const preview = document.getElementById("uploadPreview");
  const empty = document.getElementById("uploadEmpty");
  const hasUpload = Boolean(state.uploadedDataUrl);

  if (hasUpload) {
    preview.src = state.uploadedDataUrl;
    preview.classList.remove("hidden");
    empty.classList.add("hidden");
  } else {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
    empty.classList.remove("hidden");
  }
}

function renderPoseConnection() {
  const phone = String(window.IMPHOTOGENIC_POSE_PHONE || "").trim();
  const joinCode = String(window.IMPHOTOGENIC_POSE_JOIN_CODE || "").trim();
  const qr = document.getElementById("poseQr");
  const fallback = document.getElementById("poseQrFallback");
  const phoneLink = document.getElementById("posePhoneNumber");
  document.getElementById("poseJoinCode").textContent = joinCode || "Set the join code in config.js";
  phoneLink.textContent = phone || "Set the phone number in config.js";
  phoneLink.href = phone ? `tel:${phone.replace(/[^+\d]/g, "")}` : "#";
  if (!phone) {
    qr.classList.add("hidden");
    fallback.textContent = "Add the Pose Direct phone number to config.js to generate its QR code.";
    fallback.classList.remove("hidden");
    return;
  }
  fallback.classList.add("hidden");
  qr.classList.remove("hidden");
  // A phone QR opens the device's dialer with the Pose Direct line prefilled.
  qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(`tel:${phone.replace(/[^+\d]/g, "")}`)}`;
  qr.onerror = () => {
    qr.classList.add("hidden");
    fallback.textContent = "QR code could not be loaded. Use the phone number below.";
    fallback.classList.remove("hidden");
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderGallery() {
  const grid = document.getElementById("galleryGrid");
  const sub = document.getElementById("gallerySub");
  const name = state.user?.name || state.user?.email || "you";

  sub.textContent = `Chert captures saved for ${name}.`;

  if (!state.gallery.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <strong>No shots yet</strong>
        <p style="color:var(--muted);margin:8px 0 18px">Your Chert captures will appear here.</p>
        <a class="btn btn-primary" href="#upload">Go to Pose Direct &amp; Upload</a>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.gallery
    .map((item, index) => {
      const src = item.url || item.dataUrl;
      const thumb = src
        ? `<img class="thumb" src="${escapeHtml(src)}" alt="${escapeHtml(item.name || "Gallery item " + (index + 1))}" />`
        : `<div class="thumb" role="img" aria-label="${escapeHtml(item.name || "Gallery item")}"></div>`;
      return `
      <article class="gallery-card">
        ${thumb}
        <div class="meta">
          <strong>${escapeHtml(item.name || "Inspiration upload")}</strong>
          <span>${escapeHtml(item.note || "Saved to your gallery")}</span>
        </div>
      </article>
    `;
    })
    .join("");
}

function showPage(path, params = {}) {
  let target = path || "home";
  if (!pages.some((page) => page.dataset.page === target)) target = "home";

  if (requireAuth(target) && !(state.user && state.token)) {
    toast("Sign up or log in first");
    target = "login";
    history.replaceState(null, "", "#login");
  }

  if (target === "login" && state.user && state.token) {
    target = "upload";
    history.replaceState(null, "", "#upload");
  }

  pages.forEach((page) => {
    page.classList.toggle("active", page.dataset.page === target);
  });

  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === target);
  });

  updateAuthChrome();

  if (target === "login") {
    clearUpload();
    setAuthMode(params.mode || state.authMode || "login");
  }
  if (target === "upload") {
    renderUpload();
    renderPoseConnection();
  }
  if (target === "gallery") {
    refreshGallery().then(() => renderGallery());
  }
}

function route() {
  const { path, params } = parseRoute();
  showPage(path, params);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = form.name.value.trim() || email.split("@")[0];
  const submit = document.getElementById("authSubmit");

  if (!email || !password) {
    toast("Enter email and password");
    return;
  }

  submit.disabled = true;
  try {
    const path = state.authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const data = await api(path, {
      method: "POST",
      body: JSON.stringify(
        state.authMode === "signup" ? { email, password, name } : { email, password }
      ),
    });

    state.user = data.user;
    state.token = data.token;
    state.gallery = [];
    state.uploadedDataUrl = null;
    state.uploadedName = null;
    saveState();
    renderUpload();
    toast(state.authMode === "signup" ? "Account created" : "Logged in");
    location.hash = "#upload";
  } catch (err) {
    toast(err.message || "Authentication failed");
  } finally {
    submit.disabled = false;
  }
}

function ingestFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("Please choose an image");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    state.uploadedDataUrl = reader.result;
    state.uploadedName = file.name;
    saveState();
    renderUpload();
    toast("Inspiration uploaded");
  };
  reader.readAsDataURL(file);
}

async function addUploadToGallery(note) {
  if (!state.uploadedDataUrl || !state.token) return;

  try {
    await api("/api/gallery", {
      method: "POST",
      body: JSON.stringify({
        imageBase64: state.uploadedDataUrl,
        name: state.uploadedName || "Inspiration upload",
        note,
        source: "upload",
      }),
    });
    await refreshGallery();
  } catch (err) {
    toast(err.message || "Could not save to gallery");
  }
}

async function handleContinueUpload() {
  if (!state.uploadedDataUrl) {
    toast("Please upload a reference photo");
    return;
  }
  await addUploadToGallery("Inspiration upload");
  location.hash = "#gallery";
}
document.getElementById("authForm").addEventListener("submit", handleAuthSubmit);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setAuthMode(tab.dataset.mode);
    const mode = state.authMode;
    history.replaceState(null, "", mode === "signup" ? "#login?mode=signup" : "#login");
  });
});

document.getElementById("authSwitch").addEventListener("click", () => {
  setAuthMode(state.authMode === "signup" ? "login" : "signup");
  const mode = state.authMode;
  history.replaceState(null, "", mode === "signup" ? "#login?mode=signup" : "#login");
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  state.user = null;
  state.token = null;
  state.gallery = [];
  clearUpload();
  saveState();
  toast("Logged out");
  location.hash = "#home";
  route();
});

const uploadZone = document.getElementById("uploadZone");
const fileInput = document.getElementById("fileInput");

["dragenter", "dragover"].forEach((evt) => {
  uploadZone.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  uploadZone.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadZone.classList.remove("dragover");
  });
});

uploadZone.addEventListener("drop", (e) => {
  ingestFile(e.dataTransfer.files?.[0]);
});

fileInput.addEventListener("change", () => {
  ingestFile(fileInput.files?.[0]);
  fileInput.value = "";
});

document.getElementById("continueUpload").addEventListener("click", handleContinueUpload);

async function restoreSession() {
  if (!state.token) return;
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    saveState();
  } catch {
    state.user = null;
    state.token = null;
    state.gallery = [];
    saveState();
  }
}

window.addEventListener("hashchange", route);
restoreSession().finally(route);
