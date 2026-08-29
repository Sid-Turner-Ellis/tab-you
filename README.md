# TabYou

A Chrome new-tab organizer for open tabs, bookmarks, spaces, and sessions.

## Run locally

```sh
npm install
npm run dev
```

WXT opens a development Chrome profile with the extension loaded. Open a new tab to use TabYou.

## Build the extension

```sh
npm run build
```

Load `.output/chrome-mv3` as an unpacked extension from `chrome://extensions`.

All user data is stored on-device using the browser's local extension storage. There is no account, server, sync, telemetry, or network API.
