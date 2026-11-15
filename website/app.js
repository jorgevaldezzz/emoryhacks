const STORAGE_KEY = "imphotogenic-prototype-v1";

const defaultState = () => ({
  user: null,
  authMode: "login",
  uploadedDataUrl: null,
  uploadedName: null,
  wantLocations: true,
  gallery: [],
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

const pages = [...document.querySelectorAll(".page")];
const toastEl = document.getElementById("toast");
const flowHint = document.getElementById("flowHint");

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
  const loggedIn = Boolean(state.user);
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

function renderUpload() {
  const preview = document.getElementById("uploadPreview");
  const empty = document.getElementById("uploadEmpty");
  const continueBtn = document.getElementById("continueUpload");
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

  continueBtn.disabled = !hasUpload;
}

function renderGallery() {
  const grid = document.getElementById("galleryGrid");
  const sub = document.getElementById("gallerySub");
  const name = state.user?.name || state.user?.email || "you";

  sub.textContent = `Gallery for ${name}. Uploads from this session stay with the account.`;

  if (!state.gallery.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <strong>No shots yet</strong>
        <p style="color:var(--muted);margin:8px 0 18px">Upload inspiration to seed your gallery.</p>
        <a class="btn btn-primary" href="#upload">Go to Pose Direct &amp; Upload</a>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.gallery
    .map(
      (item, index) => `
      <article class="gallery-card">
        <img class="thumb" src="${item.dataUrl}" alt="${item.name || "Gallery item " + (index + 1)}" />
        <div class="meta">
          <strong>${item.name || "Inspiration upload"}</strong>
          <span>${item.note || "Saved to your gallery"}</span>
        </div>
      </article>
    `
    )
    .join("");
}

function showPage(path, params = {}) {
  let target = path || "home";

  if (requireAuth(target) && !state.user) {
    toast("Sign up or log in first");
    target = "login";
    history.replaceState(null, "", "#login");
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
    setAuthMode(params.mode || state.authMode || "login");
  }
  if (target === "upload") renderUpload();
  if (target === "gallery") renderGallery();

  const hints = {
    home: "Home is the entry. Use Sign up or Login to continue.",
    login: "After auth you land on Pose Direct & Upload.",
    upload: "Upload a photo, then choose locations or skip to gallery.",
    location: "Review matches / FaceTime, then continue to My Gallery.",
    gallery: "User-linked gallery. Start another upload anytime.",
  };
  flowHint.innerHTML = `<strong>${target}</strong>${hints[target] || ""}`;
}

function route() {
  const { path, params } = parseRoute();
  showPage(path, params);
}

function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = form.name.value.trim() || email.split("@")[0];

  if (!email || !password) {
    toast("Enter email and password");
    return;
  }

  state.user = {
    email,
    name,
    createdAt: new Date().toISOString(),
  };
  saveState();
  toast(state.authMode === "signup" ? "Account created" : "Logged in");
  location.hash = "#upload";
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

function addUploadToGallery(note) {
  if (!state.uploadedDataUrl) return;
  const exists = state.gallery.some((item) => item.dataUrl === state.uploadedDataUrl);
  if (exists) return;
  state.gallery.unshift({
    dataUrl: state.uploadedDataUrl,
    name: state.uploadedName || "Inspiration upload",
    note,
    at: new Date().toISOString(),
  });
  saveState();
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

document.getElementById("continueUpload").addEventListener("click", () => {
  if (!state.uploadedDataUrl) return;
  addUploadToGallery(
    state.wantLocations ? "Uploaded · location matching requested" : "Uploaded · locations skipped"
  );
  if (state.wantLocations) {
    location.hash = "#location";
  } else {
    toast("Skipped location matching");
    location.hash = "#gallery";
  }
});

document.getElementById("skipToGallery").addEventListener("click", () => {
  if (state.uploadedDataUrl) {
    addUploadToGallery("Uploaded · jumped to gallery");
  }
  location.hash = "#gallery";
});

document.getElementById("facetimeBtn").addEventListener("click", () => {
  toast("FaceTime launch is mocked in this prototype");
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

window.addEventListener("hashchange", route);
route();
