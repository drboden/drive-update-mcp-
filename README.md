# drive-update-mcp

A small **remote MCP server** that gives Claude one capability the built-in Google Drive
connector is missing: **updating an existing Drive file in place.**

When Claude calls `update_drive_file`, the file keeps the **same file ID, the same
shareable link, and Drive retains the previous version** in its revision history. No
duplicates, no broken links.

---

## How it works

```
Claude (claude.ai / app)  ──►  this MCP server (on Render)  ──►  Google Drive API
                                                                   files.update()  ← overwrites in place
```

- Claude connects to the server from Anthropic's cloud using the **Streamable HTTP** MCP transport.
- The server authenticates to Google Drive with a **service account** — no interactive
  Google login to manage. You grant it access to a file by **sharing that file (or its
  folder) with the service-account's email address**.

### Tools exposed
| Tool | What it does |
|------|--------------|
| `update_drive_file` | Overwrite an existing file's contents by `fileId` (in place). |
| `find_files` | Search by name to resolve a file's `fileId`. |
| `create_drive_file` | Create a new file from base64 content (optionally in a folder). |
| `list_revisions` | Show a file's revision history. |

---

## Prerequisites
- A Google account with Google Drive.
- A Google Cloud project (free).
- A Render account (free tier is fine) — or any Node host that gives you an HTTPS URL.
- A Claude **Pro, Max, Team, or Enterprise** plan (custom connectors are not on Free).

---

## Setup

### Part A — Create the Google service account
1. Go to the **Google Cloud Console** → create or pick a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create service account** (any name, e.g. `drive-updater`).
4. Open the service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. Note the service account's **email** (looks like `drive-updater@your-project.iam.gserviceaccount.com`).

### Part B — Give the service account access to your file
The service account can only touch files that are shared with it.
- In Google Drive, **share the target file** (or, easier, the **folder** that holds it)
  with the service-account email from step A5, with **Editor** permission.
- Do this once per file/folder you want Claude to be able to update.

> Tip: keep all the docs Claude manages in one folder and share just that folder.

### Part C — Deploy to Render
1. Push this folder to a GitHub repo (or use Render's "deploy from local" / blueprint).
2. In Render: **New → Web Service →** point it at the repo. `render.yaml` is included, so
   Render will pick up the build/start commands automatically. Otherwise set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Add two **Environment Variables**:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` → paste the **entire contents** of the JSON key file from Part A4.
   - `MCP_AUTH_TOKEN` → a long random string you invent (this protects the endpoint).
4. Deploy. When it's live, confirm `https://YOUR-APP.onrender.com/health` returns `{"ok":true,...}`.

### Part D — Connect it to Claude
1. In Claude: **Settings → Connectors → "+" → Add custom connector**
   (on Pro/Max you may need to enable connector/developer features first).
2. **Name:** `Drive Update`
3. **URL:** `https://YOUR-APP.onrender.com/mcp?token=YOUR_MCP_AUTH_TOKEN`
   (the `?token=...` is how the server authorises the call — use the same value as `MCP_AUTH_TOKEN`).
4. Click **Add**. Leave the OAuth fields blank.
5. In a conversation, enable it via the **"+" → Connectors** toggle.

---

## Using it with Claude

Once connected, the typical flow is:

1. You ask Claude to make changes to a document it produces.
2. Claude builds the updated file, then calls **`find_files`** (to get the `fileId` from the
   name) or you paste the Drive link, and **`update_drive_file`** to overwrite it in place.

For the very first upload, the file has to exist in Drive (so it has an ID to update).
Either upload it once yourself, or have Claude call **`create_drive_file`** once; after
that, every change is an in-place `update_drive_file`.

> Note on size: the new content is passed to the tool **base64-encoded**, so very large
> files mean large tool calls. For typical Office documents (well under a few MB) this is fine.

---

## Security notes
- The `MCP_AUTH_TOKEN` in the URL is what stops anyone else from driving your server.
  Treat that URL like a password; rotate the token if it leaks.
- The service account can reach **only** the files/folders you explicitly shared with it.
  It cannot see the rest of your Drive.
- For a hardened setup you can replace the token gate with a full OAuth flow (Claude
  supports OAuth + Dynamic Client Registration); that's a later upgrade, not needed to start.

---

## Local development
```bash
npm install
# put GOOGLE_SERVICE_ACCOUNT_JSON and MCP_AUTH_TOKEN in your shell env (or a .env loader)
npm start
# health check:
curl localhost:3000/health
```
