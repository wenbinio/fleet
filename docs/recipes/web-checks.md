# Screenshots and deploy checks (`fleet_shot`, `fleet_deploy_wait`)

Both use the installed Chrome, headless, over a private DevTools **pipe** (no TCP port, so they can never collide
with another session's Chrome, such as the long-lived one on port 9333), with a fresh temp profile per run that is
deleted afterwards. They never attach to or kill another Chrome.

```
fleet_shot {url: "https://bylok.ink/"}                    # or dir: "<local folder>" (served on 127.0.0.1)
fleet_shot {url, widths: [390, 1440], waitFor: "#app", waitMs: 500}
fleet_deploy_wait {url: "https://bylok.ink", path: "/assets/app.js", marker: "<sha or text>", repo, sha}
```

- `fleet_shot` returns **file paths only** (plus width, height, console-error and failed-request counts, and the
  first few errors), never image data: Claude decides whether to look. 390 px uses mobile emulation.
- `fleet_deploy_wait` polls (default every 60 s, up to 75 min) until the live file contains the marker, and reports
  the minutes it took. With `repo` + `sha` it also reports GitHub check runs such as Cloudflare "Workers Builds".
  Report only: it never deploys, pushes or triggers anything.

## Facts and traps

1. **bylok.ink refuses curl**, so both fetch through headless Chrome.
2. **Vercel serves a push 2–60 min later and posts no commit status**: hence polling the live file for a marker.
3. **Chrome holds its profile a moment after closing.** Deleting the temp profile at once failed with EPERM and
   (before the fix) failed the run; fleet now waits for Chrome to exit, retries, and only notes a cleanup failure.
4. The first live shot (2026-10-21) found `https://bylok.ink/favicon.ico` returning 404.
