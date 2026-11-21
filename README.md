# Quilt Studio — hosted version

A copy of Quilt Studio that runs on any static host (GitHub Pages, Netlify, Vercel…) with no server.

**Where data lives**

- **In the browser** (IndexedDB): always. Works offline, and holds far more than the old ~5 MB `localStorage` limit.
- **Back up / Restore**: buttons in the header download everything (photos included) as one `.json` file and load it back on any device.
- **Google Drive sync** (optional): each person signs in with Google, and their data syncs to a hidden app folder in *their own* Drive. You never see or store anyone's data, and it costs you nothing.

Data saved by the original version of the app in the same browser is copied over automatically the first time it opens.

## Files

| File | What it is |
|---|---|
| `index.html` | The app (Haley's original, with the storage swapped and Claude-only features removed) |
| `storage.js` | Browser storage, backup/restore and Google Drive sync |
| `config.js` | The one setting you edit: your Google client ID |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## 1. Publish on GitHub Pages

1. Create a new **public** repository on GitHub (for example `quilt-studio`).
2. Upload these files to the root of the repo (**Add file → Upload files**), then commit.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/quilt-studio/`.

At this point the app works, with browser storage and Backup / Restore. Steps 2–3 add Drive sync.

## 2. Create a Google client ID (about 10 minutes)

1. Open <https://console.cloud.google.com/>, and create a project (e.g. "Quilt Studio").
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **Google Auth Platform** (shown as **OAuth consent screen** in some consoles):
   - **Branding**: app name "Quilt Studio", your support email, and the app's home page URL.
   - **Audience**: choose **External**. While it's in *Testing*, add the Google accounts of the people who'll use it under **Test users** (up to 100).
   - **Data access**: add the scope `.../auth/drive.appdata`. Google lists it as non-sensitive. `openid` and `email` are added automatically.
4. **Clients → Create client** → type **Web application**.
   - **Authorized JavaScript origins**: `https://<your-username>.github.io` (no path, no trailing slash). Add `http://localhost:8000` too if you want to test locally.
   - No redirect URIs are needed.
5. Copy the **Client ID**. It looks like `1234-abc.apps.googleusercontent.com`.

## 3. Turn on sync

Edit `config.js` in the repo:

```js
window.QS_CONFIG = {
  googleClientId: "1234-abc.apps.googleusercontent.com"
};
```

Commit. Reload the site, and a **Sync with Google Drive** button appears in the header.

### Letting anyone sign in (leaving Testing mode)

In Testing mode only your listed test users can sign in. To open it up, go to **Audience → Publish app**. Because the app only uses non-sensitive scopes, Google asks for basic brand verification rather than a security review. That needs:

- a home page and a privacy policy page (a short `privacy.html` in this repo is fine), and
- a domain you've verified in Google Search Console. A custom domain pointed at GitHub Pages is the smoothest route.

## How sync works

- Each saved item (a design, fabric, WIP, yarn…) is one small JSON file in the Drive app folder. Only changed items are sent.
- Sync runs on sign-in, a few seconds after each change, when the tab comes back into view, and every 5 minutes.
- If two devices change the same item, the most recent save wins. Deletions sync too.
- Google sign-in in a browser-only app lasts about an hour. After that the header shows **Reconnect**; one tap, and usually no password, gets it going again. Changes made meanwhile are kept and sync on reconnect.
- People can see or remove the app's Drive data under **Drive → Settings → Manage apps → Quilt Studio**.
- Signing out stops syncing; nothing is deleted from the browser or from Drive.

## What's different from the Claude version

- **Backing & binding suggestions are off.** They used Claude's built-in AI, which isn't available on a static site. Adding them back would need a small server function holding an Anthropic API key.
- **Cut list download** now saves an ordinary `.txt` file.
- The old `localStorage` keys (`qs:stash`, `qs:designs`, …) are left in place after the one-time copy, as a safety net.

## Testing locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
