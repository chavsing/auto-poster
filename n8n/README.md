# AutoPost — n8n backend

> **Read [../README.md](../README.md) first.** That is the handover doc — the accounts, the
> secrets, and how the whole thing fits together. This file is the per-node detail of the
> workflows only.
>
> **What changed since most of this was written:** the workflow no longer has a Schedule
> Trigger. Apps Script decides when a post is due and calls a **webhook** — n8n counts an
> execution every time a Schedule Trigger fires, and once a minute is ~43,800 a month
> against a 2,500 plan. Sections below that describe an every-minute sweep still describe
> the *logic* correctly; only what starts it moved. There is also a sign-in (Supabase) and
> a separate review page now, both covered in the root README.

The frontend ([index.html](../index.html)) and Apps Script ([AppsScript.gs](../AppsScript.gs)) only
write a row to the Google Sheet. These workflows are the half that publishes it.

| File | What it is |
|---|---|
| `autopost-workflow.json` | **v1** — Facebook only, via the Blotato node. 23 nodes. |
| `autopost-workflow-all-platforms.json` | **v2** — all five platforms the form offers, via the Blotato node. 35 nodes. |
| `autopost-workflow-direct-apis.json` | Pre-Blotato version: each platform hitting its own API directly (Meta app, X developer account, etc.). Kept for reference. |

v1 and v2 are independent — import whichever you want, or both. **Don't activate both at
once:** they read the same sheet on the same filter and would race for rows.

```
index.html ──POST──▶ Apps Script ──append──▶ Google Sheet (status: For review)
                                                    │
                                     ┌──────────────┴───────────────┐
                                     │            n8n               │
                                     └──────────────┬───────────────┘
                                                    │
                        Blotato ▸ Media: Upload  (re-hosts the Drive file, once per row)
                                                    │
                       ┌───────────┬────────────┬───┴────────┬─────────────┐
                    Facebook   Instagram        X         LinkedIn      YouTube     ← v2
                       └───────────┴────────────┴────────────┴─────────────┘
                                                    │
                            Blotato ▸ Post: Get  (real outcome + public post URL)
                                                    │
                Status: posted | partial | submitted | failed  ──▶ back to the row
```

---

## Setup

### 1. Install the Blotato node — do this before importing

Both workflows use `@blotato/n8n-nodes-blotato`, a **verified community node**. Import will
show unrecognised nodes if it isn't installed first.

- **n8n Cloud:** Admin Panel → Settings → enable **Verified Community Nodes**, then search
  "Blotato" in the node panel once to install it.
- **Self-hosted:** Settings → Community Nodes → Install → `@blotato/n8n-nodes-blotato`
  (needs `N8N_COMMUNITY_PACKAGES_ENABLED=true`).

### 2. Sheet

The full layout. Headers are matched case-insensitively, so keep the lowercase style
already in the sheet.

| Column | Filled by | Notes |
|---|---|---|
| `gdrive url` | form | already there |
| `caption` | form | already there |
| `facebook` | form | already there — `TRUE` when ticked |
| `instagram` | form | **add** (v2 only) |
| `twitter` | form | **add** (v2 only) — also accepts a header of `x` |
| `linkedin` | form | **add** (v2 only) |
| `youtube` | form | **add** (v2 only) |
| `post at` | form | **add** — publish time, UTC ISO string |
| `status` | form + **you** | already there. Form writes `For review`; you move it to `Publish` |
| `post status` | form + n8n | **add** — Apps Script writes `queued`; n8n moves it to `processing` → `posted` / `partial` / `submitted` / `failed` / `skipped` |
| `result` | n8n | **add** — per-platform outcome and post URLs |
| `processed at` | n8n | **add** — when n8n finished |

Optional: `timezone`, `file id`, `timestamp`, `youtube title`, `youtube privacy` — all fill
themselves if present, and are ignored if not.

Two settings that matter:

- Format `post at` as **plain text** (Format → Number → Plain text). Apps Script forces the
  cell to text when it writes, but this stops a hand-pasted value being reinterpreted in the
  spreadsheet's own timezone.
- Leave `post status`, `result` and `processed at` **without data validation**. n8n writes
  values your `status` dropdown doesn't contain, and a "Reject input" rule would fail the
  write.

### 2b. Who moves a row to `Publish`

Nothing publishes on its own. The `status` dropdown has exactly two values:

```
form submits   -> status = For review     (held — n8n ignores it)
you approve it -> status = Publish        (n8n considers the row)
                  + `post at` has passed  -> it publishes
```

`For review` is what `AppsScript.gs` writes (`NEW_STATUS`, one line to change). `Publish` is
what `Get new rows` filters on. Those are the only two strings either side cares about.

`Get new rows` filters `status = Publish`, and n8n **never writes that column** — it stays
`Publish` after posting. What stops a published row going out again every minute is the
`post status` column: `Already handled?` skips any row that already has a value there. If
you ever clear `post status` on a published row, it will republish.

### 3. Credentials — two, whichever version you run

| Credential | Attach to |
|---|---|
| **Google Sheets OAuth2** | `Get new rows`, `Mark processing`, `Write status back` |
| **Blotato API** (`blotatoApi`) | every Blotato node |

The Blotato credential takes your API key (Blotato → Settings → API keys); leave **Blotato
Server** at its default. Use its "Test" button — it hits `/v2/users/me`, so a green tick
means the key is good.

No Google Drive credential is needed. Blotato fetches the file over the public Drive link;
n8n never downloads it.

### 4. Config node

**v1** wants three values: `blotatoAccountId`, `blotatoPageId`, `facebookVideoMode`.

**v2** wants one Blotato account id per platform you use, since each connected account is
separate:

| Field | Notes |
|---|---|
| `facebookAccountId` + `facebookPageId` | Page id is required for Facebook |
| `instagramAccountId` | |
| `twitterAccountId` | |
| `linkedinAccountId` | posts as the person; for a Company Page add **Linkedin Page** under the LinkedIn node's Options |
| `youtubeAccountId` | |
| `facebookVideoMode` | `reel` or `video` |
| `instagramVideoMode` | `reel` or `story` |

Both video-mode fields are ignored for image posts.

**You don't have to look any ids up.** Open a publish node, switch **Account** (and
**Facebook Page**) from *By ID* to *From List*, and pick from the dropdown — the node loads
them from your Blotato account. The expressions are only there so the workflow imports
without you hunting for ids first.

If you'd rather paste them:

```bash
curl -H "blotato-api-key: YOUR_KEY" https://backend.blotato.com/v2/users/me/accounts
curl -H "blotato-api-key: YOUR_KEY" \
  https://backend.blotato.com/v2/users/me/accounts/{accountId}/subaccounts
```

Platforms you leave unconfigured simply never get selected on the form, so their branch
never runs.

### 5. Activate

The **webhook trigger** runs the workflow. Apps Script calls it — see the root README.

There is deliberately **no webhook**. The page and Apps Script never call n8n; n8n polls the
sheet and decides everything. That keeps the three parts independent — the form works
whether or not n8n is up, and n8n catches up on whatever it finds when it runs.

---

## Scheduling

The form requires a publish date and time. It's read in **the submitter's own timezone**,
converted to UTC, and written to `Post At` — so the sheet holds one unambiguous instant no
matter who filled the form or from where. The form echoes the choice back
("Publishes Sat, Aug 1, 09:30 — in 3 h") so nobody has to trust the picker blind.

Both workflows gate on that column:

```
Get new rows (post status = queued)      ← published rows never even reach n8n
      │
 Prepare jobs ──▶ Approved? ──false──▶ Nothing to do   ← status isn't Publish,
      │                │                                 or a run already claimed it
      │              true
      │                ▼
      │           Valid row? ──false──▶ Invalid result ──▶ post status: failed
      │                │
      │              true
      │                ▼
      │            Due yet? ──false──▶ Nothing to do    ← dead end, row untouched
      │                │
      ▼              true
                       ▼
                Mark processing ──▶ publish…
```

**A row that isn't due yet is left completely alone** — nothing written back at all. It
keeps `post status: queued` and gets re-checked on the next sweep. That's the whole
mechanism. The sweep itself now lives in Apps Script, not here.

**The read is filtered on `post status = queued`, not on `status`.** That matters for
scale: `status` stays on `Publish` forever after a post goes out, so filtering on it would
re-fetch every row ever published, on every sweep, growing without limit. Filtering on
`queued` means the query only ever returns work that still needs doing — the sweep costs
the same whether the sheet holds 10 rows or 10,000. Approval is then checked in code, since
`Prepare jobs` has the row in hand anyway.

A consequence worth knowing: **a row with a blank `post status` is never fetched.** Apps
Script fills it automatically, so this only affects rows added by hand — type `queued` into
that cell and the next sweep picks them up.

Consequences worth knowing:

- **You can reschedule or cancel from the sheet.** Change `Post At` before it fires and the
  new time is what counts. Change `status` away from `Publish` and it never fires.
- **A missed window still publishes.** If n8n is down at the scheduled minute, the row goes
  out on the first sweep after it comes back, not never.
- **Blank `Post At` publishes on the next sweep.** The form always fills it, so this only
  affects rows created before scheduling existed or added by hand — they aren't stranded.
- **An unreadable `Post At` fails the row** rather than publishing immediately. `Result`
  quotes the offending value.
- Validity is checked *before* the schedule, so a row with no caption fails right away
  instead of failing a week later.

`Prepare jobs` accepts an ISO string with `Z` or an offset, a Sheets serial date, or a real
date value, so a hand-typed cell still works.

## How v2 behaves

`post status` — n8n's column. Blank means "not touched yet".

| Value | Means |
|---|---|
| `queued` | waiting. Either `status` isn't `Publish` yet, or `post at` hasn't arrived |
| *(blank)* | added by hand — **never fetched**; set it to `queued` |
| `processing` | claimed by a run, so an overlapping sweep can't publish it twice |
| `posted` | every selected platform confirmed live |
| `partial` | some platforms went out, some didn't — `result` names which |
| `submitted` | accepted, but still publishing when we checked 25 s later |
| `failed` | nothing went out |

`result` always lists every platform, e.g.:

```
facebook: posted — https://facebook.com/... | instagram: posted — https://instagram.com/p/...
| twitter: skipped — caption is 412 characters, twitter allows 280
| youtube: failed — quota exceeded
```

**One upload, five posts.** The Drive file is pushed to Blotato once per row and the
returned CDN URL is reused by every platform — not re-uploaded per channel.

**Publishing is asynchronous.** `Post: Create` returns a `postSubmissionId`, not a live
post. The workflow waits 25 s and calls `Post: Get`, which returns
`status: in-progress | published | failed` plus `publicUrl` or `errorMessage`. A platform
left at `submitted` isn't an error — it just hadn't finished. Raise the **Wait for publish**
node if you see that a lot.

**Bad combinations are caught before the API call**, with the exact reason, instead of
failing with a vague error:

- YouTube with an image — YouTube takes video only.
- A caption longer than the platform allows, using the same limits the form warns about
  (Facebook 63,206 · Instagram 2,200 · X 280 · LinkedIn 3,000 · YouTube 5,000). The caption
  is never silently truncated; that platform is skipped and the others still publish.
- A failed media upload — every platform for that row is skipped with the upload error.

**Platform specifics as the node applies them:**

| | |
|---|---|
| Facebook | `pageId` required; `mediaType` (`reel`/`video`) applied to video only |
| Instagram | images go to the feed; video uses `reel` or `story` |
| X | no extra parameters |
| LinkedIn | posts as the person unless you add a Company Page in Options |
| YouTube | title from the sheet's `YouTube Title`, falling back to the first 95 characters of the caption; privacy from `YouTube Privacy`, defaulted to `private` |

### Resetting a stuck row

If n8n dies mid-run a row can sit at `processing` forever. **Set `post status` back to
`queued`** and the next sweep retries it (`status` is already `Publish`). Don't clear the
cell — a blank one is never fetched.

Nothing dedupes against already-published posts, so only do that for rows you know didn't
go out — and a retry re-publishes to *every* ticked platform, including ones that already
succeeded.

To cancel a row before it fires, move `status` away from `Publish`, or clear `post at` and
change your mind — either way n8n stops considering it.

---

## Known limits

- **Blotato has to be able to fetch the Drive file.** Both workflows pass
  `https://drive.google.com/uc?export=download&id=<fileId>`. The node's own guidance is to
  use URL upload for Google Drive, good to roughly 60 MB; past Google's virus-scan
  threshold the link returns an HTML interstitial instead of bytes and the row fails with a
  clear message. If an *image* fails, try `https://lh3.googleusercontent.com/d/<fileId>` —
  change the `mediaUrl` line in **Prepare jobs**.
- **The file must be shared "anyone with the link"**, which is what the form already asks
  for. A restricted file fails at the upload step.
- **One status check, not a poll loop.** Still `in-progress` after the wait → that platform
  reads `submitted` and stays there.
- **No retry**, and no per-platform retry — a failed row stays failed until you reset it.
- **Scheduling granularity is one minute**, set by the sweep interval. A row fires on the
  first sweep at or after its time, so expect up to ~60 s of lag.
- **Untested against live credentials.** Node type, parameter names, per-platform required
  fields, and response shapes were read from the published package
  (`@blotato/n8n-nodes-blotato@1.0.10`) rather than guessed. The graph validates — 35 nodes,
  no dangling connections, both Merge nodes fully wired, every expression parses, and the
  schedule gate was exercised against past/future/offset/blank/serial/garbage values — but I
  have no Blotato key here, so treat your first run as a smoke test.

## Sources

- [`@blotato/n8n-nodes-blotato` on npm](https://www.npmjs.com/package/@blotato/n8n-nodes-blotato) · [GitHub](https://github.com/Blotato-Inc/n8n-nodes-blotato) · [n8n integration page](https://n8n.io/integrations/blotato/)
- [Blotato — n8n node docs](https://help.blotato.com/api/n8n/n8n-blotato-node)
- [Blotato — Publish Post `/v2/posts`](https://help.blotato.com/api/publish-post) · [Upload Media `/v2/media`](https://help.blotato.com/api/publish-post/upload-media-v2-media) · [API Quickstart](https://help.blotato.com/api/start)
