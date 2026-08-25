# AutoPost

Compose a social post in a browser, have someone approve it, and let an automation publish
it to Facebook / Instagram / X / LinkedIn / YouTube at a scheduled time.

There is no database and no server. A Google Sheet is the database, Apps Script is the API,
and n8n does the publishing through [Blotato](https://blotato.com), which holds the actual
social account connections.

```
                        ┌──────────────────────────────────────────┐
  index.html            │  Google Sheet — one row per post         │
  compose a post  ─────▶│    status:      For review | Publish     │
  (Supabase login)      │    post status: queued | processing | …  │
                        └───────────────┬──────────────────────────┘
  review.html                           │
  preview, edit, approve ───────────────┤
  (same login)                          │
                                        ▼
                        Apps Script  sweep()  — runs every minute
                        "is anything approved, queued and due?"
                                        │  only if yes
                                        ▼
                        n8n webhook ──▶ Blotato ──▶ the social accounts
                                        │
                        outcome written back to the row
```

Everything the browser does goes through **[AppsScript.gs](AppsScript.gs)**, which is the
only thing that touches the sheet. The pages are static files with no privileges of their
own — the login is verified server-side, in Apps Script, on every request.

---

## The moving parts

| Piece | What it does | Where it lives |
|---|---|---|
| [index.html](index.html) | Compose: media, caption, channels, schedule, live preview | Vercel |
| [review.html](review.html) | The queue: preview, edit, approve, requeue, delete | Vercel |
| [AppsScript.gs](AppsScript.gs) | The API, the sheet writer, **and the scheduler** | Apps Script, bound to the sheet |
| Google Sheet | The database. One row per post | Google Drive |
| `AutoPost uploads` folder | Uploaded images/video, link-shared so Blotato can fetch them | Google Drive |
| [n8n/autopost-workflow-all-platforms.json](n8n/autopost-workflow-all-platforms.json) | **v2** — all five platforms, 35 nodes. *This is the one in use* | n8n Cloud |
| [n8n/autopost-workflow.json](n8n/autopost-workflow.json) | v1 — Facebook only, 23 nodes | n8n Cloud |
| [n8n/autopost-workflow-direct-apis.json](n8n/autopost-workflow-direct-apis.json) | Pre-Blotato reference. **Never import this** | — |
| Supabase | Sign-in only. No data is stored there | supabase.com |
| Blotato | Holds the connected social accounts, does the actual posting | blotato.com |

---

## Accounts you need to take this over

Six, and you need all of them. The values live in `ACCOUNTS.md`, which is **gitignored and
not in this repo** — get it from whoever hands the project over.

| # | Account | Why you need it | Lose it and… |
|---|---|---|---|
| 1 | **Google** (owns the sheet) | The sheet, the Apps Script project, the Drive upload folder | nothing works at all |
| 2 | **n8n Cloud** | The publishing workflow and its credentials | nothing publishes |
| 3 | **Blotato** | The connected Facebook page and other social accounts | nothing publishes |
| 4 | **Supabase** | Creating and removing the people who can log in | nobody can sign in |
| 5 | **Vercel** | Hosts the two pages. Auto-deploys on push to `main` | the site goes stale, not down |
| 6 | **GitHub** | This repo | you can still deploy by hand |

Plus the **Facebook Page** itself, which is connected inside Blotato rather than here.

### Secrets that exist nowhere in this repo

Deliberately not committed. Both live in **Apps Script → Project Settings → Script
Properties**:

| Property | What it is |
|---|---|
| `n8nWebhookUrl` | `https://<instance>.app.n8n.cloud/webhook/autopost-sweep` |
| `n8nWebhookSecret` | Must match the **Header Auth** credential on the n8n webhook node |

The header *name* (`x-autopost-key`) is in the code — it says which header to send, not
what to put in it.

`SUPABASE_URL` and `SUPABASE_KEY` **are** in the code, in all three files, and that is
fine: the anon/publishable key is designed to ship in a web page. What protects the system
is that public sign-up is **off** in Supabase, so the only accounts that exist are ones
somebody created by hand.

---

## The sheet

Headers are matched case-insensitively and by alias, so `post at` / `publish at` /
`schedule` all work. Add a column and it fills itself in; leave one out and that field is
skipped.

| Column | Written by | Notes |
|---|---|---|
| `gdrive url` | form | comma-separated for a carousel; order matters, item 1 is the cover |
| `file id` | form | optional, derived from the URL |
| `caption` | form | forced to text format so a leading `=` is not run as a formula |
| `facebook` `instagram` `twitter` `linkedin` `youtube` | form | `TRUE` when ticked. A single comma-separated `platforms` column also works |
| `post at` | form | UTC ISO, stored **as text** — see the gotchas |
| `status` | form, then a human | `For review` → `Publish`. **The approval gate** |
| `post status` | Apps Script + n8n | `queued` → `processing` → `posted` / `failed` |
| `result` | n8n | what happened, per platform |
| `processed at` | n8n | when the row was claimed, then when it finished |
| `submitted by` | Apps Script | optional — who composed it |
| `approved by` | Apps Script | optional — who approved it |
| `youtube title` `youtube privacy` `timezone` `timestamp` | form | optional |

**`status` is the human gate; `post status` is the machine's.** n8n never writes `status`,
and Apps Script never writes `post status` except to requeue a stranded row. That
separation is what stops a published post going out twice.

---

## Taking it over

### 1. Google — the sheet and the script

Open the sheet → **Extensions → Apps Script** → paste all of [AppsScript.gs](AppsScript.gs).

**Deploy → Manage deployments → ✏️ → Version: New version.** Copy the `/exec` URL and make
sure it matches `SHEET_ENDPOINT` in both HTML files.

> **Saving is not deploying.** The live URL keeps running the old code until you create a
> new *version*. This catches everyone at least once.

Then run these once from the editor's function dropdown, approving the permission prompts:

| Function | Why |
|---|---|
| `authorizeDrive` | grants Drive access for uploads |
| `verifyUser` | grants outbound HTTP (Supabase + n8n). It will error — you only need the prompt |
| `installSweep` | **starts the clock.** Nothing publishes until this has run |

### 2. Supabase — who can log in

**Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up"
and **off** "Confirm email".

**Authentication → Users → Add user** → email + password → tick *Auto Confirm*. That user
list *is* the allowlist; there is no separate table. Delete a user to revoke them.

### 3. n8n — the publisher

1. **Settings → Community Nodes** → install `@blotato/n8n-nodes-blotato` **before
   importing**, or the import shows unrecognised nodes.
2. **Credentials → Add → Header Auth**: name `x-autopost-key`, value = the same string as
   the `n8nWebhookSecret` Script Property.
3. Import [n8n/autopost-workflow-all-platforms.json](n8n/autopost-workflow-all-platforms.json).
4. Re-attach credentials — an import carries nodes, not credentials:
   - **Google Sheets** on `Get new rows`, `Mark processing`, `Write status back`
   - **Blotato** on all 7 Blotato nodes
   - **Header Auth** on the webhook trigger
5. On `Facebook publish`, set **Account → From list** and pick the page.
6. **Activate** it, then copy the webhook's **Production** URL into the `n8nWebhookUrl`
   Script Property.

### 4. Vercel

Connected to the GitHub repo. A push to `main` deploys both pages. Nothing to configure.

---

## Running it day to day

1. Someone composes a post at `/` and saves. The row lands as `For review`.
2. Someone opens `/review.html`, checks the preview, fixes anything, hits **Approve**.
3. If it is due now it publishes immediately; otherwise the sweep picks it up within a
   minute of its scheduled time.

### The health check

Open the `/exec` URL in a browser:

```json
{ "version": "…", "auth": true, "webhook": true, "lastSweep": "…" }
```

| Field | Should be | If not |
|---|---|---|
| `version` | matches `VERSION` in the file | you edited but didn't deploy a new version |
| `auth` | `true` | Supabase config missing — nobody can sign in |
| `webhook` | `true` | Script Properties missing — nothing will publish |
| `lastSweep` | within a few minutes | the trigger is gone — run `installSweep` |

Or run **`sweepStatus`** from the editor: it prints all of that plus which rows are due
right now, and changes nothing.

### When nothing publishes

In order: is `lastSweep` recent? → is `webhook` true? → is the n8n workflow **Active**? →
n8n **Executions** for an error → Apps Script **Executions**, filtered to `sweep`, for an
HTTP 403 (header auth mismatch).

### A row stuck on `processing`

n8n claimed it and the run died — usually because someone stopped it mid-test. Open it in
the review queue and hit **Requeue**. Nothing else in the system can free it.

To test without publishing, **disable the `Facebook publish` node** in n8n (select it,
press `D`) rather than stopping the run. The run completes, writes its status back, and
posts nothing — no stranded rows.

---

## Gotchas that will bite you

**Editing Apps Script is not deploying.** New version, every time.

**Triggers run the *saved* code; the web app runs the *deployed* version.** So `sweep()`
picks up an edit immediately, but anything the pages call does not.

**Re-importing a workflow resets the Facebook account** to a Config placeholder. Re-pick it
from the list, or publishing fails on an invalid account id.

**n8n bills per execution, and a Schedule Trigger counts every firing** regardless of
outcome. That is why the clock lives in Apps Script — a per-minute trigger is ~43,800
executions a month against a 2,500 plan. Do not put a Schedule Trigger back.

**`post at` must stay text-formatted.** If Sheets treats it as a real date it re-reads the
UTC string in the spreadsheet's own timezone and the post goes out hours off.
`writeSchedule()` forces the format; don't reformat that column by hand.

**Only Instagram carousels can mix video and images.** Facebook publishes video as a Reel,
X takes 4 photos *or* one video. The composer warns per channel.

**Deleting a row shifts every row below it up by one,** and n8n addresses rows by number.
Deletion is refused while anything below is genuinely mid-publish.

---

## Notes

- [n8n/README.md](n8n/README.md) has the per-node detail of the workflows.
- `VERSION` in AppsScript.gs is bumped on every change so `/exec` can tell you what is
  actually live. Keep doing that.
- [.vercelignore](.vercelignore) keeps the docs, the `.gs` file and the workflow JSON off
  the public site — only the two HTML pages are served.
