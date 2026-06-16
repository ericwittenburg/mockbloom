# MockBloom Backend

Express + Supabase backend for MockBloom. Handles auth, per-user image storage, and persistent shirt/mockup data so multiple devices (and multiple users) can share one source of truth.

- **Auth:** Supabase Auth (email + password)
- **Database:** Supabase Postgres with Row Level Security
- **File storage:** Supabase Storage (private buckets, signed URLs)
- **Server:** Node.js + Express, deploys cleanly to Render's free tier

---

## 1. Supabase Project Setup

### 1.1 Create the project

1. Go to <https://supabase.com> and sign in.
2. Click **New project**. Pick any name (e.g. `mockbloom`), region (closest to you), and set a strong DB password.
3. Wait ~2 minutes for the project to provision.

### 1.2 Grab the API keys

1. Open **Project Settings → API**.
2. Copy the following — you'll paste them into `.env` shortly:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key (under **Project API keys**, click "Reveal") → `SUPABASE_SERVICE_ROLE_KEY`
3. ⚠️ The service role key bypasses all RLS. Never put it in the frontend, never commit it to git.

### 1.3 Create the Storage buckets

1. Open **Storage** (left sidebar) → **New bucket**.
2. Create `templates` → toggle **Public** OFF → **Create**.
3. Create `mockups` → toggle **Public** OFF → **Create**.

Both buckets are private. The backend hands out short-lived signed URLs at read time.

### 1.4 Run the SQL (tables + RLS policies)

1. Open **SQL Editor** → **New query**.
2. Paste the entire block below and click **Run**.

```sql
-- ============================================================
-- MockBloom — schema and RLS policies
-- Safe to re-run; uses IF NOT EXISTS / DROP POLICY IF EXISTS.
-- ============================================================

-- gen_random_uuid() comes from pgcrypto
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- templates: one row per image, discriminated by kind
-- ------------------------------------------------------------
create table if not exists public.templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('front', 'back', 'label')),
  storage_path text not null,
  sort_hue     numeric,
  created_at   timestamptz not null default now()
);

create index if not exists templates_user_kind_idx
  on public.templates (user_id, kind);

alter table public.templates enable row level security;

drop policy if exists "templates_select_own" on public.templates;
create policy "templates_select_own"
  on public.templates for select
  using (auth.uid() = user_id);

drop policy if exists "templates_insert_own" on public.templates;
create policy "templates_insert_own"
  on public.templates for insert
  with check (auth.uid() = user_id);

drop policy if exists "templates_update_own" on public.templates;
create policy "templates_update_own"
  on public.templates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "templates_delete_own" on public.templates;
create policy "templates_delete_own"
  on public.templates for delete
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- mockups: generated JPEGs the user wants to keep
-- ------------------------------------------------------------
create table if not exists public.mockups (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index if not exists mockups_user_created_idx
  on public.mockups (user_id, created_at desc);

alter table public.mockups enable row level security;

drop policy if exists "mockups_select_own" on public.mockups;
create policy "mockups_select_own"
  on public.mockups for select
  using (auth.uid() = user_id);

drop policy if exists "mockups_insert_own" on public.mockups;
create policy "mockups_insert_own"
  on public.mockups for insert
  with check (auth.uid() = user_id);

drop policy if exists "mockups_update_own" on public.mockups;
create policy "mockups_update_own"
  on public.mockups for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "mockups_delete_own" on public.mockups;
create policy "mockups_delete_own"
  on public.mockups for delete
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- backgrounds: optional images composited behind shirts
-- ------------------------------------------------------------
create table if not exists public.backgrounds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index if not exists backgrounds_user_created_idx
  on public.backgrounds (user_id, created_at);

alter table public.backgrounds enable row level security;

drop policy if exists "backgrounds_select_own" on public.backgrounds;
create policy "backgrounds_select_own"
  on public.backgrounds for select
  using (auth.uid() = user_id);

drop policy if exists "backgrounds_insert_own" on public.backgrounds;
create policy "backgrounds_insert_own"
  on public.backgrounds for insert
  with check (auth.uid() = user_id);

drop policy if exists "backgrounds_update_own" on public.backgrounds;
create policy "backgrounds_update_own"
  on public.backgrounds for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "backgrounds_delete_own" on public.backgrounds;
create policy "backgrounds_delete_own"
  on public.backgrounds for delete
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Storage policies — ownership is encoded in the object's first path segment.
-- Path convention: {user_id}/...   →   (storage.foldername(name))[1] = auth.uid()::text
-- ------------------------------------------------------------
drop policy if exists "templates_bucket_select_own" on storage.objects;
create policy "templates_bucket_select_own"
  on storage.objects for select
  using (bucket_id = 'templates' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "templates_bucket_insert_own" on storage.objects;
create policy "templates_bucket_insert_own"
  on storage.objects for insert
  with check (bucket_id = 'templates' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "templates_bucket_delete_own" on storage.objects;
create policy "templates_bucket_delete_own"
  on storage.objects for delete
  using (bucket_id = 'templates' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "mockups_bucket_select_own" on storage.objects;
create policy "mockups_bucket_select_own"
  on storage.objects for select
  using (bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "mockups_bucket_insert_own" on storage.objects;
create policy "mockups_bucket_insert_own"
  on storage.objects for insert
  with check (bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "mockups_bucket_delete_own" on storage.objects;
create policy "mockups_bucket_delete_own"
  on storage.objects for delete
  using (bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text);
```

If everything ran without errors, you should see three tables under **Database → Tables** and policies under **Authentication → Policies**.

### 1.5 (Optional) Disable email confirmation for fast local testing

By default Supabase requires email verification before a user can log in.

- For local development: **Authentication → Providers → Email** → toggle **Confirm email** OFF → Save.
- For production: leave it ON.

---

## 2. Configure `.env`

1. From the `server/` directory, copy the example:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in:
   - `SUPABASE_URL` → from step 1.2
   - `SUPABASE_ANON_KEY` → from step 1.2
   - `SUPABASE_SERVICE_ROLE_KEY` → from step 1.2
   - `FRONTEND_URL` → for now leave as `http://localhost:3000`. Add your Netlify URL after deploy.
3. Leave the rest at their defaults.

---

## 3. Install & Run Locally

From the `server/` directory:

```bash
npm install
npm run dev
```

You should see:

```
MockBloom API listening on port 3001
Allowed origins: http://localhost:3000
```

Test the health check:

```bash
curl http://localhost:3001/
# → {"service":"mockbloom-api","status":"ok"}
```

---

## 4. Deploy to Render (free tier)

### 4.1 Push the project to GitHub

If you haven't yet:

```bash
cd /Users/ericwittenburg/coding/mockup-generator
git init
git add .
git commit -m "Initial MockBloom backend"
# Create a new GitHub repo, then:
git remote add origin <your-repo-url>
git push -u origin main
```

### 4.2 Create the Render service

1. Go to <https://render.com> and sign in with GitHub.
2. Click **New → Web Service**.
3. Connect the GitHub repo you just pushed.
4. Render will auto-detect `server/render.yaml` and pre-fill most fields:
   - **Name:** `mockbloom-api` (or anything)
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Under **Environment Variables**, fill in the four `sync: false` ones:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `FRONTEND_URL` → your Netlify URL, e.g. `https://mockbloom.netlify.app`
6. Click **Create Web Service**. First deploy takes ~3–5 minutes.

### 4.3 Verify

```bash
curl https://mockbloom-api.onrender.com/
# → {"service":"mockbloom-api","status":"ok"}
```

> **Free tier note:** Render's free web services spin down after 15 minutes of inactivity. The first request after idling takes ~50 seconds to wake up; subsequent requests are instant.

---

## 5. Connect the Frontend (`index.html`)

The frontend currently uses IndexedDB for everything. To switch it to the API you'll need three changes:

1. **A central `API_BASE` + token helper** at the top of the script block.
2. **Replace `loadTemplates`, `addTemplates`, `removeTemplate`** (and the back/label/background equivalents) to hit the API instead of IndexedDB.
3. **Add a login/signup overlay** that gates the app until the user is authenticated.

Below is the minimum drop-in needed for each of those — paste each block into `index.html` near the function it replaces.

### 5.1 Add this once, near the top of `<script>`

```javascript
// ===== API CONFIG =====
const API_BASE = "http://localhost:3001/api/v1";
// In production, swap to: 'https://mockbloom-api.onrender.com/api/v1'

function authToken() {
  return localStorage.getItem("mb_token") || "";
}
function setAuthToken(token) {
  if (token) localStorage.setItem("mb_token", token);
  else localStorage.removeItem("mb_token");
}
function authHeaders() {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}), ...authHeaders() };
  // Don't override Content-Type for FormData (multer needs the boundary header)
  if (
    opts.body &&
    !(opts.body instanceof FormData) &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}
```

### 5.2 Auth (signup / login / logout)

```javascript
// POST /api/v1/auth/signup
async function signup(email, password) {
  const { session } = await apiFetch("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (session?.access_token) setAuthToken(session.access_token);
  return session;
}

// POST /api/v1/auth/login
async function login(email, password) {
  const { session } = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setAuthToken(session.access_token);
  return session;
}

// POST /api/v1/auth/logout
async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {}
  setAuthToken(null);
}
```

### 5.3 Templates (front, back, label)

```javascript
// POST /api/v1/templates — upload one image
// kind = 'front' | 'back' | 'label'
async function apiUploadTemplate(file, name, kind, sortHue) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);
  fd.append("kind", kind);
  if (sortHue != null) fd.append("sortHue", String(sortHue));
  const { template } = await apiFetch("/templates", {
    method: "POST",
    body: fd,
  });
  return template;
}

// GET /api/v1/templates?kind=front
async function apiListTemplates(kind) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const { templates } = await apiFetch(`/templates${q}`);
  return templates; // each row has a `signedUrl` you can drop into <img src>
}

// DELETE /api/v1/templates/:id
async function apiDeleteTemplate(id) {
  await apiFetch(`/templates/${id}`, { method: "DELETE" });
}
```

### 5.4 Mockups

```javascript
// POST /api/v1/mockups — save a generated JPEG
// `dataUrl` is what generateMockups already produces (canvas.toDataURL('image/jpeg', 0.92))
async function apiSaveMockup(name, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append("name", name);
  fd.append("file", blob, `${name}.jpg`);
  const { mockup } = await apiFetch("/mockups", { method: "POST", body: fd });
  return mockup;
}

// GET /api/v1/mockups
async function apiListMockups() {
  const { mockups } = await apiFetch("/mockups");
  return mockups;
}

// DELETE /api/v1/mockups/:id
async function apiDeleteMockup(id) {
  await apiFetch(`/mockups/${id}`, { method: "DELETE" });
}
```

### 5.5 Backgrounds

```javascript
// POST /api/v1/backgrounds
async function apiUploadBackground(file, name) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);
  const { background } = await apiFetch("/backgrounds", {
    method: "POST",
    body: fd,
  });
  return background;
}

// GET /api/v1/backgrounds
async function apiListBackgrounds() {
  const { backgrounds } = await apiFetch("/backgrounds");
  return backgrounds;
}

// DELETE /api/v1/backgrounds/:id
async function apiDeleteBackground(id) {
  await apiFetch(`/backgrounds/${id}`, { method: "DELETE" });
}
```

### 5.6 Wiring example — replace `loadTemplates`

The cleanest cut-over is to keep the in-memory `templates` array but populate it from the API. The rest of the frontend keeps working because it already operates on the array, not directly on IndexedDB.

**Before** (uses IndexedDB):

```javascript
async function loadTemplates() {
  const rows = await dbAll("templates");
  templates = rows.map((t) => ({
    ...t,
    blobUrl: mkBlobUrl(t.dataUrl),
    thumbUrl: t.thumbDataUrl ? mkBlobUrl(t.thumbDataUrl) : null,
  }));
  templates.sort((a, b) => (a.sortHue ?? 500) - (b.sortHue ?? 500));
  renderSwatches();
  const needsMigration = templates.filter(
    (t) => !t.thumbUrl || t.sortHue == null,
  );
  if (needsMigration.length) generateThumbnailsIdle(needsMigration);
}
```

**After** (uses the API):

```javascript
async function loadTemplates() {
  const rows = await apiListTemplates("front");
  templates = rows.map((t) => ({
    id: t.id,
    name: t.name,
    sortHue: t.sort_hue,
    dataUrl: t.signedUrl, // signed URL works anywhere a data URL does for <img src>
    blobUrl: t.signedUrl,
    thumbUrl: t.signedUrl, // server doesn't store thumbnails in v1 — see plan note
  }));
  templates.sort((a, b) => (a.sortHue ?? 500) - (b.sortHue ?? 500));
  renderSwatches();
}
```

**Before** (uploads to IndexedDB):

```javascript
async function addTemplates(files) {
  // ... thumbnail + sortHue + dbAdd ...
}
```

**After** (uploads via API):

```javascript
async function addTemplates(files) {
  const progress = $("uploadProgress"),
    progressText = $("uploadProgressText");
  progress.classList.add("visible");
  for (let i = 0; i < files.length; i++) {
    progressText.textContent = `Processing ${i + 1} of ${files.length}…`;
    const f = files[i];
    // Compute sortHue client-side from the file before upload
    const dataUrl = await fileToDataUrl(f);
    const sortHue = await computeSortHue(dataUrl);
    const row = await apiUploadTemplate(f, baseName(f), "front", sortHue);
    templates.push({
      id: row.id,
      name: row.name,
      sortHue: row.sort_hue,
      dataUrl: row.signedUrl,
      blobUrl: row.signedUrl,
      thumbUrl: row.signedUrl,
    });
  }
  progress.classList.remove("visible");
  templates.sort((a, b) => (a.sortHue ?? 500) - (b.sortHue ?? 500));
  renderSwatches();
  updateSelectionCount();
  updatePreview();
}
```

**Before** (deletes from IndexedDB):

```javascript
async function removeTemplate(id) {
  await dbDel("templates", id);
  // ...
}
```

**After** (deletes via API):

```javascript
async function removeTemplate(id) {
  await apiDeleteTemplate(id);
  templates = templates.filter((t) => t.id !== id);
  selectedIds.delete(id);
  const el = templateGrid.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
  updateSelectionCount();
  updateBtn();
  updatePreview();
}
```

Apply the same pattern to `loadBackTemplates` / `addBackTemplates` / `removeBackTemplate` (pass `'back'` as `kind`), and to labels (`'label'`) and backgrounds (use the `apiUploadBackground` / `apiListBackgrounds` / `apiDeleteBackground` helpers).

### 5.7 A minimal login gate

```html
<!-- somewhere before <div id="workspace"> -->
<div
  id="authOverlay"
  style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0b;z-index:9999"
>
  <form
    id="authForm"
    style="display:flex;flex-direction:column;gap:12px;width:280px"
  >
    <input id="authEmail" type="email" placeholder="email" required />
    <input
      id="authPassword"
      type="password"
      placeholder="password"
      required
      minlength="6"
    />
    <div style="display:flex;gap:8px">
      <button type="submit" data-mode="login">Log in</button>
      <button type="submit" data-mode="signup">Sign up</button>
    </div>
    <div id="authError" style="color:#ff6b6b;font-size:12px"></div>
  </form>
</div>
```

```javascript
const authOverlay = document.getElementById("authOverlay");
const authForm = document.getElementById("authForm");
const authError = document.getElementById("authError");

function hideAuthOverlay() {
  authOverlay.style.display = "none";
}
function showAuthOverlay() {
  authOverlay.style.display = "flex";
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  const mode = e.submitter?.dataset.mode || "login";
  const email = document.getElementById("authEmail").value;
  const password = document.getElementById("authPassword").value;
  try {
    if (mode === "signup") await signup(email, password);
    else await login(email, password);
    hideAuthOverlay();
    // Load everything from the API now that we're authed
    await loadTemplates();
    await loadBackTemplates();
    await loadLabels();
    await loadBackgrounds();
  } catch (err) {
    authError.textContent = err.message;
  }
});

// On boot, only hide the overlay if we already have a token AND it still works.
(async () => {
  if (!authToken()) {
    showAuthOverlay();
    return;
  }
  try {
    await apiListTemplates("front"); // ping; throws on 401
    hideAuthOverlay();
    await loadTemplates();
    await loadBackTemplates();
    await loadLabels();
    await loadBackgrounds();
  } catch {
    setAuthToken(null);
    showAuthOverlay();
  }
})();
```

---

## 6. File map

| File                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `index.js`              | Express app, CORS, route mounting, error handling             |
| `routes/auth.js`        | signup, login, logout                                         |
| `routes/templates.js`   | upload/list/delete front+back+label images                    |
| `routes/mockups.js`     | save/list/delete generated JPEGs                              |
| `routes/backgrounds.js` | upload/list/delete background images                          |
| `middleware/auth.js`    | validates Supabase JWT, attaches `req.user` and `req.jwt`     |
| `middleware/upload.js`  | multer in-memory image upload, 8 MB cap, image MIME whitelist |
| `supabase/client.js`    | service + user-scoped Supabase client factory                 |
| `render.yaml`           | declarative Render deployment config                          |
| `.env.example`          | required env vars, documented                                 |

---

## 7. Security notes

- Every protected route runs through `requireAuth`, which validates the JWT against Supabase Auth on every request (no local-only verification).
- Every database read/write inside a route uses a **user-scoped Supabase client** built from that JWT, so RLS enforces ownership server-side even if a future handler forgets to filter by `user_id`.
- The service role key is only used for two specific things: Storage object I/O and JWT validation. It never reaches the browser.
- File uploads stay in memory — the server writes nothing to local disk and works on ephemeral hosts.
- Storage buckets are private; the API mints short-lived signed URLs per request.
