/**
 * AutoPost — receives form submissions and appends them to the sheet.
 *
 * SETUP (one time, ~2 minutes):
 *  1. Open the sheet: https://docs.google.com/spreadsheets/d/1BDhyws9fM__wv7ygjkEepmB_psVh7QOoFk_x3ZsR48k/edit
 *  2. Extensions > Apps Script. Delete whatever is in Code.gs and paste this whole file.
 *  3. Save, then Deploy > New deployment > gear icon > Web app.
 *       Execute as:      Me
 *       Who has access:  Anyone            <-- required, the browser posts anonymously
 *  4. Deploy > authorize when prompted > copy the /exec URL it gives you.
 *  5. Paste that URL into SHEET_ENDPOINT near the top of index.html and review.html.
 *  6. Fill in SUPABASE_URL and SUPABASE_KEY below, and the matching pair in both
 *     pages. Until you do, this endpoint refuses every request.
 *
 * After ANY edit here you must Deploy > Manage deployments > edit > Version: New version.
 * Editing the code alone does NOT update the live URL.
 *
 * Sign-in added a new permission (calling supabase.co). Google asks for it the
 * first time the code RUNS, not when you deploy — so if requests start failing
 * with an authorization error, open the editor, Run > verifyUser, and approve.
 */

var SHEET_ID    = '1BDhyws9fM__wv7ygjkEepmB_psVh7QOoFk_x3ZsR48k';
var SHEET_NAME  = '';   // leave blank to use the first tab
/* Must match AUTH_TOKEN in index.html. This is NOT a real secret — it ships in
   the page source, so anyone who views source can read it. What it does buy you
   is that a bot hitting the /exec URL directly, without ever loading the page,
   gets rejected. For actual access control put the page behind Vercel's
   Deployment Protection. Change this string any time; change both files. */
var SHARED_TOKEN = 'ap_5iLo88aF_oQ0NG-hh1JKxDUi';

/* ============================================================
   SUPABASE SIGN-IN  <-- FILL THESE IN
   ============================================================
   The pages are static files: anyone can view source, read SHARED_TOKEN and
   POST here without ever seeing the login screen. So the login has to be
   checked HERE, not in the browser — every action below is refused unless it
   carries an access token Supabase agrees is real.

   Both values are safe to paste in: the URL is public and the publishable key
   is designed to ship in a web page. Copy them from
   Supabase dashboard > Project Settings > API.

   The key is named "anon public" on older projects and "publishable"
   (sb_publishable_...) on newer ones — either works, they go in the same slot.
   Do NOT paste the service_role / secret key: it bypasses every rule you set.

   Leave these blank and the endpoint refuses everything. That is deliberate —
   a half-configured login should fail shut, not open. */
var SUPABASE_URL = 'https://fhwqqekzkfxipqnmmqju.supabase.co';          // e.g. https://abcdefgh.supabase.co   (no trailing slash)
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZod3FxZWt6a2Z4aXBxbm1tcWp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTQ1MjIsImV4cCI6MjEwMTE3MDUyMn0.f0P891eCLzH_zm6QzQEdiCIcFs_ycOrT22xNWsE4-Qc';          // the anon / publishable key

/* ============================================================
   n8n WEBHOOK  <-- FILL THESE IN
   ============================================================
   n8n bills per execution, and a Schedule Trigger counts every time it fires
   "regardless of outcome". Once a minute is ~43,800 executions a month, which
   burns a 2,500 plan in under two days — and almost every one of those finds
   nothing to do.

   So the clock moves here. A time-driven trigger in this script checks whether
   anything is actually due and only then calls n8n. Apps Script triggers cost
   nothing, so n8n runs about as often as you publish.

   SECRET: whoever knows the URL can make your accounts post. n8n's Webhook
   node supports Header Auth — create that credential in n8n with the same
   header name and value below, and select it on the node.

   Leave the URL blank and nothing is called; the sweep just does nothing. */
var N8N_WEBHOOK_URL    = '';                 // https://<you>.app.n8n.cloud/webhook/autopost-sweep
var N8N_WEBHOOK_HEADER = 'x-autopost-key';   // must match the Header Auth credential in n8n
var N8N_WEBHOOK_SECRET = '';                 // must match it too

/* Two things can ask n8n to run: the minute sweep, and approving a post that
   is already due. Without a gap between calls both could fire at once and two
   runs could read the same row before either claimed it. n8n marks a row
   'processing' within a few seconds, so a short quiet period is enough for the
   second call to find nothing left to do. */
var PING_DEBOUNCE_SECONDS = 90;

/* Daily ceilings, counted per UTC day. The endpoint is public and now writes
   files into Drive, so an unbounded one is an invitation to fill it. */
var MAX_ROWS_PER_DAY    = 200;
var MAX_UPLOADS_PER_DAY = 50;

/* Instagram and LinkedIn cap carousels at 10; the form enforces the same. */
var MAX_MEDIA = 10;

/* Ceilings on the sign-in check. The endpoint is public, so it needs its own
   limits: fails slow down anyone throwing tokens at it, calls guard the
   script's daily execution quota — which submissions share. */
var MAX_AUTH_CALLS_PER_DAY = 2000;
var MAX_AUTH_FAILS_PER_DAY = 50;

/* How long a verified token is trusted without asking Supabase again. Tokens
   live an hour by default, so five minutes is a large saving on round trips
   and a small window in which a just-deleted user still gets through. */
var AUTH_CACHE_SECONDS = 300;

/* This script's only job is to append the row. n8n polls the sheet on its own
   schedule and decides when to publish — nothing here talks to n8n. */

/* What a fresh submission lands as. The `status` dropdown holds exactly two
   values: 'For review' (held) and 'Publish' (n8n picks it up). This must be
   the held one — a human moves the row to 'Publish' after reviewing.
   CHANGING THIS FILE IS NOT ENOUGH: redeploy as a NEW VERSION or the live
   /exec URL keeps running the old code. */
var NEW_STATUS = 'For review';

/* The value a human moves a row to when they approve it. n8n filters on this,
   so it must match the workflow and the sheet's dropdown exactly. */
var PUBLISH_STATUS = 'Publish';

/* Approving used to need a separate typed-in key. Supabase sign-in replaced it:
   being signed in IS the permission, and unlike a shared key it says WHO
   approved and can be revoked for one person without changing anything for
   everyone else. Nothing to configure here. */

/* What a fresh row's `post status` says. n8n's sheet read filters on exactly
   this value, so published rows drop out of the query entirely instead of being
   re-fetched on every sweep forever. Must match the filter in the workflow. */
var QUEUED_STATUS = 'queued';

/* What n8n writes the moment it CLAIMS a row, before it starts publishing.
   Must match "Mark processing" in the workflow. A row sitting here is either
   mid-flight or was abandoned by a run that died — either way n8n will never
   look at it again, because its sheet read only fetches 'queued'. The review
   page can hand such a row back with the `requeue` action. */
var WORKING_STATUS = 'processing';

/* How long a row may sit at WORKING_STATUS before the review page calls it
   stuck. Comfortably longer than a real publish, which is ~30 seconds. */
var STUCK_AFTER_MINUTES = 15;

/* Row ceilings for the review page.
   Anything the automation has NOT finished is work, and work must never
   silently vanish off the end of the list — that is the only route it has to
   being published. Finished rows are just context, so they stay capped. */
var MAX_PENDING_ROWS = 200;
var MAX_HANDLED_ROWS = 25;

/* Per file AND across one submission. Uploads travel base64-encoded, which adds
   about a third, and an Apps Script web app rejects requests over roughly
   50 MB — so ten 20 MB files was never actually possible. Failing here, before
   the browser spends a minute encoding, beats failing at the end. */
var MAX_TOTAL_UPLOAD_MB = 30;

/* Uploaded files land here, in the Drive of whoever deployed this script.
   Created on first use. Every file is link-shared, because the automation
   fetches it over the public internet. */
var UPLOAD_FOLDER = 'AutoPost uploads';
var MAX_UPLOAD_MB = 20;

/* Bump this whenever you change this file. Opening the /exec URL in a browser
   shows the version that is actually LIVE — which is the deployed one, not the
   one in the editor. If it doesn't match, the deployment wasn't updated. */
var VERSION = '13-webhook';

/* Ceiling on a caption edited from the review page. Well above every network's
   own limit (Facebook's 63,206 is the largest) but far below the 50,000-char
   cell limit, so one paste can't wedge the sheet. */
var MAX_CAPTION_CHARS = 20000;

/* Column headers are matched case-insensitively against these aliases.
   Add a column to the sheet with any of these names and it fills itself in. */
var FIELD_ALIASES = {
  driveUrl:   ['gdrive url', 'drive url', 'google drive url', 'gdrive', 'url', 'link', 'media'],
  driveFileId:['file id', 'fileid', 'drive file id', 'gdrive id'],
  caption:    ['caption', 'text', 'post caption', 'message', 'content'],
  platforms:  ['platforms', 'channels', 'accounts', 'social'],
  ytTitle:    ['youtube title', 'yt title', 'video title', 'title'],
  ytPrivacy:  ['youtube privacy', 'yt privacy', 'visibility', 'privacy'],
  status:     ['status', 'state'],
  postStatus: ['post status', 'automation status', 'publish status'],
  scheduledAt:['post at', 'publish at', 'schedule', 'scheduled', 'scheduled at', 'post date', 'publish date'],
  timezone:   ['timezone', 'time zone', 'tz'],
  timestamp:  ['timestamp', 'date', 'submitted', 'submitted at', 'created', 'time'],
  /* Optional. Add either column to the sheet and it fills itself in with the
     signed-in address — the audit trail a shared key could not give you. */
  submittedBy:['submitted by', 'created by', 'author'],
  approvedBy: ['approved by', 'approver', 'reviewed by'],
  /* Written by n8n — when it claimed the row, then when it finished. The review
     page reads it to work out whether a claimed row is mid-flight or stranded. */
  processedAt:['processed at', 'processed', 'published at']
};

/* A column named after a platform gets TRUE / blank. */
var PLATFORM_COLUMNS = {
  facebook:  'facebook',
  instagram: 'instagram',
  twitter:   'twitter',
  'x':       'twitter',
  'x / twitter': 'twitter',
  'twitter / x': 'twitter',
  linkedin:  'linkedin',
  youtube:   'youtube'
};

function doPost(e) {
  var lock = LockService.getScriptLock();   // serialize concurrent submits
  try {
    lock.waitLock(20000);

    if (!e || !e.postData || !e.postData.contents) {
      return respond({ ok: false, error: 'Empty request body.' });
    }
    var body = JSON.parse(e.postData.contents);

    if (SHARED_TOKEN && body.token !== SHARED_TOKEN) {
      return respond({ ok: false, error: 'Unauthorized.' });
    }

    /* Approvals ride the same transport as submissions — text/plain POST keeps
       this a "simple request", which is the only kind an Apps Script web app
       can answer without a CORS preflight. */
    /* Everything past this line requires a signed-in user — submitting
       included. The pages are static files, so this is the only place the
       question can actually be answered. */
    var user = verifyUser(body);
    if (user.error) return respond({ ok: false, error: user.error, signedOut: true });

    var action = body.action || 'submit';
    if (action === 'list')      return respond(listRows(body));
    if (action === 'setStatus') return respond(setRowStatus(body, user));
    if (action === 'update')    return respond(updateRow(body));
    if (action === 'requeue')   return respond(requeueRow(body));
    if (action === 'delete')    return respond(deleteSheetRow(body));

    /* Anything else is NOT a submission. Falling through used to mean a newer
       page calling an action this deployment does not have yet got validated
       as a new post, and answered "at least one image and a caption are
       required" — which is true, and tells you nothing about what went wrong.
       Name the action and the version instead: that identifies a stale
       deployment on sight. */
    if (action !== 'submit') {
      return respond({
        ok: false,
        error: 'This endpoint does not know the action "' + action + '". It is running ' +
               VERSION + ' — redeploy AppsScript.gs as a NEW VERSION.',
        unknownAction: action,
        version: VERSION
      });
    }

    var items = body.media || [];
    if (items.length > MAX_MEDIA) {
      return respond({ ok: false, error: 'At most ' + MAX_MEDIA + ' media items per post.' });
    }

    var tooBig = checkTotalUpload(items);
    if (tooBig) return respond({ ok: false, error: tooBig });

    var overQuota = checkQuota(countUploads(items));
    if (overQuota) return respond({ ok: false, error: overQuota });

    var resolved = resolveMedia(items);
    if (!resolved.ok) return respond({ ok: false, error: resolved.error });
    if (resolved.urls.length) {
      body.driveUrl = resolved.urls.join(', ');
      body.driveFileId = resolved.ids.join(', ');
    }

    if (!body.driveUrl || !body.caption) {
      return respond({ ok: false, error: 'At least one image or video, plus a caption, are required.' });
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (!sheet) return respond({ ok: false, error: 'Sheet "' + SHEET_NAME + '" not found.' });

    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                       .map(function (h) { return String(h).trim().toLowerCase(); });

    var platforms = body.platforms || [];
    var row = headers.map(function (h) { return cellFor(h, body, platforms); });

    sheet.appendRow(row);

    /* Free text goes in afterwards, into cells forced to text format, so a
       caption that opens with "=" lands as a caption and not as a formula. */
    var newRow = sheet.getLastRow();
    writeTextField(sheet, headers, newRow, FIELD_ALIASES.caption, body.caption || '');
    writeTextField(sheet, headers, newRow, FIELD_ALIASES.ytTitle,
                   body.youtube ? body.youtube.title : '');
    writeTextField(sheet, headers, newRow, FIELD_ALIASES.submittedBy, user.email);

    var scheduleStored = writeSchedule(sheet, headers, newRow, body.scheduledAt);

    return respond({
      ok: true,
      row: sheet.getLastRow(),
      platforms: platforms.length,
      scheduledAt: body.scheduledAt || '',
      scheduleStored: scheduleStored   // false => the sheet has no "post at" column
    });

  } catch (err) {
    return respond({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** Decide what goes in a column, based on that column's header text. */
function cellFor(header, body, platforms) {
  if (!header) return '';

  // platform column -> TRUE when that platform was selected
  var platformKey = PLATFORM_COLUMNS[header];
  if (platformKey) {
    return platforms.indexOf(platformKey) > -1 ? 'TRUE' : '';
  }

  if (matches(header, FIELD_ALIASES.timestamp))   return new Date();
  if (matches(header, FIELD_ALIASES.driveUrl))    return body.driveUrl || '';
  if (matches(header, FIELD_ALIASES.driveFileId)) return body.driveFileId || '';
  if (matches(header, FIELD_ALIASES.caption))     return '';   // written as text below
  if (matches(header, FIELD_ALIASES.platforms))   return platforms.join(', ');
  if (matches(header, FIELD_ALIASES.ytTitle))     return '';   // written as text below
  if (matches(header, FIELD_ALIASES.ytPrivacy))   return body.youtube ? body.youtube.privacy : '';
  if (matches(header, FIELD_ALIASES.scheduledAt)) return '';   // written as text below
  if (matches(header, FIELD_ALIASES.timezone))    return body.timezone || '';
  if (matches(header, FIELD_ALIASES.status))      return NEW_STATUS;
  /* n8n reads ONLY rows sitting at this marker, so a published row is never
     fetched again — the sweep stays the same size however big the sheet gets. */
  if (matches(header, FIELD_ALIASES.postStatus))  return QUEUED_STATUS;

  return '';   // unknown column: leave it alone
}

/* ============================================================
   THE CLOCK — decides when n8n runs, so n8n stops running for nothing
   ============================================================ */

/**
 * RUN THIS ONCE from the editor to start the schedule.
 *   toolbar function dropdown > installSweep > Run
 * Running it again is safe — it replaces the trigger rather than adding one.
 */
function installSweep() {
  removeSweep();
  ScriptApp.newTrigger('sweep').timeBased().everyMinutes(1).create();
  Logger.log('Sweep installed: checks every minute, calls n8n only when a post is due.');
}

/** Stop the schedule. Nothing will publish until installSweep() runs again. */
function removeSweep() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sweep') ScriptApp.deleteTrigger(t);
  });
}

/** Run from the editor to see what the sweep can see. Changes nothing. */
function sweepStatus() {
  var installed = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'sweep';
  });
  var due = dueRows();
  Logger.log([
    'trigger installed : ' + installed,
    'webhook configured: ' + !!(N8N_WEBHOOK_URL && N8N_WEBHOOK_SECRET),
    'last sweep        : ' + (PropertiesService.getScriptProperties().getProperty('lastSweepAt') || 'never'),
    'due right now     : ' + (due.length ? due.join(', ') : 'nothing')
  ].join('\n'));
}

/** Read a schedule cell the same three ways the sheet can hand one back. */
function parseWhen(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {                     // Sheets serial date
    return new Date(Math.round((v - 25569) * 86400000));
  }
  var d = new Date(String(v).trim());
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Rows that would publish if n8n ran right now: approved, unclaimed, and due.
 *
 * Deliberately the same test n8n applies, so a sweep that says "nothing" means
 * a run really would have found nothing. An unreadable date counts as due, so
 * n8n gets the chance to report it as an error rather than it sitting silent.
 */
function dueRows() {
  var sheet = openSheet();
  if (!sheet) return [];

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });

  var cStatus = colIndex(headers, FIELD_ALIASES.status);
  var cPost   = colIndex(headers, FIELD_ALIASES.postStatus);
  var cWhen   = colIndex(headers, FIELD_ALIASES.scheduledAt);
  if (cStatus < 0) return [];

  var now = new Date().getTime(), out = [];
  for (var r = 2; r <= lastRow; r++) {
    var v = values[r - 1];
    if (String(v[cStatus]).trim().toLowerCase() !== PUBLISH_STATUS.toLowerCase()) continue;

    var ps = cPost > -1 ? String(v[cPost]).trim().toLowerCase() : '';
    if (ps && ps !== QUEUED_STATUS) continue;          // claimed or finished

    if (cWhen > -1) {
      var raw = v[cWhen];
      var has = raw !== '' && raw !== null && raw !== undefined;
      if (has) {
        var at = parseWhen(raw);
        if (at && at.getTime() > now) continue;        // not yet
      }
    }
    out.push(r);
  }
  return out;
}

/**
 * Ask n8n to run. '' when it went, otherwise why it did not.
 *
 * Debounced: two callers can decide work exists at almost the same moment, and
 * a second run reading the same unclaimed rows would publish them twice.
 */
function pingN8n(reason, rows) {
  if (!N8N_WEBHOOK_URL || !N8N_WEBHOOK_SECRET) return 'n8n webhook is not configured.';

  var cache = CacheService.getScriptCache();
  if (cache.get('n8nPing')) return 'skipped — n8n was called moments ago.';
  cache.put('n8nPing', '1', PING_DEBOUNCE_SECONDS);

  var headers = {};
  headers[N8N_WEBHOOK_HEADER] = N8N_WEBHOOK_SECRET;

  try {
    var res = UrlFetchApp.fetch(N8N_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      /* n8n does not need these — it re-reads the sheet itself — but they make
         an execution traceable back to why it started. */
      payload: JSON.stringify({ reason: reason, rows: rows || [], at: new Date().toISOString() }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return '';

    /* Let the next sweep try again rather than sitting out the debounce. */
    cache.remove('n8nPing');
    return 'n8n returned HTTP ' + code + '. ' +
           (code === 403 || code === 401 ? 'Check the header auth matches.' : '') ;
  } catch (err) {
    cache.remove('n8nPing');
    return 'Could not reach n8n: ' + String(err && err.message || err);
  }
}

/**
 * The trigger target. Runs every minute, costs n8n nothing unless there is
 * something to publish.
 *
 * NOTE: this script is now the only thing that starts a publish. If the
 * trigger is deleted or the project loses authorization, nothing publishes and
 * nothing says so — which is what `lastSweepAt` in doGet is for.
 */
function sweep() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;        // a submission or another sweep holds it; next minute will do
  try {
    PropertiesService.getScriptProperties().setProperty('lastSweepAt', new Date().toISOString());
    var rows = dueRows();
    if (!rows.length) return;             // the whole point: no n8n execution
    var problem = pingN8n('due', rows);
    if (problem) Logger.log('sweep: ' + problem);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/* ============================================================
   SIGN-IN — every action above and below is gated on this
   ============================================================ */

/**
 * Who is calling — { email, id } when the token is real, { error } otherwise.
 *
 * Asks Supabase rather than checking the signature here. Supabase signs tokens
 * with HS256 on older projects and asymmetric keys on newer ones, and rotates
 * them; /auth/v1/user is right under every one of those and does not care.
 *
 * There is no allowlist to maintain: with public sign-up disabled, the only
 * accounts that exist are the ones you created, so "Supabase says this token is
 * valid" already means "this is someone you invited". Deleting the user in the
 * dashboard revokes them.
 */
function verifyUser(body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { error: 'Sign-in is not set up on the server yet. Fill in SUPABASE_URL and SUPABASE_KEY.' };
  }

  var token = String(body.accessToken || '');
  if (!token || token.length > 4096) return { error: 'Please sign in.' };

  var props = PropertiesService.getScriptProperties();
  var q = readQuota(props);
  if (q.authFail >= MAX_AUTH_FAILS_PER_DAY) {
    return { error: 'Too many failed sign-ins today. Try again tomorrow.' };
  }
  if (q.authCall >= MAX_AUTH_CALLS_PER_DAY) {
    return { error: 'This endpoint has hit its daily limit. Try again tomorrow.' };
  }

  /* Cache on a digest, never the token itself: cache keys top out at 250 chars
     and a JWT is longer, and a raw token does not belong in a shared cache. */
  var cache = CacheService.getScriptCache();
  var slot = 'u_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(slot);
  if (hit) {
    try { return JSON.parse(hit); } catch (ignored) {}
  }

  q.authCall += 1;
  var res;
  try {
    res = UrlFetchApp.fetch(SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      method: 'get',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
  } catch (err) {
    writeQuota(props, q);
    return { error: 'Could not reach Supabase to check your sign-in.' };
  }

  if (res.getResponseCode() !== 200) {
    q.authFail += 1;
    writeQuota(props, q);
    return { error: 'Your session has expired. Sign in again.' };
  }

  var user;
  try { user = JSON.parse(res.getContentText()); }
  catch (err) { writeQuota(props, q); return { error: 'Supabase sent back something unreadable.' }; }

  writeQuota(props, q);
  if (!user || !user.id) return { error: 'Your session has expired. Sign in again.' };

  var who = { email: String(user.email || ''), id: String(user.id) };
  cache.put(slot, JSON.stringify(who), AUTH_CACHE_SECONDS);
  return who;
}

function openSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

/** Index of the first column matching any of these aliases, or -1. */
function colIndex(headers, aliases) {
  for (var i = 0; i < headers.length; i++) {
    if (matches(headers[i], aliases)) return i;
  }
  return -1;
}

/**
 * Rows for the review page.
 *
 * Split deliberately. A row the automation has not finished with is WORK: the
 * only way it ever publishes is somebody approving it here, so it must never
 * fall off the end of the list — this used to return "the newest 25", which
 * meant the 26th pending post could not be approved from the app at all.
 * Finished rows are only context, so those stay capped.
 */
function listRows(body) {
  var sheet = openSheet();
  if (!sheet) return { ok: false, error: 'Sheet not found.' };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, rows: [] };

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });

  var cDrive  = colIndex(headers, FIELD_ALIASES.driveUrl);
  var cCap    = colIndex(headers, FIELD_ALIASES.caption);
  var cStatus = colIndex(headers, FIELD_ALIASES.status);
  var cPost   = colIndex(headers, FIELD_ALIASES.postStatus);
  var cWhen   = colIndex(headers, FIELD_ALIASES.scheduledAt);
  var cBy     = colIndex(headers, FIELD_ALIASES.approvedBy);
  var cAt     = colIndex(headers, FIELD_ALIASES.processedAt);
  var cResult = -1;
  for (var h = 0; h < headers.length; h++) if (headers[h] === 'result') cResult = h;

  /* The whole sheet is already in memory, so scanning all of it costs nothing
     extra — the old cap only ever trimmed the reply. */
  var rows = [], handled = 0, dropped = 0;
  for (var r = lastRow; r >= 2; r--) {
    var v = values[r - 1];
    var ps = (cPost > -1 ? String(v[cPost]) : '').trim().toLowerCase();
    var open = !ps || ps === QUEUED_STATUS || ps === WORKING_STATUS;

    if (open) {
      if (rows.length - handled >= MAX_PENDING_ROWS) { dropped++; continue; }
    } else {
      if (handled >= MAX_HANDLED_ROWS) continue;
      handled++;
    }

    rows.push({
      row: r,
      driveUrl:   cDrive  > -1 ? String(v[cDrive])  : '',
      caption:    cCap    > -1 ? String(v[cCap])    : '',
      status:     cStatus > -1 ? String(v[cStatus]) : '',
      postStatus: cPost   > -1 ? String(v[cPost])   : '',
      scheduledAt: cWhen  > -1 ? String(v[cWhen])   : '',
      result:     cResult > -1 ? String(v[cResult]) : '',
      approvedBy: cBy     > -1 ? String(v[cBy])     : '',
      processedAt: cAt    > -1 ? String(v[cAt])     : '',
      platforms: platformsIn(headers, v)
    });
  }
  return {
    ok: true,
    rows: rows,
    statuses: [NEW_STATUS, PUBLISH_STATUS],
    working: WORKING_STATUS,
    stuckAfterMinutes: STUCK_AFTER_MINUTES,
    /* >0 means work is being hidden. Say so rather than looking complete. */
    dropped: dropped,
    editable: colIndex(headers, FIELD_ALIASES.caption) > -1
  };
}

/**
 * Which platforms a row targets.
 *
 * Two sheet shapes are in the wild and both are valid: one TRUE column per
 * platform, or a single "platforms" column holding a comma-separated list.
 * Read the TRUE columns first, then fall back to the text column — a sheet with
 * only the text column used to come back with no platforms at all.
 */
function platformsIn(headers, v) {
  var plats = [];
  for (var c = 0; c < headers.length; c++) {
    var key = PLATFORM_COLUMNS[headers[c]];
    if (key && String(v[c]).trim().toLowerCase() === 'true' && plats.indexOf(key) === -1) {
      plats.push(key);
    }
  }
  if (plats.length) return plats;

  var cList = colIndex(headers, FIELD_ALIASES.platforms);
  if (cList < 0) return plats;
  String(v[cList]).split(',').forEach(function (part) {
    var key = PLATFORM_COLUMNS[part.trim().toLowerCase()];
    if (key && plats.indexOf(key) === -1) plats.push(key);
  });
  return plats;
}

/**
 * Resolve `body.row` to a real, still-changeable row.
 *
 * Returns { error } or { row, headers }. Once the automation has taken a row
 * nothing here is worth writing: n8n reads on `post status`, so editing a
 * posted row would change the sheet without changing the post.
 */
function openEditableRow(body) {
  var sheet = openSheet();
  if (!sheet) return { error: 'Sheet not found.' };

  var row = Number(body.row);
  var lastRow = sheet.getLastRow();
  if (!(row >= 2 && row <= lastRow)) return { error: 'Row ' + body.row + ' is out of range.' };

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                     .map(function (h) { return String(h).trim().toLowerCase(); });

  var cPost = colIndex(headers, FIELD_ALIASES.postStatus);
  if (cPost > -1) {
    var ps = String(sheet.getRange(row, cPost + 1).getValue()).trim().toLowerCase();
    if (ps === WORKING_STATUS) {
      var cAt = colIndex(headers, FIELD_ALIASES.processedAt);
      var at  = cAt > -1 ? sheet.getRange(row, cAt + 1).getValue() : '';
      return { error: inFlight(ps, at, cAt > -1)
        ? 'Row ' + row + ' is being published right now. Try again in a minute.'
        : 'Row ' + row + ' was claimed by a run that never finished. Requeue it first, then edit it.' };
    }
    if (ps && ps !== QUEUED_STATUS) {
      return { error: 'Row ' + row + ' was already handled (' + ps + ').' };
    }
  }
  return { sheet: sheet, row: row, headers: headers };
}

/**
 * Hand a stuck row back to the automation.
 *
 * n8n claims a row by writing WORKING_STATUS, then publishes, then writes the
 * outcome. If the run dies in between, the row is stranded: n8n's sheet read
 * only fetches 'queued', so it is never picked up again, and every edit path
 * here refuses it because it looks claimed. Nothing else in the system can free
 * it — which made a dropped run a permanent, silent loss.
 *
 * Only WORKING_STATUS is resettable. A row that reached a real outcome
 * (posted, failed) is history, and re-running it would publish twice.
 */
function requeueRow(body) {
  var sheet = openSheet();
  if (!sheet) return { ok: false, error: 'Sheet not found.' };

  var row = Number(body.row);
  var lastRow = sheet.getLastRow();
  if (!(row >= 2 && row <= lastRow)) return { ok: false, error: 'Row ' + body.row + ' is out of range.' };

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                     .map(function (h) { return String(h).trim().toLowerCase(); });

  var cPost = colIndex(headers, FIELD_ALIASES.postStatus);
  if (cPost < 0) return { ok: false, error: 'No "post status" column in this sheet.' };

  var ps = String(sheet.getRange(row, cPost + 1).getValue()).trim().toLowerCase();
  if (ps !== WORKING_STATUS) {
    return { ok: false, error: ps === QUEUED_STATUS || !ps
      ? 'Row ' + row + ' is already waiting to be picked up.'
      : 'Row ' + row + ' already finished (' + ps + ') — requeuing it would post it twice.' };
  }

  writeCell(sheet, row, cPost, QUEUED_STATUS, true);

  /* Clear the stale outcome so the row does not carry a message from the run
     that died into the run that succeeds. */
  for (var i = 0; i < headers.length; i++) {
    if (headers[i] === 'result') { writeCell(sheet, row, i, '', true); break; }
  }
  return { ok: true, row: row };
}

/**
 * Is the automation actually holding this row *right now*?
 *
 * The WORKING_STATUS marker on its own does not answer that. A run that died
 * leaves it behind permanently, and treating those as live made the queue
 * deadlock: a stranded row blocked deletion of everything above it, and could
 * not be deleted itself either.
 *
 * A live claim is one stamped within the last STUCK_AFTER_MINUTES. The
 * workflow writes that stamp at the moment it claims a row, so a claim with no
 * stamp predates the stamping and is definitely stale. Without the column at
 * all there is no way to tell, so assume it is live and stay safe.
 */
function inFlight(postStatus, processedAt, haveStampColumn) {
  if (String(postStatus).trim().toLowerCase() !== WORKING_STATUS) return false;
  if (!haveStampColumn) return true;

  var at = processedAt instanceof Date ? processedAt : new Date(String(processedAt));
  if (!processedAt || isNaN(at.getTime())) return false;
  return (new Date().getTime() - at.getTime()) < STUCK_AFTER_MINUTES * 60000;
}

/**
 * Delete a row outright.
 *
 * Two hazards, both handled here rather than trusted to the page:
 *
 * 1. Deleting shifts every row BELOW it up by one, and n8n addresses rows by
 *    number — it reads row_number, publishes for ~30 s, then writes the result
 *    back to that number. A delete inside that window makes it stamp the wrong
 *    row. So: refuse while anything below is mid-publish.
 * 2. The page is working from a list it fetched some time ago. If the sheet
 *    moved since, "row 6" is no longer the row the person looked at. So the
 *    caller sends what it believes is there and we check before deleting.
 */
function deleteSheetRow(body) {
  var sheet = openSheet();
  if (!sheet) return { ok: false, error: 'Sheet not found.' };

  var row = Number(body.row);
  var lastRow = sheet.getLastRow();
  if (!(row >= 2 && row <= lastRow)) return { ok: false, error: 'Row ' + body.row + ' is out of range.' };

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });

  var cPost  = colIndex(headers, FIELD_ALIASES.postStatus);
  var cCap   = colIndex(headers, FIELD_ALIASES.caption);
  var cDrive = colIndex(headers, FIELD_ALIASES.driveUrl);
  var cAt    = colIndex(headers, FIELD_ALIASES.processedAt);

  var mine = values[row - 1];
  var live = function (r) {
    return inFlight(cPost > -1 ? values[r - 1][cPost] : '',
                    cAt  > -1 ? values[r - 1][cAt]  : '', cAt > -1);
  };

  if (live(row)) {
    return { ok: false, error: 'Row ' + row + ' is being published right now. Wait for it to finish.' };
  }

  /* Hazard 1. Only rows BELOW move, so only those matter — and only if one is
     genuinely running. A stranded claim is not holding anything. */
  for (var r = row + 1; r <= lastRow; r++) {
    if (live(r)) {
      return { ok: false, error: 'Row ' + r + ' is being published right now. Deleting row ' + row +
        ' would shift it, and the automation would write its result to the wrong row. ' +
        'Try again in a minute.' };
    }
  }

  /* Hazard 2. Compare against what the page displayed. */
  var norm = function (s) { return String(s == null ? '' : s).trim().slice(0, 120); };
  if (body.expect) {
    var wantCap = norm(body.expect.caption), wantUrl = norm(body.expect.driveUrl);
    var haveCap = cCap   > -1 ? norm(mine[cCap])   : '';
    var haveUrl = cDrive > -1 ? norm(mine[cDrive]) : '';
    if (wantCap !== haveCap || wantUrl !== haveUrl) {
      return { ok: false, error: 'Row ' + row + ' is not what your page is showing — the sheet changed. ' +
        'Refresh and try again.' };
    }
  }

  sheet.deleteRow(row);
  return { ok: true, row: row };
}

/** Flip one row between "held" and "approved". Nothing else is writable. */
function setRowStatus(body, user) {
  var status = String(body.status || '');
  if (status !== NEW_STATUS && status !== PUBLISH_STATUS) {
    return { ok: false, error: 'Status must be "' + NEW_STATUS + '" or "' + PUBLISH_STATUS + '".' };
  }

  var t = openEditableRow(body);
  if (t.error) return { ok: false, error: t.error };

  var cStatus = colIndex(t.headers, FIELD_ALIASES.status);
  if (cStatus < 0) return { ok: false, error: 'No status column in this sheet.' };

  t.sheet.getRange(t.row, cStatus + 1).setValue(status);

  /* Who signed off. This is the thing a shared key could never tell you —
     silently skipped when the sheet has no such column. */
  var by = colIndex(t.headers, FIELD_ALIASES.approvedBy);
  if (by > -1) {
    writeCell(t.sheet, t.row, by, status === PUBLISH_STATUS ? (user && user.email || '') : '', true);
  }

  /* Approving something already past its time should go out now, not on the
     next sweep. A future-dated post is left to the clock. */
  var pinged = false;
  if (status === PUBLISH_STATUS) {
    var cWhen = colIndex(t.headers, FIELD_ALIASES.scheduledAt);
    var at = cWhen > -1 ? parseWhen(t.sheet.getRange(t.row, cWhen + 1).getValue()) : null;
    if (!at || at.getTime() <= new Date().getTime()) {
      pinged = !pingN8n('approved', [t.row]);
    }
  }

  return { ok: true, row: t.row, status: status, pinged: pinged };
}

/**
 * Edit a queued row from the review page: caption, media, platforms, schedule.
 *
 * Deliberately NOT writable: `status` (that is setRowStatus, so approving stays
 * one explicit action) and `post status` (that belongs to n8n). Every field is
 * optional — only what the page sends gets touched.
 */
function updateRow(body) {
  var t = openEditableRow(body);
  if (t.error) return { ok: false, error: t.error };
  var sheet = t.sheet, row = t.row, headers = t.headers;

  var writes = [];   // [colIndex, value] — collected first so a bad field writes nothing
  /* Uploads only become Drive URLs here, so the page cannot know what it ended
     up with. Handing it back lets the queue update itself instead of
     re-fetching every row to learn one of them. */
  var savedDriveUrl = null;

  if (body.caption !== undefined) {
    var caption = String(body.caption);
    if (!caption.trim()) return { ok: false, error: 'The caption cannot be empty.' };
    if (caption.length > MAX_CAPTION_CHARS) {
      return { ok: false, error: 'Caption is longer than ' + MAX_CAPTION_CHARS + ' characters.' };
    }
    var cCap = colIndex(headers, FIELD_ALIASES.caption);
    if (cCap < 0) return { ok: false, error: 'No caption column in this sheet.' };
    writes.push([cCap, caption, true]);   // text-formatted: see writeCell
  }

  if (body.platforms !== undefined) {
    var wanted = [];
    (body.platforms || []).forEach(function (p) {
      var key = PLATFORM_COLUMNS[String(p).trim().toLowerCase()];
      if (key && wanted.indexOf(key) === -1) wanted.push(key);
    });
    if (!wanted.length) return { ok: false, error: 'Pick at least one platform.' };

    for (var c = 0; c < headers.length; c++) {
      var key = PLATFORM_COLUMNS[headers[c]];
      if (key) writes.push([c, wanted.indexOf(key) > -1 ? 'TRUE' : '']);
    }
    var cList = colIndex(headers, FIELD_ALIASES.platforms);
    if (cList > -1) writes.push([cList, wanted.join(', ')]);
  }

  /* Media arrives as the same ordered list the composer sends, so a replaced
     image is uploaded and shared exactly like a freshly composed one. */
  if (body.media !== undefined) {
    var items = body.media || [];
    if (!items.length) return { ok: false, error: 'A post needs at least one image or video.' };
    if (items.length > MAX_MEDIA) {
      return { ok: false, error: 'At most ' + MAX_MEDIA + ' media items per post.' };
    }
    var tooBig = checkTotalUpload(items);
    if (tooBig) return { ok: false, error: tooBig };

    var overQuota = checkUploadQuota(countUploads(items));
    if (overQuota) return { ok: false, error: overQuota };

    var resolved = resolveMedia(items);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (!resolved.urls.length) return { ok: false, error: 'None of that media could be resolved.' };

    var cDrive = colIndex(headers, FIELD_ALIASES.driveUrl);
    if (cDrive < 0) return { ok: false, error: 'No media column in this sheet.' };
    savedDriveUrl = resolved.urls.join(', ');
    writes.push([cDrive, savedDriveUrl]);

    var cId = colIndex(headers, FIELD_ALIASES.driveFileId);
    if (cId > -1) writes.push([cId, resolved.ids.join(', ')]);
  }

  if (!writes.length && body.scheduledAt === undefined) {
    return { ok: false, error: 'Nothing to change.' };
  }

  for (var w = 0; w < writes.length; w++) {
    writeCell(sheet, row, writes[w][0], writes[w][1], writes[w][2]);
  }

  /* Last, and on its own: the cell is forced to text first, or Sheets reads the
     ISO string back in the spreadsheet's own timezone and shifts the time. */
  var scheduleStored = true;
  if (body.scheduledAt !== undefined) {
    if (!body.scheduledAt) return { ok: false, error: 'Pick a publish time.' };
    if (isNaN(new Date(body.scheduledAt).getTime())) {
      return { ok: false, error: 'That publish time is not a valid date.' };
    }
    scheduleStored = writeSchedule(sheet, headers, row, body.scheduledAt);
  }

  return { ok: true, row: row, scheduleStored: scheduleStored, driveUrl: savedDriveUrl };
}

/** Pull the file id out of a Drive URL, so the File ID column still fills. */
function driveIdFrom(url) {
  var m = String(url).match(/\/d\/([a-zA-Z0-9_-]{10,})/) ||
          String(url).match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : '';
}

/**
 * Count this request against the day's ceilings, or refuse it.
 * `uploadCount` is the number of files in the post, not a boolean — a
 * ten-image carousel should cost ten, otherwise the upload cap means nothing.
 */
/** Today's counters, reset automatically when the date rolls over. */
function readQuota(props) {
  var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  var q = { date: today, rows: 0, uploads: 0, authCall: 0, authFail: 0 };
  var raw = props.getProperty('quota');
  if (raw) {
    try {
      var prev = JSON.parse(raw);
      if (prev && prev.date === today) {
        q.rows     = prev.rows     || 0;
        q.uploads  = prev.uploads  || 0;
        q.authCall = prev.authCall || 0;
        q.authFail = prev.authFail || 0;
      }
    } catch (ignored) {}
  }
  return q;
}

function writeQuota(props, q) {
  props.setProperty('quota', JSON.stringify(q));
}

function checkQuota(uploadCount) {
  var props = PropertiesService.getScriptProperties();
  var q = readQuota(props);

  if (q.rows >= MAX_ROWS_PER_DAY) {
    return 'Daily submission limit reached. Try again tomorrow.';
  }
  if (uploadCount > 0 && q.uploads + uploadCount > MAX_UPLOADS_PER_DAY) {
    return 'Daily upload limit reached. Paste a Drive link instead, or try again tomorrow.';
  }

  q.rows += 1;
  q.uploads += uploadCount;
  writeQuota(props, q);
  return '';
}

/**
 * The upload ceiling on its own, for edits.
 *
 * checkQuota() also burns a row against the daily submission limit, which is
 * right for a new post and wrong for replacing an image on an existing one.
 */
function checkUploadQuota(uploadCount) {
  if (uploadCount <= 0) return '';
  var props = PropertiesService.getScriptProperties();
  var q = readQuota(props);
  if (q.uploads + uploadCount > MAX_UPLOADS_PER_DAY) {
    return 'Daily upload limit reached. Paste a Drive link instead, or try again tomorrow.';
  }
  q.uploads += uploadCount;
  writeQuota(props, q);
  return '';
}

/** How many entries in an ordered media list are file uploads rather than links. */
function countUploads(items) {
  var n = 0;
  for (var i = 0; i < (items || []).length; i++) {
    if (items[i] && items[i].type === 'upload') n++;
  }
  return n;
}

/**
 * '' when the upload set fits, otherwise the refusal.
 *
 * base64 carries 3 bytes in every 4 characters, so the decoded size is 3/4 of
 * the string length. Checked as a SET, not per file: ten files that each pass
 * the individual limit still add up to a request Apps Script will not accept.
 */
function checkTotalUpload(items) {
  var bytes = 0;
  for (var i = 0; i < (items || []).length; i++) {
    var it = items[i];
    if (it && it.type === 'upload' && it.dataBase64) {
      bytes += Math.floor(String(it.dataBase64).length * 3 / 4);
    }
  }
  if (bytes > MAX_TOTAL_UPLOAD_MB * 1024 * 1024) {
    return 'That is ' + Math.round(bytes / 1048576) + ' MB of uploads — the limit is ' +
           MAX_TOTAL_UPLOAD_MB + ' MB per post. Remove a file, or paste Drive links instead.';
  }
  return '';
}

/**
 * Resolve an ordered media list to Drive URLs, uploading the entries that need
 * it. Order is preserved because item 1 is the carousel cover. Everything
 * downstream — this script's row builder, n8n, Blotato — only ever sees Drive
 * URLs, so none of them know an upload happened.
 *
 * Shared by submit and by edits from the review page, so a replaced image lands
 * in exactly the same place a freshly composed one would.
 */
function resolveMedia(items) {
  var urls = [], ids = [];
  for (var k = 0; k < (items || []).length; k++) {
    var it = items[k] || {};
    if (it.type === 'upload' && it.dataBase64) {
      var saved = saveUpload(it);
      if (!saved.ok) return { ok: false, error: 'Item ' + (k + 1) + ': ' + saved.error };
      urls.push(saved.url);
      ids.push(saved.id);
    } else if (it.type === 'link' && it.url) {
      urls.push(it.url);
      ids.push(driveIdFrom(it.url));
    }
  }
  return { ok: true, urls: urls, ids: ids };
}

/**
 * Save a base64 upload into Drive and link-share it.
 *
 * The share step is not optional: the publishing automation downloads the file
 * over the public internet, so a private file fails there rather than here.
 */
function saveUpload(up) {
  try {
    // base64 carries ~4 chars per 3 bytes, so back out the real size
    var bytes = Math.floor(String(up.dataBase64).length * 3 / 4);
    if (bytes > MAX_UPLOAD_MB * 1024 * 1024) {
      return { ok: false, error: 'Upload is larger than ' + MAX_UPLOAD_MB + ' MB.' };
    }

    var blob = Utilities.newBlob(
      Utilities.base64Decode(up.dataBase64),
      up.mimeType || 'application/octet-stream',
      up.name || 'autopost-upload'
    );

    var file = getUploadFolder().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return {
      ok: true,
      id: file.getId(),
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view?usp=sharing'
    };
  } catch (err) {
    return { ok: false, error: 'Upload failed: ' + String(err && err.message || err) };
  }
}

function getUploadFolder() {
  var found = DriveApp.getFoldersByName(UPLOAD_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(UPLOAD_FOLDER);
}

/**
 * RUN THIS ONCE from the editor after adding upload support:
 *   toolbar function dropdown > authorizeDrive > Run
 *
 * Deploying does NOT ask for permissions — only running a function does. Until
 * you run this, the web app keeps the narrower grant it was given before
 * DriveApp was used here, and every upload fails with
 * "no permission to call DriveApp.getFoldersByName".
 *
 * It also creates the upload folder, so you can confirm it landed in the right
 * Drive account.
 */
function authorizeDrive() {
  var folder = getUploadFolder();
  Logger.log('Upload folder ready: "' + folder.getName() + '"  id=' + folder.getId());
  Logger.log('Running as: ' + Session.getEffectiveUser().getEmail());
  return folder.getUrl();
}

/**
 * Write the schedule as plain text.
 *
 * appendRow would let Sheets coerce "2026-08-01T09:30:00Z" into a date value
 * rendered in the SPREADSHEET's timezone, which quietly shifts the instant the
 * automation reads. Forcing the cell to text first keeps the UTC string exactly
 * as the browser sent it.
 */
/**
 * Write one cell, optionally forcing it to plain text first.
 *
 * A caption that begins with = + - or @ is a live formula to Sheets, so
 * "=IMPORTRANGE(...)" typed into the composer would run in the sheet owner's
 * document. Formatting the cell as text first makes it inert, and keeps the
 * caption byte-identical for whatever n8n reads back.
 */
function writeCell(sheet, row, col, value, asText) {
  var cell = sheet.getRange(row, col + 1);
  if (asText) cell.setNumberFormat('@');
  cell.setValue(value);
}

/** writeCell by column alias, skipping quietly when the sheet has no such column. */
function writeTextField(sheet, headers, row, aliases, value) {
  if (!value) return;
  var col = colIndex(headers, aliases);
  if (col > -1) writeCell(sheet, row, col, value, true);
}

function writeSchedule(sheet, headers, row, scheduledAt) {
  if (!scheduledAt) return true;   // nothing to store

  var col = colIndex(headers, FIELD_ALIASES.scheduledAt);
  // No schedule column. Say so instead of dropping the time on the floor —
  // a blank publish time means "post immediately", which is not what the
  // person who picked a date was asking for.
  if (col < 0) return false;

  var cell = sheet.getRange(row, col + 1);
  cell.setNumberFormat('@');
  cell.setValue(scheduledAt);
  return true;
}

function matches(header, aliases) {
  return aliases.indexOf(header) > -1;
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Visiting the /exec URL in a browser shows this — handy to confirm the deployment is live. */
function doGet() {
  return respond({
    ok: true,
    service: 'AutoPost sheet endpoint',
    version: VERSION,
    /* false means SUPABASE_URL / SUPABASE_KEY are still blank, and every POST
       is being refused. Check this first when the pages say you are signed out. */
    auth: !!(SUPABASE_URL && SUPABASE_KEY),
    /* This script is now the only thing that starts a publish, so a stopped
       trigger is silent. If `lastSweep` is not within the last few minutes,
       nothing is publishing — run installSweep() from the editor. */
    webhook: !!(N8N_WEBHOOK_URL && N8N_WEBHOOK_SECRET),
    lastSweep: PropertiesService.getScriptProperties().getProperty('lastSweepAt') || null,
    uploads: true,
    ready: true
  });
}

/** Run this from the Apps Script editor to test without the form. */
function testAppend() {
  var fake = {
    postData: {
      contents: JSON.stringify({
        driveUrl: 'https://drive.google.com/file/d/1TESTtesttest123/view',
        driveFileId: '1TESTtesttest123',
        caption: 'Test row from the Apps Script editor.',
        platforms: ['facebook', 'instagram'],
        youtube: null,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        timezone: 'Asia/Manila',
        token: SHARED_TOKEN
      })
    }
  };
  Logger.log(doPost(fake).getContent());
}
