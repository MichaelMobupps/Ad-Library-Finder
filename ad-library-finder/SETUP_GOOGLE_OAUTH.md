# Google OAuth Setup (one-time)

Batch 2 sends job completion emails via Gmail using the OAuth-authorized account as sender. This requires a Google Cloud project + OAuth Client ID. ~10 minutes of setup.

## 1. Create / pick a GCP project

- Go to https://console.cloud.google.com
- Top bar → project dropdown → New Project (or pick an existing one)
- Name it `mobupps-ad-library-finder` or similar

## 2. Enable Gmail API

- Sidebar → APIs & Services → Library
- Search "Gmail API" → click → **Enable**

## 3. Configure OAuth consent screen

- Sidebar → APIs & Services → OAuth consent screen
- User Type: **External** (unless your org has Workspace + Internal option)
- App name: `Ad Library Finder`
- User support email: your email
- Developer contact: your email
- Save & Continue
- Scopes: **Add or remove scopes** → search and tick:
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/userinfo.email`
- Save & Continue
- Test users: Add the Gmail account that will SEND the emails (the sender account)
- Save & Continue → Back to dashboard

## 4. Create OAuth Client ID

- Sidebar → APIs & Services → Credentials → **+ Create Credentials** → **OAuth client ID**
- Application type: **Web application**
- Name: `Ad Library Finder Web`
- **Authorized redirect URIs**: add `<PUBLIC_BASE_URL>/api/auth/google/callback`
  - For Replit deployment: `https://your-deployment.replit.app/api/auth/google/callback`
  - For Replit dev workspace: `https://your-workspace.username.repl.co/api/auth/google/callback`
  - You can add multiple
- Create
- Copy **Client ID** and **Client secret** → paste into `.env`:
  - `GOOGLE_CLIENT_ID=...`
  - `GOOGLE_CLIENT_SECRET=...`
  - `PUBLIC_BASE_URL=https://your-deployment.replit.app`

## 5. Restart api-server

After `.env` is updated, restart the Replit deployment. Then in the UI:

- Top nav → **Settings**
- Click **Connect Gmail Account**
- Pick the sender Gmail account (same one you added as a test user above)
- Authorize the requested scopes
- You'll redirect back to Settings showing the connected account

## 6. Set default recipient

- Same Settings page → enter recipient email (where job-complete notifications go)
- Save

Now every completed job emits an email with the CSV attached. Failed jobs send a short error notice.

## Notes

- During testing-only mode (no app verification), only the test users you added can authorize. To open it to the whole org, submit for verification (Google review takes ~weeks; not needed for internal SDR tooling).
- Refresh tokens persist across deployments because they're in SQLite. The DB lives at `data/ad-library.sqlite` — back it up if you redeploy fresh.
- To rotate sender, click Disconnect in Settings then Connect again.
