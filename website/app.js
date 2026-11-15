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
  wantLocations: true,
  userLocation: null,
  gallery: [],
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    // Location coordinates are session-only and are never restored from storage.
    return { ...defaultState(), ...JSON.parse(raw), userLocation: null };
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
      wantLocations: state.wantLocations,
      userLocation: null,
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
let recommendationState = { status: "idle", result: null, error: null };
let recommendationRequestId = 0;

const pages = [...document.querySelectorAll(".page")];
const toastEl = document.getElementById("toast");

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
  return ["upload", "location", "gallery"].includes(path);
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
    ? "Sign up to unlock Pose Direct, locations, and your gallery."
    : "Log in to continue to Pose Direct & Upload.";
  document.getElementById("authSubmit").textContent = isSignup ? "Sign up" : "Log in";
  document.getElementById("authSwitchText").textContent = isSignup
    ? "Already have an account?"
    : "Need an account?";
  document.getElementById("authSwitch").textContent = isSignup ? "Log in" : "Sign up";
}

function clearUpload() {
  recommendationRequestId += 1;
  recommendationState = { status: "idle", result: null, error: null };
  state.uploadedDataUrl = null;
  state.uploadedName = null;
  state.userLocation = null;
  saveState();

  const fileInput = document.getElementById("fileInput");
  if (fileInput) fileInput.value = "";

  closeLocationModal();
  renderUpload();
}

async function api(pathname, options = {}) {
  const base = apiBase();
  if (!base) {
    throw new Error("Set IMPHOTOGENIC_API_URL to your API server");
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
    state.gallery = (data.items || []).map((item) => ({
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

  document.getElementById("wantLocations").checked = state.wantLocations;

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

function setRecommendationStatus(status, result = null, error = null) {
  recommendationState = { status, result, error };
  renderLocation();
}

function renderRecommendationCards(spots) {
  const list = document.getElementById("recommendationList");
  list.replaceChildren();

  for (const spot of spots.slice(0, 3)) {
    const card = document.createElement("article");
    card.className = "reco-card";

    const category = document.createElement("span");
    category.className = "tag";
    const matchedTags = Array.isArray(spot.tags) ? spot.tags.slice(0, 2).join(" · ") : "";
    category.textContent = [spot.category || "Photo spot", matchedTags].filter(Boolean).join(" · ");

    const title = document.createElement("h3");
    title.textContent = spot.name || "Nearby photo spot";

    const description = document.createElement("p");
    description.className = "reco-description";
    description.textContent = spot.description || "A nearby place that may suit your reference photo.";

    const meta = document.createElement("div");
    meta.className = "reco-meta";
    meta.textContent = [spot.distance_text, spot.heading_text].filter(Boolean).join(" · ");

    card.append(category, title, description, meta);
    if (typeof spot.maps_url === "string") {
      try {
        const mapUrl = new URL(spot.maps_url);
        if (mapUrl.protocol === "https:" && mapUrl.hostname === "www.google.com") {
          const link = document.createElement("a");
          link.className = "map-link";
          link.href = mapUrl.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Open in Google Maps ↗";
          card.append(link);
        }
      } catch {
        // Ignore malformed map URLs from the recommendation service.
      }
    }
    list.append(card);
  }
}

function renderProximityMap(spots, lat, lng) {
  const map = document.getElementById("proximityMap");
  if (!map) return;
  map.replaceChildren();
  map.classList.remove("hidden");

  const you = document.createElement("span");
  you.className = "map-pin you";
  you.textContent = "You";
  you.style.left = "50%";
  you.style.top = "50%";
  map.append(you);

  const latitudeScale = 110.574;
  const longitudeScale = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const [index, spot] of spots.slice(0, 3).entries()) {
    const eastKm = (Number(spot.lng) - lng) * longitudeScale;
    const northKm = (Number(spot.lat) - lat) * latitudeScale;
    const left = Math.max(12, Math.min(88, 50 + eastKm * 4.1));
    const top = Math.max(16, Math.min(86, 50 - northKm * 4.1));
    const name = String(spot.name || "Nearby spot");
    const shortName = name.length > 24 ? `${name.slice(0, 22).trimEnd()}…` : name;
    const pin = document.createElement("span");
    pin.className = "map-pin";
    pin.style.left = `${left}%`;
    pin.style.top = `${top}%`;
    pin.style.setProperty("--pin-order", String(index));
    pin.textContent = `${spot.distance_text || "Nearby"} ${shortName}`;
    pin.title = name;
    map.append(pin);
  }
}

async function requestLocationRecommendations() {
  const { lat, lng } = state.userLocation || {};
  if (!state.uploadedDataUrl || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const requestId = ++recommendationRequestId;
  recommendationState = { status: "loading", result: null, error: null };
  renderLocation();

  try {
    const blob = await (await fetch(state.uploadedDataUrl)).blob();
    const form = new FormData();
    form.append("image", blob, state.uploadedName || "reference-photo.png");
    form.append("lat", String(lat));
    form.append("lng", String(lng));
    const result = await api("/api/locations/recommendations", { method: "POST", body: form });
    if (requestId !== recommendationRequestId) return;
    recommendationState = { status: "ready", result, error: null };
  } catch (error) {
    if (requestId !== recommendationRequestId) return;
    recommendationState = { status: "error", result: null, error: error.message || "Could not load nearby recommendations." };
  }
  renderLocation();
}

function renderLocation() {
  const sub = document.getElementById("locationSub");
  const status = document.getElementById("recommendationStatus");
  const scene = document.getElementById("referenceScene");
  const attribution = document.getElementById("recommendationAttribution");
  const map = document.getElementById("proximityMap");
  const retryLocation = document.getElementById("retryLocationBtn");
  const retryRecommendations = document.getElementById("retryRecommendationsBtn");
  const list = document.getElementById("recommendationList");
  if (!sub || !status || !scene || !attribution || !map || !retryLocation || !retryRecommendations || !list) return;

  const { lat, lng } = state.userLocation || {};
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
  scene.classList.add("hidden");
  attribution.classList.add("hidden");
  map.classList.add("hidden");
  map.replaceChildren();
  retryRecommendations.classList.add("hidden");
  list.replaceChildren();

  if (!hasLocation) {
    sub.textContent = state.userLocation?.denied
      ? "Turn on your location to see recommendations! 😊"
      : "Share your location to find nearby places that fit your reference photo.";
    status.textContent = "";
    retryLocation.classList.toggle("hidden", !state.userLocation?.denied);
    return;
  }

  retryLocation.classList.add("hidden");
  sub.textContent = `Matching spots near your shared location (${lat.toFixed(4)}, ${lng.toFixed(4)}).`;

  if (recommendationState.status === "idle") {
    requestLocationRecommendations();
    return;
  }
  if (recommendationState.status === "loading") {
    status.textContent = "Grok is reading the background, then Typesense will find nearby spots…";
    return;
  }
  if (recommendationState.status === "error") {
    status.textContent = recommendationState.error;
    retryRecommendations.classList.remove("hidden");
    return;
  }

  const result = recommendationState.result || {};
  const sceneLabel = result.reference_background || result.reference_scene;
  if (sceneLabel || result.reference_group) {
    const tags = Array.isArray(result.reference_tags) ? result.reference_tags : [];
    scene.textContent = [
      result.reference_group ? `Background group: ${result.reference_group.replaceAll("_", " ")}` : `Reference background: ${sceneLabel}`,
      tags.length ? `Tags: ${tags.join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    scene.classList.remove("hidden");
  }

  const spots = Array.isArray(result.spots) ? result.spots.slice(0, 3) : [];
  if (result.ok && spots.length) {
    sub.textContent = `Matching spots near your shared location (${lat.toFixed(4)}, ${lng.toFixed(4)}).`;
    status.textContent = `Grok classified the background; Typesense found ${spots.length} nearby match${spots.length === 1 ? "" : "es"}.`;
    renderProximityMap(spots, lat, lng);
    renderRecommendationCards(spots);
    if (result.attribution) {
      attribution.textContent = result.attribution;
      attribution.classList.remove("hidden");
    }
    return;
  }

  status.textContent = result.message || "No matching nearby places were found.";
  if (!result.ok) retryRecommendations.classList.remove("hidden");
}

function openLocationModal() {
  const modal = document.getElementById("locationModal");
  if (!modal) return;
  const status = document.getElementById("locationModalStatus");
  if (status) status.textContent = "";
  const allowBtn = document.getElementById("allowLocationBtn");
  if (allowBtn) allowBtn.disabled = false;
  modal.classList.remove("hidden");
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
}

function closeLocationModal() {
  const modal = document.getElementById("locationModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  const status = document.getElementById("locationModalStatus");
  if (status) status.textContent = "";
  const allowBtn = document.getElementById("allowLocationBtn");
  if (allowBtn) allowBtn.disabled = false;
}

function goToLocationPage() {
  closeLocationModal();
  location.hash = "#location";
}

function requestUserLocation() {
  const status = document.getElementById("locationModalStatus");
  const allowBtn = document.getElementById("allowLocationBtn");

  if (!navigator.geolocation) {
    status.textContent = "Geolocation is not supported in this browser.";
    state.userLocation = { denied: true };
    saveState();
    setTimeout(goToLocationPage, 700);
    return;
  }

  allowBtn.disabled = true;
  status.textContent =
    "Check the browser location prompt (often near the address bar), then Allow.";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        denied: false,
      };
      recommendationRequestId += 1;
      recommendationState = { status: "idle", result: null, error: null };
      saveState();
      status.textContent = "Location received — opening recommendations…";
      toast("Location shared");
      setTimeout(goToLocationPage, 250);
    },
    (error) => {
      state.userLocation = { denied: true, code: error.code };
      saveState();
      status.textContent = "Turn on your location to see recommendations! 😊";
      allowBtn.disabled = false;
      setTimeout(goToLocationPage, 600);
    },
    { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 }
  );
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

  sub.textContent = `Gallery for ${name}. Inspiration uploads and Chert snaps stay with this account.`;

  if (!state.gallery.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <strong>No shots yet</strong>
        <p style="color:var(--muted);margin:8px 0 18px">Upload inspiration or take a Chert snap to seed your gallery.</p>
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

  if (requireAuth(target) && !(state.user && state.token)) {
    toast("Sign up or log in first");
    target = "login";
    history.replaceState(null, "", "#login");
  }

  if (target === "login" && state.user && state.token) {
    target = "upload";
    history.replaceState(null, "", "#upload");
  }

  if (target === "location" && state.user && !state.uploadedDataUrl) {
    toast("Upload an image before opening locations");
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
  if (target === "upload") renderUpload();
  if (target === "location") renderLocation();
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
    state.userLocation = null;
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
    recommendationRequestId += 1;
    recommendationState = { status: "idle", result: null, error: null };
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

function handleContinueUpload(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const wantLocations = Boolean(document.getElementById("wantLocations")?.checked);
  state.wantLocations = wantLocations;

  if (!state.uploadedDataUrl) {
    toast("Please upload a reference photo");
    return;
  }

  if (wantLocations) {
    openLocationModal();
  } else {
    toast("Skipped location matching");
    location.hash = "#gallery";
  }

  addUploadToGallery(
    wantLocations ? "Uploaded · location matching requested" : "Uploaded · locations skipped"
  );
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

document.getElementById("wantLocations").addEventListener("change", (e) => {
  state.wantLocations = e.target.checked;
  saveState();
});

document.getElementById("continueUpload").addEventListener("click", handleContinueUpload);

document.getElementById("allowLocationBtn").addEventListener("click", () => {
  requestUserLocation();
});

document.getElementById("denyLocationBtn").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  recommendationRequestId += 1;
  recommendationState = { status: "idle", result: null, error: null };
  state.userLocation = { denied: true };
  saveState();
  closeLocationModal();
  location.hash = "#location";
});

document.getElementById("retryLocationBtn").addEventListener("click", openLocationModal);

document.getElementById("retryRecommendationsBtn").addEventListener("click", () => {
  recommendationState = { status: "idle", result: null, error: null };
  renderLocation();
});

document.getElementById("skipToGallery").addEventListener("click", () => {
  if (state.uploadedDataUrl) {
    addUploadToGallery("Uploaded · jumped to gallery");
  }
  location.hash = "#gallery";
});

document.getElementById("copyNumberBtn").addEventListener("click", async () => {
  const number = "+1 (646) 391-6614";
  try {
    await navigator.clipboard.writeText(number);
    toast("Studio number copied");
  } catch {
    toast(number);
  }
});

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
