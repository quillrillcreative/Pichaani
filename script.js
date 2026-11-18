"use strict";
/* Pichani front end — Supabase auth, private photo storage, albums.
   Security model: every query relies on Row Level Security in the database;
   this file never holds a service-role key. User-supplied text is always escaped
   (escapeHtml) or set with textContent. */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const PHOTO_BUCKET = "pichani-photos";
const FREE_PHOTO_LIMIT = 1500;
const FREE_BYTES_LIMIT = 5 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PAGE_SIZE = 60;            // cards rendered per "Show more" page
const UPLOAD_CONCURRENCY = 3;
const SIGN_TTL = 3600;           // seconds a signed photo URL stays valid
const ZIP_LIMIT_BYTES = 400 * 1024 * 1024; // browser-memory guard for bulk download
const EXT_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", heic: "image/heic", heif: "image/heif", avif: "image/avif",
};
const ALLOWED_TYPES = [...new Set(Object.values(EXT_TYPES))];
const VIEW_TITLES = {
  home: "Home", photos: "All photos", albums: "Albums", album: "Album",
  shared: "Shared with me", favourites: "Favourites", settings: "Settings",
};

let sb = null;
let loadToken = 0;
const signedUrlCache = new Map();
const state = {
  user: null, profile: null, photos: [], albums: [], loading: false,
  view: "home", albumId: null, filter: 0, sort: "newest", albumSort: "updated", query: "",
  selecting: false, selected: new Set(),
  limits: { photos: PAGE_SIZE, favs: PAGE_SIZE, album: PAGE_SIZE },
  list: [], viewerId: null, signingOut: false,
};
let authMode = "signin";

/* ---------------------------------------------------------------- helpers */
function toast(message, ms = 3600) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function humanBytes(n) {
  n = Number(n) || 0;
  if (!n) return "0 MB";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function formatDate(v) {
  const d = new Date(v || Date.now());
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const photoById = id => state.photos.find(p => p.id === id);
const albumById = id => state.albums.find(a => a.id === id);

/* Errors that mean "your login is no longer valid". */
function isAuthError(err) {
  const msg = String(err?.message || "");
  return err?.status === 401 || err?.code === "PGRST301" || /jwt (expired|invalid)|invalid jwt|token.*expired/i.test(msg);
}
async function apiFail(err, prefix) {
  console.error(prefix, err);
  if (isAuthError(err)) { await sessionEnded(); return; }
  const msg = String(err?.message || err || "Something went wrong");
  toast(prefix ? `${prefix}: ${msg}` : msg);
}
async function sessionEnded() {
  if (!state.user) return;
  state.signingOut = true; // so the SIGNED_OUT event below is not treated as a second expiry
  try { await sb.auth.signOut({ scope: "local" }); } catch (_) { /* already invalid */ }
  state.signingOut = false;
  resetUserState();
  setSignedInUI();
  render();
  toast("Your session has expired. Please sign in again.");
  openAuth("signin");
}
function resetUserState() {
  loadToken++;
  state.user = null; state.profile = null; state.photos = []; state.albums = [];
  state.selected.clear(); state.selecting = false; state.albumId = null; state.loading = false;
  signedUrlCache.clear();
  if (state.view === "album") state.view = "albums";
}

/* ----------------------------------------------------------------- dialogs */
$$("dialog").forEach(d => {
  d.addEventListener("click", e => { if (e.target === d) d.close(); });
});
document.addEventListener("click", e => {
  const c = e.target.closest("[data-close]");
  if (c) c.closest("dialog")?.close();
});

/* Promise-based confirmation dialog (replaces window.confirm). */
function confirmDialog({ title, message = "", confirmLabel = "Confirm", danger = false, checkboxLabel = "" }) {
  return new Promise(resolve => {
    const dlg = $("#confirmDialog");
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    const ok = $("#confirmOk");
    ok.textContent = confirmLabel;
    ok.classList.toggle("danger-fill", danger);
    $("#confirmCheckRow").hidden = !checkboxLabel;
    $("#confirmCheckLabel").textContent = checkboxLabel;
    $("#confirmCheck").checked = false;
    const done = () => {
      dlg.removeEventListener("close", done);
      resolve({ ok: dlg.returnValue === "ok", checked: $("#confirmCheck").checked });
    };
    dlg.returnValue = "";
    dlg.addEventListener("close", done);
    dlg.showModal();
    $("#confirmCancel").focus();
  });
}

/* ------------------------------------------------------------------ views */
function showView(name, opts = {}) {
  if (!VIEW_TITLES[name]) name = "home";
  if (state.view !== name && state.selecting) setSelecting(false);
  state.view = name;
  Object.keys(VIEW_TITLES).forEach(v => $("#" + v + "View")?.classList.toggle("active-view", v === name));
  const navName = name === "album" ? "albums" : name;
  $$(".nav-item[data-view]").forEach(b => {
    const on = b.dataset.view === navName;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("#crumbTitle").textContent = name === "album" ? (albumById(state.albumId)?.name || "Album") : VIEW_TITLES[name];
  closeSidebar();
  state.limits = { photos: PAGE_SIZE, favs: PAGE_SIZE, album: PAGE_SIZE };
  render();
  if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: "smooth" });
}
function openSidebar() { $("#sidebar").classList.add("open"); $("#overlay").classList.add("show"); $("#menuButton").setAttribute("aria-expanded", "true"); }
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#overlay").classList.remove("show"); $("#menuButton").setAttribute("aria-expanded", "false"); }
$$("[data-view]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); showView(b.dataset.view); }));
$$("[data-go]").forEach(b => b.addEventListener("click", () => showView(b.dataset.go)));
$("#menuButton").addEventListener("click", openSidebar);
$("#closeSidebar").addEventListener("click", closeSidebar);
$("#overlay").addEventListener("click", closeSidebar);
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#sidebar").classList.contains("open")) closeSidebar(); });

/* ------------------------------------------------------------------- auth */
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup", reset = mode === "reset", recovery = mode === "recovery";
  $("#authTitle").textContent = signup ? "Create your Pichani account" : reset ? "Reset your password" : recovery ? "Choose a new password" : "Welcome to Pichani";
  $("#authDescription").textContent = signup ? "Create a private home for your photos." : reset ? "We’ll email you a secure password-reset link." : recovery ? "Enter a new password for your account." : "Sign in to access your private photo library from anywhere.";
  $("#authSubmit").textContent = signup ? "Create account" : reset ? "Send reset link" : recovery ? "Update password" : "Sign in";
  $("#authModeButton").hidden = reset || recovery;
  $("#authModeButton").textContent = signup ? "I have an account" : "Create account";
  $("#resetPasswordButton").hidden = mode !== "signin";
  $("#authNameLabel").hidden = !signup;
  $("#authName").hidden = !signup;
  $("#authEmail").hidden = recovery;
  $("#authEmail").required = !recovery;
  $('label[for="authEmail"]').hidden = recovery;
  $("#authPassword").hidden = reset;
  $("#authPassword").required = !reset;
  $("#authPassword").autocomplete = (signup || recovery) ? "new-password" : "current-password";
  $("#authMessage").textContent = "";
  $("#authMessage").classList.remove("ok");
}
function openAuth(mode = "signin") {
  setAuthMode(mode);
  if (!$("#authDialog").open) $("#authDialog").showModal();
}
function friendlyAuthError(err) {
  const m = String(err?.message || "");
  if (/invalid login credentials/i.test(m)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the confirmation link.";
  if (/already (registered|exists)/i.test(m)) return "An account with this email already exists. Sign in or reset your password.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Please wait a few minutes and try again.";
  if (/password.*(short|least|weak)|weak password/i.test(m)) return "Please choose a stronger password (at least 8 characters).";
  if (/same password|different from the old/i.test(m)) return "Your new password must be different from the old one.";
  if (/failed to fetch|network/i.test(m)) return "Network problem. Check your connection and try again.";
  return m || "Something went wrong. Please try again.";
}
function authMessage(text, ok = false) {
  const el = $("#authMessage");
  el.textContent = text;
  el.classList.toggle("ok", ok);
}
$("#authButton").addEventListener("click", () => state.user ? signOut() : openAuth());
$("#topAuthButton").addEventListener("click", () => state.user ? showView("settings") : openAuth());
$("#authClose").addEventListener("click", () => $("#authDialog").close());
$("#authDialog").addEventListener("close", () => { $("#authPassword").value = ""; });
$("#authModeButton").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
$("#resetPasswordButton").addEventListener("click", () => setAuthMode("reset"));
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!sb) { toast("The app is not connected to Supabase yet."); return; }
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const name = $("#authName").value.trim();
  const submit = $("#authSubmit");
  submit.disabled = true; submit.classList.add("is-loading"); submit.setAttribute("aria-busy", "true");
  authMessage("Please wait…");
  const back = location.origin + location.pathname;
  try {
    let result;
    if (authMode === "signup") result = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: back } });
    else if (authMode === "reset") result = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
    else if (authMode === "recovery") result = await sb.auth.updateUser({ password });
    else result = await sb.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (authMode === "signup") {
      // With email confirmation on, an already-registered address returns a user with no identities.
      if (result.data?.user && Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
        authMessage("An account with this email already exists. Sign in or reset your password."); return;
      }
      if (!result.data?.session) { authMessage("Check your email to confirm your account, then sign in.", true); return; }
    }
    if (authMode === "reset") { authMessage("If an account exists for that email, a reset link has been sent.", true); return; }
    $("#authDialog").close();
    if (authMode === "recovery") { history.replaceState(null, "", location.pathname); toast("Password updated."); }
    else { toast(authMode === "signup" ? "Account created. Welcome to Pichani!" : "Signed in successfully."); showView("home"); }
  } catch (err) {
    authMessage(friendlyAuthError(err));
  } finally {
    submit.disabled = false; submit.classList.remove("is-loading"); submit.removeAttribute("aria-busy");
  }
});
async function signOut() {
  if (!sb) return;
  state.signingOut = true;
  const { error } = await sb.auth.signOut();
  state.signingOut = false;
  if (error) { toast(error.message); return; }
  resetUserState();
  setSignedInUI();
  showView(state.view === "settings" ? "home" : state.view, { keepScroll: true });
  toast("Signed out.");
}
function displayName() {
  const u = state.user;
  if (!u) return "Not signed in";
  return state.profile?.display_name || u.user_metadata?.display_name || u.email?.split("@")[0] || "My account";
}
function planLabel() {
  const code = state.profile?.plan_code;
  return !code || /^free$/i.test(code) ? "Free plan" : `${String(code).charAt(0).toUpperCase()}${String(code).slice(1)} plan`;
}
function setSignedInUI() {
  const name = displayName();
  const initial = state.user ? name.charAt(0).toUpperCase() : "?";
  $("#profileName").textContent = name;
  $("#profileAvatar").textContent = initial;
  $("#topAuthButton").textContent = initial;
  $("#profilePlan").textContent = state.user ? planLabel() : "Sign in to sync";
  $("#authButton").textContent = state.user ? "Sign out" : "Sign in";
  $("#settingsAvatar").textContent = initial;
  $("#settingsName").textContent = name;
  $("#settingsEmail").textContent = state.user ? (state.user.email || "") : "Sign in to view your account";
}

/* -------------------------------------------------------- signed photo URLs */
function cachedUrl(path) {
  const e = signedUrlCache.get(path);
  return e && e.exp > Date.now() + 60000 ? e.url : null;
}
async function signUrls(paths) {
  const need = [...new Set(paths)].filter(p => !cachedUrl(p));
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(need.slice(i, i + 100), SIGN_TTL);
    if (error) throw error;
    for (const d of data || []) {
      if (d.signedUrl && !d.error) signedUrlCache.set(d.path, { url: d.signedUrl, exp: Date.now() + SIGN_TTL * 1000 });
    }
  }
}
/* A signed URL that expired while the page was open: re-sign once and retry. */
document.addEventListener("error", async e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.path) return;
  if (img.dataset.retried) { img.classList.add("img-broken"); return; }
  img.dataset.retried = "1";
  signedUrlCache.delete(img.dataset.path);
  try { await signUrls([img.dataset.path]); const u = cachedUrl(img.dataset.path); if (u) { img.src = u; return; } } catch (_) { /* fall through */ }
  img.classList.add("img-broken");
}, true);

/* ----------------------------------------------------------- data loading */
async function fetchAllPhotos() {
  const cols = "id,user_id,album_id,object_path,original_filename,mime_type,size_bytes,is_favourite,captured_at,created_at";
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("photos").select(cols).order("created_at", { ascending: false }).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function loadLibrary(quiet = false) {
  const token = ++loadToken;
  if (!state.user) { state.photos = []; state.albums = []; render(); return; }
  if (!quiet) { state.loading = true; render(); }
  try {
    const [photos, albums, usage, profile] = await Promise.all([
      fetchAllPhotos(),
      sb.from("albums").select("id,name,description,created_at,updated_at").order("created_at", { ascending: false }),
      sb.from("storage_usage").select("photo_count,bytes_used").eq("user_id", state.user.id).maybeSingle(),
      sb.from("profiles").select("*").eq("id", state.user.id).maybeSingle(),
    ]);
    if (token !== loadToken) return;
    if (albums.error) throw albums.error;
    state.photos = photos;
    state.albums = albums.data || [];
    state.usage = usage.data || null;
    if (!profile.error) state.profile = profile.data || null;
    for (const id of [...state.selected]) if (!photoById(id)) state.selected.delete(id);
    if (state.albumId && !albumById(state.albumId)) { state.albumId = null; if (state.view === "album") state.view = "albums"; }
    state.loading = false;
    setSignedInUI();
    render();
  } catch (err) {
    if (token !== loadToken) return;
    state.loading = false;
    render();
    apiFail(err, "Could not load your library");
  }
}

/* ------------------------------------------------------- filtering/sorting */
function sortRows(rows) {
  const by = {
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    oldest: (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
    taken: (a, b) => String(b.captured_at || b.created_at).localeCompare(String(a.captured_at || a.created_at)),
    name: (a, b) => String(a.original_filename || "").localeCompare(String(b.original_filename || ""), undefined, { numeric: true, sensitivity: "base" }),
    size: (a, b) => (Number(b.size_bytes) || 0) - (Number(a.size_bytes) || 0),
  }[state.sort] || (() => 0);
  return rows.slice().sort((a, b) => by(a, b) || String(a.id).localeCompare(String(b.id)));
}
function listPhotos({ albumId = null, favs = false, chips = false } = {}) {
  let rows = state.photos;
  if (albumId) rows = rows.filter(p => p.album_id === albumId);
  if (favs || (chips && state.filter === 1)) rows = rows.filter(p => p.is_favourite);
  if (state.query) rows = rows.filter(p => (p.original_filename || "").toLowerCase().includes(state.query));
  if (chips && state.filter === 2) rows = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20);
  return sortRows(rows);
}

/* --------------------------------------------------------------- rendering */
function cardMarkup(row) {
  const url = cachedUrl(row.object_path);
  const title = escapeHtml(row.original_filename || "Photo");
  const sel = state.selected.has(row.id);
  const fav = !!row.is_favourite;
  const img = url
    ? `<img src="${escapeHtml(url)}" data-path="${escapeHtml(row.object_path)}" alt="" loading="lazy" decoding="async">`
    : `<span class="img-missing" aria-hidden="true">▧</span>`;
  return `<div class="photo-card${sel ? " selected" : ""}" data-photo-id="${escapeHtml(row.id)}">`
    + `<button type="button" class="photo-open" aria-label="${state.selecting ? "Select" : "Open"} ${title}"${state.selecting ? ` aria-pressed="${sel}"` : ""}>${img}`
    + `<span class="photo-meta"><strong>${title}</strong><small>${escapeHtml(formatDate(row.captured_at || row.created_at))} · ${humanBytes(row.size_bytes)}</small></span></button>`
    + `<button type="button" class="heart${fav ? " liked" : ""}" aria-label="${fav ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${fav}">${fav ? "♥" : "♡"}</button>`
    + `<span class="select-box" aria-hidden="true">✓</span></div>`;
}
const skeletons = n => Array.from({ length: n }, () => '<div class="photo-card skeleton" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div></div>').join("");
const signInPrompt = (title, text) => `<div class="empty-state"><h2>${title}</h2><p>${text}</p><button class="primary-button" data-action="signin">Sign in to continue</button></div>`;

/* Sign only the visible page of photos, then paint it. Stale paints are dropped. */
async function fillGrid(container, rows, limitKey, emptyHtml) {
  const token = (container._paint = (container._paint || 0) + 1);
  if (state.loading && !rows.length) { container.innerHTML = skeletons(8); return; }
  if (!rows.length) { container.innerHTML = emptyHtml; return; }
  const slice = rows.slice(0, state.limits[limitKey] || PAGE_SIZE);
  try { await signUrls(slice.map(r => r.object_path)); } catch (err) { if (isAuthError(err)) { await sessionEnded(); return; } console.warn("Could not sign photo URLs", err); }
  if (token !== container._paint) return;
  const more = rows.length - slice.length;
  container.innerHTML = slice.map(cardMarkup).join("")
    + (more > 0 ? `<div class="load-more"><button type="button" class="secondary-button" data-more="${limitKey}">Show more (${more} left)</button></div>` : "");
}

function render() {
  updateStats();
  switch (state.view) {
    case "home": renderHome(); break;
    case "photos": renderPhotosView(); break;
    case "favourites": renderFavourites(); break;
    case "albums": renderAlbumList(); break;
    case "album": renderAlbumDetail(); break;
    case "settings": renderSettings(); break;
  }
  updateSelectionBar();
}
function renderHome() {
  const grid = $("#photoGrid");
  if (!state.user) { grid.innerHTML = signInPrompt("Your memories will appear here", "Sign in to see photos you have uploaded."); return; }
  const recent = state.photos.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 4);
  state.list = recent;
  fillGrid(grid, recent, "photos", '<div class="empty-state"><p>Your recently uploaded photos will appear here.</p></div>');
}
function renderPhotosView() {
  const grid = $("#allPhotosGrid");
  $$(".filter-chip").forEach(c => c.classList.toggle("selected", Number(c.dataset.filter) === state.filter));
  if (!state.user) {
    $("#resultLabel").textContent = "Sign in to see your saved photos";
    state.list = [];
    grid.innerHTML = signInPrompt("Your photos belong here", "Sign in or create an account to upload and sync your private memories.");
    return;
  }
  const rows = listPhotos({ chips: true });
  state.list = rows;
  $("#resultLabel").textContent = state.loading ? "Loading…" : !state.photos.length ? "No photos yet"
    : (state.query || state.filter) ? `${rows.length} of ${plural(state.photos.length, "photo")}` : plural(rows.length, "saved photo");
  const empty = !state.photos.length
    ? '<div class="empty-state"><div class="empty-art" aria-hidden="true">▧</div><h2>Your library starts here</h2><p>Upload your first photo. It will be stored privately in your Pichani account.</p><button class="primary-button" data-action="upload">Upload photos</button></div>'
    : '<div class="empty-state"><h2>No photos match</h2><p>Try a different search or filter.</p></div>';
  fillGrid(grid, rows, "photos", empty);
}
function renderFavourites() {
  const grid = $("#favouritesGrid"), empty = $("#favouritesEmpty");
  if (!state.user) { state.list = []; empty.hidden = true; grid.innerHTML = signInPrompt("Your favourites", "Sign in to see the photos you have favourited."); return; }
  const rows = listPhotos({ favs: true });
  state.list = rows;
  empty.hidden = rows.length > 0 || state.loading;
  fillGrid(grid, rows, "favs", "");
}
function coverRow(albumId) {
  return state.photos.filter(p => p.album_id === albumId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}
async function renderAlbumList() {
  const grid = $("#albumGrid");
  const token = (grid._paint = (grid._paint || 0) + 1);
  if (!state.user) { grid.innerHTML = signInPrompt("Your albums, all together", "Sign in to create and organise your photo albums."); return; }
  if (state.loading && !state.albums.length) { grid.innerHTML = skeletons(4); return; }
  if (!state.albums.length) { grid.innerHTML = '<div class="empty-state"><div class="empty-art" aria-hidden="true">▤</div><h2>Create your first album</h2><p>Organise your memories into collections you can find later.</p><button class="primary-button" data-action="new-album">New album</button></div>'; return; }
  const covers = new Map(state.albums.map(a => [a.id, coverRow(a.id)]));
  try { await signUrls([...covers.values()].filter(Boolean).map(r => r.object_path)); } catch (err) { console.warn("Could not sign album covers", err); }
  if (token !== grid._paint) return;
  const albums = sortedAlbums();
  grid.innerHTML = albums.map(a => {
    const count = state.photos.filter(p => p.album_id === a.id).length;
    const cover = covers.get(a.id);
    const url = cover && cachedUrl(cover.object_path);
    const art = url ? `<img src="${escapeHtml(url)}" data-path="${escapeHtml(cover.object_path)}" alt="" loading="lazy" decoding="async">` : '<span class="album-cover-empty" aria-hidden="true">▤</span>';
    return `<button type="button" class="album-card" data-album-id="${escapeHtml(a.id)}"><span class="album-cover">${art}</span>`
      + `<span class="album-details"><strong>${escapeHtml(a.name)}</strong><small>${plural(count, "photo")} · Updated ${escapeHtml(formatDate(a.updated_at || a.created_at))}</small></span><span class="album-arrow" aria-hidden="true">↗</span></button>`;
  }).join("");
  const inAlbums = state.photos.filter(p => p.album_id).length;
  $("#albumSummary").textContent = `${plural(albums.length, "album")} · ${plural(inAlbums, "photo")} in albums`;
}
function sortedAlbums() {
  const count = id => state.photos.filter(p => p.album_id === id).length;
  const rows = [...state.albums];
  if (state.albumSort === "name") return rows.sort((a, b) => a.name.localeCompare(b.name));
  if (state.albumSort === "count") return rows.sort((a, b) => count(b.id) - count(a.id) || a.name.localeCompare(b.name));
  return rows.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
}
function renderAlbumDetail() {
  const album = albumById(state.albumId);
  if (!album) { if (state.user) showView("albums"); return; }
  $("#albumTitle").textContent = album.name;
  $("#albumDesc").textContent = album.description || "";
  $("#albumDesc").hidden = !album.description;
  $("#crumbTitle").textContent = album.name;
  const rows = listPhotos({ albumId: album.id });
  state.list = rows;
  const total = state.photos.filter(p => p.album_id === album.id).length;
  $("#albumMeta").textContent = `${plural(total, "photo")} · Created ${formatDate(album.created_at)}`;
  const empty = total
    ? '<div class="empty-state"><h2>No photos match</h2><p>Try a different search.</p></div>'
    : '<div class="empty-state"><div class="empty-art" aria-hidden="true">▤</div><h2>This album is empty</h2><p>Upload photos here, or open All photos, tick Select and choose Move to add existing ones.</p><button class="primary-button" data-action="upload">Upload here</button></div>';
  fillGrid($("#albumPhotoGrid"), rows, "album", empty);
}
function renderSettings() {
  setSignedInUI();
  const { count, bytes } = usageNumbers();
  $("#settingsStorage").textContent = state.user
    ? `${planLabel()} · ${humanBytes(bytes)} of 5 GB used · ${count.toLocaleString()} of ${FREE_PHOTO_LIMIT.toLocaleString()} photos`
    : "You're on the Free plan with up to 5 GB or 1,500 photos.";
  const pct = Math.min(100, Math.round(bytes / FREE_BYTES_LIMIT * 100));
  $("#settingsBar").style.width = pct + "%";
  $("#settingsBar").parentElement.setAttribute("aria-valuenow", String(pct));
  const since = $("#settingsSince");
  since.hidden = !state.user?.created_at;
  since.textContent = state.user?.created_at ? `Member since ${formatDate(state.user.created_at)}` : "";
}
function fillPlanUsage() {
  const { count, bytes } = usageNumbers();
  const pb = Math.min(100, Math.round(bytes / FREE_BYTES_LIMIT * 100));
  const pp = Math.min(100, Math.round(count / FREE_PHOTO_LIMIT * 100));
  $("#planStorageText").textContent = `${humanBytes(bytes)} of 5 GB`;
  $("#planStorageBar").style.width = pb + "%";
  $("#planPhotosText").textContent = `${count.toLocaleString()} of ${FREE_PHOTO_LIMIT.toLocaleString()}`;
  $("#planPhotosBar").style.width = pp + "%";
  $("#planStorageBar").parentElement.setAttribute("aria-valuenow", String(pb));
  $("#planPhotosBar").parentElement.setAttribute("aria-valuenow", String(pp));
}
function openPlans() { fillPlanUsage(); $("#plansDialog").showModal(); }
function usageNumbers() {
  const bytes = state.photos.reduce((s, p) => s + (Number(p.size_bytes) || 0), 0);
  return { count: state.photos.length, bytes };
}
function updateStats() {
  const { count, bytes } = usageNumbers();
  const pct = Math.min(100, bytes / FREE_BYTES_LIMIT * 100);
  const p = Math.round(pct);
  $("#photoCount").textContent = count;
  $("#savedCount").textContent = count;
  $("#albumCount").textContent = state.albums.length;
  $("#storageUsed").textContent = humanBytes(bytes);
  $("#storageSide").textContent = humanBytes(bytes);
  $("#storageCaption").textContent = `${p}% of 5 GB · ${count.toLocaleString()} of ${FREE_PHOTO_LIMIT.toLocaleString()} photos`;
  $("#storagePercent").textContent = `${p}%`;
  $("#storageBar").style.width = `${pct}%`;
  $("#storageProgress").setAttribute("aria-valuenow", String(p));
}

/* ----------------------------------------------------------- sort + search */
$$(".sort-select:not(.album-sort)").forEach(sel => sel.addEventListener("change", () => {
  state.sort = sel.value;
  $$(".sort-select:not(.album-sort)").forEach(s => { s.value = state.sort; });
  render();
}));
$(".album-sort").addEventListener("change", e => { state.albumSort = e.target.value; renderAlbumList(); });
$$(".filter-chip").forEach(chip => chip.addEventListener("click", () => { state.filter = Number(chip.dataset.filter) || 0; state.limits.photos = PAGE_SIZE; render(); }));
let searchTimer;
$("#searchInput").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const value = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = value.trim().toLowerCase();
    state.limits = { photos: PAGE_SIZE, favs: PAGE_SIZE, album: PAGE_SIZE };
    if (state.query && !["photos", "album", "favourites"].includes(state.view)) showView("photos", { keepScroll: true });
    else render();
  }, 150);
});

/* --------------------------------------------------------------- selection */
function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle("selecting", on);
  $$(".select-toggle").forEach(b => { b.textContent = on ? "Done" : "Select"; b.setAttribute("aria-pressed", String(on)); });
  render();
}
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  $$(`.photo-card[data-photo-id="${CSS.escape(id)}"]`).forEach(c => {
    c.classList.toggle("selected", state.selected.has(id));
    c.querySelector(".photo-open")?.setAttribute("aria-pressed", String(state.selected.has(id)));
  });
  updateSelectionBar();
}
function updateSelectionBar() {
  const bar = $("#selectionBar");
  bar.hidden = !state.selecting;
  document.body.classList.toggle("has-bar", state.selecting);
  $("#selCount").textContent = `${state.selected.size} selected`;
  $$("[data-action^='bulk-']", bar).forEach(b => { b.disabled = state.selected.size === 0; });
}
const selectedRows = () => [...state.selected].map(photoById).filter(Boolean);

/* ----------------------------------------------------------------- uploads */
const uploads = [];
let uploadSeq = 0, uploadRunning = 0, uploadDirty = false;
function openUpload() {
  if (!state.user) { openAuth(); toast("Sign in before uploading photos."); return; }
  $("#fileInput").click();
}
$("#uploadButton").addEventListener("click", openUpload);
$$("[data-upload]").forEach(b => b.addEventListener("click", openUpload));
$("#fileInput").addEventListener("change", e => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  if (!state.user) { openAuth(); return; }
  enqueueFiles(files, state.view === "album" ? state.albumId : null);
});
function enqueueFiles(files, albumId) {
  // A new selection starts a fresh batch once nothing is still running.
  if (!uploads.some(u => u.status === "queued" || u.status === "uploading")) uploads.length = 0;
  for (const file of files) {
    const ext = (file.name.split(".").pop() || "img").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "img";
    const type = file.type || EXT_TYPES[ext] || "";
    const item = { id: ++uploadSeq, file, name: file.name, ext, type, size: file.size, albumId, status: "queued", error: "" };
    if (!ALLOWED_TYPES.includes(type)) { item.status = "error"; item.error = "This image format is not supported."; }
    else if (file.size > MAX_FILE_BYTES) { item.status = "error"; item.error = "Maximum file size is 50 MB."; }
    uploads.push(item);
  }
  renderUploads();
  pumpUploads();
}
function uploadErrorText(err) {
  const raw = String(err?.message || err || "Upload failed");
  if (/exceeded|maximum allowed size|too large/i.test(raw)) return "File is larger than the 50 MB limit.";
  if (/mime|not supported|invalid.*type/i.test(raw)) return "This image format is not supported.";
  return raw;
}
async function runUpload(item) {
  item.status = "uploading"; item.error = "";
  renderUploads();
  let path = null;
  try {
    const used = usageNumbers();
    const inflight = uploads.filter(u => u.status === "uploading" && u !== item);
    if (used.count + inflight.length + 1 > FREE_PHOTO_LIMIT) throw new Error("Your free plan allows up to 1,500 photos.");
    if (used.bytes + inflight.reduce((s, u) => s + u.size, 0) + item.size > FREE_BYTES_LIMIT) throw new Error("This upload would exceed your free 5 GB storage limit.");
    path = `${state.user.id}/${crypto.randomUUID()}.${item.ext}`;
    const up = await sb.storage.from(PHOTO_BUCKET).upload(path, item.file, { contentType: item.type, upsert: false });
    if (up.error) throw up.error;
    const payload = {
      user_id: state.user.id, object_path: path, original_filename: item.name, mime_type: item.type,
      size_bytes: item.size, captured_at: new Date(item.file.lastModified || Date.now()).toISOString(),
    };
    if (item.albumId) payload.album_id = item.albumId;
    const ins = await sb.from("photos").insert(payload).select().single();
    if (ins.error) throw ins.error;
    state.photos.unshift(ins.data);
    item.status = "done"; uploadDirty = true;
  } catch (err) {
    if (isAuthError(err)) { item.status = "error"; item.error = "Session expired."; await sessionEnded(); }
    else { item.status = "error"; item.error = uploadErrorText(err); }
    if (path) { try { await sb.storage.from(PHOTO_BUCKET).remove([path]); } catch (_) { /* orphan cleanup is best-effort */ } }
  }
}
function pumpUploads() {
  while (uploadRunning < UPLOAD_CONCURRENCY) {
    const next = uploads.find(u => u.status === "queued");
    if (!next) break;
    uploadRunning++;
    runUpload(next).finally(() => { uploadRunning--; renderUploads(); pumpUploads(); });
  }
  if (!uploadRunning && !uploads.some(u => u.status === "queued") && uploadDirty) {
    uploadDirty = false;
    const done = uploads.filter(u => u.status === "done").length;
    const failed = uploads.filter(u => u.status === "error").length;
    loadLibrary(true).then(() => toast(`${plural(done, "photo")} uploaded${failed ? `, ${failed} failed` : ""}.`));
  }
}
function renderUploads() {
  const panel = $("#uploadPanel");
  panel.hidden = uploads.length === 0;
  if (!uploads.length) return;
  const total = uploads.length;
  const done = uploads.filter(u => u.status === "done").length;
  const failed = uploads.filter(u => u.status === "error").length;
  const active = uploads.some(u => u.status === "queued" || u.status === "uploading");
  const pct = Math.round((done + failed) / total * 100);
  $("#uploadTitle").textContent = active ? `Uploading ${done + failed + 1 > total ? total : done + failed + 1} of ${total}…` : failed ? `${done} uploaded, ${failed} failed` : `${plural(done, "photo")} uploaded`;
  $("#uploadBar").style.width = `${pct}%`;
  $("#uploadProgress").setAttribute("aria-valuenow", String(pct));
  $("#uploadDismiss").hidden = active;
  $("#uploadRetry").hidden = active || !uploads.some(u => u.status === "error" && u.file && ALLOWED_TYPES.includes(u.type) && u.size <= MAX_FILE_BYTES);
  const label = { queued: "Waiting", uploading: "Uploading…", done: "Uploaded", error: "Failed" };
  $("#uploadList").innerHTML = uploads.slice(-50).map(u =>
    `<li class="upload-item ${u.status}"><span class="up-name">${escapeHtml(u.name)}</span><span class="up-state">${escapeHtml(u.status === "error" && u.error ? u.error : label[u.status])}</span></li>`).join("");
}
function retryFailed() {
  uploads.filter(u => u.status === "error" && ALLOWED_TYPES.includes(u.type) && u.size <= MAX_FILE_BYTES).forEach(u => { u.status = "queued"; u.error = ""; });
  renderUploads();
  pumpUploads();
}
function dismissUploads() { uploads.length = 0; renderUploads(); }

/* ------------------------------------------------------------ photo actions */
async function setFavourite(ids, value) {
  const { data, error } = await sb.from("photos").update({ is_favourite: value }).in("id", ids).select("id");
  if (error) { apiFail(error, "Could not update favourites"); return false; }
  if ((data || []).length !== ids.length) { toast("Some photos could not be updated."); }
  const ok = new Set((data || []).map(r => r.id));
  state.photos.forEach(p => { if (ok.has(p.id)) p.is_favourite = value; });
  return true;
}
async function toggleFavourite(row) {
  const next = !row.is_favourite;
  if (await setFavourite([row.id], next)) {
    render();
    if (state.viewerId === row.id) syncViewer();
    toast(next ? "Added to favourites" : "Removed from favourites");
  }
}
/* Storage file first, then the database row. If the row delete fails, the user
   can simply retry (removing a missing file is a no-op); a half-finished delete
   never leaves a file that still counts against the quota without a record. */
async function removePhotos(rows) {
  if (!rows.length) return true;
  const rm = await sb.storage.from(PHOTO_BUCKET).remove(rows.map(r => r.object_path));
  if (rm.error) { apiFail(rm.error, "Could not delete files"); return false; }
  const ids = rows.map(r => r.id);
  const del = await sb.from("photos").delete().in("id", ids).select("id");
  if (del.error) { apiFail(del.error, "Could not delete photo records"); return false; }
  const gone = new Set((del.data || []).map(r => r.id));
  if (gone.size !== ids.length) toast("Some photos could not be deleted (permission denied).");
  rows.forEach(r => { if (gone.has(r.id)) { signedUrlCache.delete(r.object_path); state.selected.delete(r.id); } });
  state.photos = state.photos.filter(p => !gone.has(p.id));
  return gone.size > 0;
}
async function deletePhotos(rows) {
  if (!rows.length) return;
  const res = await confirmDialog({
    title: rows.length === 1 ? "Delete this photo?" : `Delete ${rows.length} photos?`,
    message: "They will be permanently removed from your library. This can’t be undone.",
    confirmLabel: "Delete", danger: true,
  });
  if (!res.ok) return;
  const ok = await removePhotos(rows);
  if ($("#photoDialog").open) $("#photoDialog").close();
  if (state.selecting) setSelecting(false); else render();
  if (ok) { toast(rows.length === 1 ? "Photo deleted." : `${plural(rows.length, "photo")} deleted.`); loadLibrary(true); }
}
async function downloadOne(row) {
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(row.object_path, 120, { download: row.original_filename || true });
  if (error) { apiFail(error, "Could not download"); return; }
  const a = document.createElement("a");
  a.href = data.signedUrl; a.rel = "noopener";
  document.body.append(a); a.click(); a.remove();
}

/* Minimal ZIP writer (store, no compression: photos are already compressed). */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true); cen.setUint16(30, 0, true); cen.setUint16(32, 0, true);
    cen.setUint16(34, 0, true); cen.setUint16(36, 0, true); cen.setUint32(38, 0, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function downloadMany(rows) {
  if (!rows.length) return;
  if (rows.length === 1) { await downloadOne(rows[0]); return; }
  const total = rows.reduce((s, r) => s + (Number(r.size_bytes) || 0), 0);
  if (total > ZIP_LIMIT_BYTES) { toast(`That is ${humanBytes(total)}. Please download up to ${humanBytes(ZIP_LIMIT_BYTES)} at a time.`, 6000); return; }
  const files = [], used = new Set();
  try {
    for (let i = 0; i < rows.length; i++) {
      toast(`Preparing download… ${i + 1} of ${rows.length}`, 60000);
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(rows[i].object_path);
      if (error) throw error;
      let name = (rows[i].original_filename || `photo-${i + 1}`).replace(/[\\/:*?"<>|]/g, "_");
      if (used.has(name.toLowerCase())) { const dot = name.lastIndexOf("."); const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ""; let n = 2; while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++; name = `${base} (${n})${ext}`; }
      used.add(name.toLowerCase());
      files.push({ name, data: new Uint8Array(await data.arrayBuffer()) });
    }
    saveBlob(buildZip(files), `pichani-photos-${new Date().toISOString().slice(0, 10)}.zip`);
    toast(`Downloaded ${plural(files.length, "photo")} as a zip.`);
  } catch (err) { apiFail(err, "Could not prepare the download"); }
}

/* ------------------------------------------------------------------ albums */
let albumEditId = null;
function openAlbumDialog(album = null) {
  if (!state.user) { openAuth(); toast("Sign in to create albums."); return; }
  albumEditId = album?.id || null;
  $("#albumDialogEyebrow").textContent = album ? "EDIT ALBUM" : "MAKE A COLLECTION";
  $("#albumDialogTitle").textContent = album ? "Edit album" : "Create an album";
  $("#saveAlbum").textContent = album ? "Save changes" : "Create album";
  $("#albumName").value = album?.name || "";
  $("#albumDescription").value = album?.description || "";
  $("#albumMessage").textContent = "";
  $("#albumDialog").showModal();
  $("#albumName").focus();
}
$("#createAlbum").addEventListener("click", () => openAlbumDialog());
$("#albumEdit").addEventListener("click", () => { const a = albumById(state.albumId); if (a) openAlbumDialog(a); });
$("#albumDelete").addEventListener("click", () => { const a = albumById(state.albumId); if (a) deleteAlbum(a); });
$("#albumForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#albumName").value.trim();
  const description = $("#albumDescription").value.trim();
  if (!name) { $("#albumMessage").textContent = "Enter an album name first."; return; }
  if (!state.user) { $("#albumDialog").close(); openAuth(); return; }
  const btn = $("#saveAlbum");
  btn.disabled = true; btn.classList.add("is-loading");
  try {
    if (albumEditId) {
      const { data, error } = await sb.from("albums").update({ name, description: description || null }).eq("id", albumEditId).select().single();
      if (error) throw error;
      Object.assign(albumById(albumEditId), data);
      toast("Album updated.");
    } else {
      const { data, error } = await sb.from("albums").insert({ user_id: state.user.id, name, description: description || null }).select().single();
      if (error) throw error;
      state.albums.unshift(data);
      toast(`Album “${name}” created.`);
    }
    $("#albumDialog").close();
    if (state.view === "album") $("#crumbTitle").textContent = name;
    render();
  } catch (err) {
    if (isAuthError(err)) { $("#albumDialog").close(); await sessionEnded(); }
    else $("#albumMessage").textContent = `Could not save album: ${err.message || err}`;
  } finally { btn.disabled = false; btn.classList.remove("is-loading"); }
});
async function deleteAlbum(album) {
  const rows = state.photos.filter(p => p.album_id === album.id);
  const n = rows.length;
  const res = await confirmDialog({
    title: `Delete “${album.name}”?`,
    message: n ? `This album has ${plural(n, "photo")}. They stay in your library unless you tick the box below.` : "This album is empty.",
    confirmLabel: "Delete album", danger: true,
    checkboxLabel: n ? `Also permanently delete its ${plural(n, "photo")}` : "",
  });
  if (!res.ok) return;
  if (res.checked) {
    if (!(await removePhotos(rows))) return;
  } else if (n) {
    // Detach first so deleting the album can never cascade away photo records and orphan their files.
    const { error } = await sb.from("photos").update({ album_id: null }).eq("album_id", album.id);
    if (error) { apiFail(error, "Could not detach photos"); return; }
    rows.forEach(p => { p.album_id = null; });
  }
  const { data, error } = await sb.from("albums").delete().eq("id", album.id).select("id");
  if (error) { apiFail(error, "Could not delete album"); return; }
  if (!(data || []).length) { toast("Could not delete this album (permission denied)."); return; }
  state.albums = state.albums.filter(a => a.id !== album.id);
  state.albumId = null;
  toast(`Album “${album.name}” deleted.`);
  showView("albums");
  loadLibrary(true);
}
function openAlbum(id) { state.albumId = id; showView("album"); }

/* Move dialog (single photo, bulk selection) */
let moveIds = [];
function openMoveDialog(ids) {
  if (!ids.length) return;
  moveIds = ids;
  const sel = $("#moveTarget");
  const current = new Set(ids.map(id => photoById(id)?.album_id || ""));
  sel.innerHTML = '<option value="">No album (All photos only)</option>'
    + state.albums.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("")
    + '<option value="__new">＋ New album…</option>';
  sel.value = current.size === 1 ? [...current][0] : "";
  $("#moveTitle").textContent = ids.length === 1 ? "Move photo to album" : `Move ${ids.length} photos to album`;
  $("#moveNewWrap").hidden = true;
  $("#moveNewName").value = "";
  $("#moveMessage").textContent = "";
  $("#moveDialog").showModal();
}
$("#moveTarget").addEventListener("change", e => { $("#moveNewWrap").hidden = e.target.value !== "__new"; if (e.target.value === "__new") $("#moveNewName").focus(); });
$("#moveForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#moveSave");
  btn.disabled = true; btn.classList.add("is-loading");
  try {
    let target = $("#moveTarget").value || null;
    if (target === "__new") {
      const name = $("#moveNewName").value.trim();
      if (!name) { $("#moveMessage").textContent = "Enter a name for the new album."; return; }
      const { data, error } = await sb.from("albums").insert({ user_id: state.user.id, name }).select().single();
      if (error) throw error;
      state.albums.unshift(data);
      target = data.id;
    }
    const { data, error } = await sb.from("photos").update({ album_id: target }).in("id", moveIds).select("id");
    if (error) throw error;
    const ok = new Set((data || []).map(r => r.id));
    state.photos.forEach(p => { if (ok.has(p.id)) p.album_id = target; });
    $("#moveDialog").close();
    if (ok.size !== moveIds.length) toast("Some photos could not be moved.");
    else toast(target ? `Moved ${plural(ok.size, "photo")} to “${albumById(target)?.name}”.` : `Removed ${plural(ok.size, "photo")} from their album.`);
    if (state.selecting) setSelecting(false); else render();
    if (state.viewerId) syncViewer();
  } catch (err) {
    if (isAuthError(err)) { $("#moveDialog").close(); await sessionEnded(); }
    else $("#moveMessage").textContent = `Could not move: ${err.message || err}`;
  } finally { btn.disabled = false; btn.classList.remove("is-loading"); }
});

/* ------------------------------------------------------------------ viewer */
const photoDialog = $("#photoDialog");
let viewerToken = 0;
function viewerIndex() { return state.list.findIndex(p => p.id === state.viewerId); }
function syncViewer() {
  const row = photoById(state.viewerId);
  if (!row) return;
  $("#viewerFav").textContent = row.is_favourite ? "♥ Favourited" : "♡ Favourite";
  $("#viewerFav").setAttribute("aria-pressed", String(!!row.is_favourite));
  const album = row.album_id ? albumById(row.album_id)?.name : null;
  $("#viewerTitle").textContent = row.original_filename || "Photo";
  $("#viewerMeta").textContent = [`Taken ${formatDate(row.captured_at || row.created_at)}`, humanBytes(row.size_bytes), (row.mime_type || "").replace("image/", "").toUpperCase(), album ? `Album: ${album}` : ""].filter(Boolean).join(" · ");
  const i = viewerIndex();
  $("#viewerPrev").hidden = i <= 0;
  $("#viewerNext").hidden = i < 0 || i >= state.list.length - 1;
}
async function openViewer(id) {
  const row = photoById(id);
  if (!row) return;
  const token = ++viewerToken;
  try { await signUrls([row.object_path]); } catch (err) { apiFail(err, "Could not open photo"); return; }
  if (token !== viewerToken) return;
  const url = cachedUrl(row.object_path);
  if (!url) { toast("Could not load this photo."); return; }
  state.viewerId = id;
  const img = $("#viewerImg");
  img.dataset.path = row.object_path; delete img.dataset.retried; img.classList.remove("img-broken");
  img.src = url;
  img.alt = row.original_filename || "Photo";
  syncViewer();
  if (!photoDialog.open) photoDialog.showModal();
}
function stepViewer(delta) {
  const next = state.list[viewerIndex() + delta];
  if (next) openViewer(next.id);
}
$("#viewerClose").addEventListener("click", () => photoDialog.close());
photoDialog.addEventListener("close", () => { $("#viewerImg").removeAttribute("src"); state.viewerId = null; viewerToken++; });
photoDialog.addEventListener("keydown", e => {
  if (e.key === "ArrowLeft") { stepViewer(-1); e.preventDefault(); }
  if (e.key === "ArrowRight") { stepViewer(1); e.preventDefault(); }
});
$("#viewerPrev").addEventListener("click", () => stepViewer(-1));
$("#viewerNext").addEventListener("click", () => stepViewer(1));
$("#viewerFav").addEventListener("click", () => { const r = photoById(state.viewerId); if (r) toggleFavourite(r); });
$("#viewerMove").addEventListener("click", () => { if (state.viewerId) openMoveDialog([state.viewerId]); });
$("#viewerDownload").addEventListener("click", () => { const r = photoById(state.viewerId); if (r) downloadOne(r); });
$("#viewerDelete").addEventListener("click", () => { const r = photoById(state.viewerId); if (r) deletePhotos([r]); });

/* ----------------------------------------------------- delegated UI actions */
document.addEventListener("click", async e => {
  const actionEl = e.target.closest("[data-action]");
  if (actionEl) {
    const a = actionEl.dataset.action;
    if (a === "signin") openAuth();
    else if (a === "upload") openUpload();
    else if (a === "new-album") openAlbumDialog();
    else if (a === "toggle-select") setSelecting(!state.selecting);
    else if (a === "select-all") { state.list.forEach(r => state.selected.add(r.id)); render(); }
    else if (a === "bulk-fav") { const rows = selectedRows(); const allFav = rows.every(r => r.is_favourite); if (await setFavourite(rows.map(r => r.id), !allFav)) { toast(allFav ? "Removed from favourites" : "Added to favourites"); setSelecting(false); } }
    else if (a === "bulk-move") openMoveDialog([...state.selected]);
    else if (a === "bulk-download") downloadMany(selectedRows());
    else if (a === "bulk-delete") deletePhotos(selectedRows());
    else if (a === "retry-failed") retryFailed();
    else if (a === "dismiss-uploads") dismissUploads();
    return;
  }
  const more = e.target.closest("[data-more]");
  if (more) { state.limits[more.dataset.more] += PAGE_SIZE; render(); return; }
  const albumCard = e.target.closest(".album-card[data-album-id]");
  if (albumCard) { openAlbum(albumCard.dataset.albumId); return; }
  const card = e.target.closest(".photo-card[data-photo-id]");
  if (!card || card.classList.contains("skeleton")) return;
  const row = photoById(card.dataset.photoId);
  if (!row) return;
  if (e.target.closest(".heart")) { e.preventDefault(); await toggleFavourite(row); return; }
  if (state.selecting) toggleSelect(row.id); else openViewer(row.id);
});

/* ---------------------------------------------------------------- settings */
$("#upgradeBtn").addEventListener("click", openPlans);
$("#settingsPlans").addEventListener("click", openPlans);
$("#editProfile").addEventListener("click", () => {
  if (!state.user) { openAuth(); return; }
  $("#profileNameInput").value = displayName();
  $("#profileMessage").textContent = "";
  $("#profileDialog").showModal();
  $("#profileNameInput").focus();
});
$("#profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#profileNameInput").value.trim();
  if (!name) { $("#profileMessage").textContent = "Enter your name."; return; }
  const btn = $("#profileSave");
  btn.disabled = true; btn.classList.add("is-loading");
  try {
    const { data, error } = await sb.auth.updateUser({ data: { display_name: name } });
    if (error) throw error;
    if (data?.user) state.user = data.user;
    // Best effort: keep the profiles row in sync (the column name is not assumed to exist).
    const upd = await sb.from("profiles").update({ display_name: name }).eq("id", state.user.id).select("*").maybeSingle();
    if (upd.error) console.warn("profiles table not updated:", upd.error.message);
    else if (upd.data) state.profile = upd.data;
    $("#profileDialog").close();
    setSignedInUI();
    toast("Profile updated.");
  } catch (err) {
    if (isAuthError(err)) { $("#profileDialog").close(); await sessionEnded(); }
    else $("#profileMessage").textContent = friendlyAuthError(err);
  } finally { btn.disabled = false; btn.classList.remove("is-loading"); }
});
$("#changePassword").addEventListener("click", () => { if (!state.user) openAuth(); else openAuth("recovery"); });
$("#settingsSignOut").addEventListener("click", () => { if (state.user) signOut(); else openAuth(); });
$("#exportData").addEventListener("click", () => {
  if (!state.user) { openAuth(); return; }
  const data = {
    exported_at: new Date().toISOString(), account: { email: state.user.email, name: displayName() },
    albums: state.albums.map(a => ({ id: a.id, name: a.name, description: a.description, created_at: a.created_at })),
    photos: state.photos.map(p => ({ id: p.id, filename: p.original_filename, album: albumById(p.album_id)?.name || null, favourite: !!p.is_favourite, type: p.mime_type, size_bytes: p.size_bytes, captured_at: p.captured_at, uploaded_at: p.created_at })),
  };
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "pichani-export.json");
  toast("Exported your albums and photo list.");
});

/* -------------------------------------------------------------------- init */
function readAuthHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { error: h.get("error_description"), code: h.get("error_code"), type: h.get("type") };
}
async function init() {
  const config = window.PICHANI_SUPABASE_CONFIG;
  setSignedInUI();
  if (!window.supabase || !config?.url || !config?.publishableKey || config.publishableKey.includes("PASTE_")) {
    toast("The app could not connect to Supabase. Please refresh the page.");
    setAuthMode("signin");
    render();
    return;
  }
  const hash = readAuthHash();
  sb = window.supabase.createClient(config.url, config.publishableKey);
  sb.auth.onAuthStateChange((event, session) => {
    const next = session?.user || null;
    const changed = (next?.id || null) !== (state.user?.id || null);
    const hadUser = !!state.user;
    if (event === "PASSWORD_RECOVERY") { state.user = next; setSignedInUI(); setTimeout(() => openAuth("recovery"), 0); return; }
    if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") { if (next) state.user = next; return; }
    if (event === "USER_UPDATED") { if (next) { state.user = next; setSignedInUI(); } return; }
    if (event === "SIGNED_OUT") {
      if (hadUser && !state.signingOut) setTimeout(() => sessionEnded(), 0); // expired or revoked elsewhere
      return;
    }
    state.user = next;
    setSignedInUI();
    if (changed) setTimeout(() => loadLibrary(), 0);
  });
  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;
  setSignedInUI();
  await loadLibrary();
  if (hash.error) {
    history.replaceState(null, "", location.pathname);
    toast(/expired|invalid/i.test(hash.error) ? "That email link has expired. Please request a new one." : hash.error.replace(/\+/g, " "), 6000);
    if (!state.user) openAuth("signin");
  } else if (hash.type === "signup" && state.user) {
    history.replaceState(null, "", location.pathname);
    toast("Email confirmed. Welcome to Pichani!");
  }
}
init();
