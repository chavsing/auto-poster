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
 *  5. Paste that URL into SHEET_ENDPOINT near the top of index.html.
 *
 * After ANY edit here you must Deploy > Manage deployments > edit > Version: New version.
 * Editing the code alone does NOT update the live URL.
 */

var SHEET_ID    = '1BDhyws9fM__wv7ygjkEepmB_psVh7QOoFk_x3ZsR48k';
var SHEET_NAME  = '';   // leave blank to use the first tab
/* Must match AUTH_TOKEN in index.html. This is NOT a real secret — it ships in
   the page source, so anyone who views source can read it. What it does buy you
   is that a bot hitting the /exec URL directly, without ever loading the page,
   gets rejected. For actual access control put the page behind Vercel's
   Deployment Protection. Change this string any time; change both files. */
var SHARED_TOKEN = 'ap_5iLo88aF_oQ0NG-hh1JKxDUi';

/* Daily ceilings, counted per UTC day. The endpoint is public and now writes
   files into Drive, so an unbounded one is an invitation to fill it. */
var MAX_ROWS_PER_DAY    = 200;
var MAX_UPLOADS_PER_DAY = 50;

/* Instagram and LinkedIn cap carousels at 10; the form enforces the same. */
var MAX_MEDIA = 10;

/* Ceilings on the approvals endpoint. It is reachable by anyone with the page
   URL, so it needs its own limits: fails guard the key, calls guard the
   script's daily execution quota. */
var MAX_APPROVAL_CALLS_PER_DAY = 500;
var MAX_APPROVAL_FAILS_PER_DAY = 15;

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

/* Approving from the web page is the same authority as publishing, so it needs
   a real secret — NOT SHARED_TOKEN, which ships in the page source and only
   turns away bots. This one lives in Script Properties: it is never in the
   page, never in the repo, and only travels when someone types it.
   Run newApprovalKey() once from the editor to create it.
   No key set => the approvals panel is refused outright. */
var APPROVAL_KEY_PROP = 'approvalKey';

/* What a fresh row's `post status` says. n8n's sheet read filters on exactly
   this value, so published rows drop out of the query entirely instead of being
   re-fetched on every sweep forever. Must match the filter in the workflow. */
var QUEUED_STATUS = 'queued';

/* Uploaded files land here, in the Drive of whoever deployed this script.
   Created on first use. Every file is link-shared, because the automation
   fetches it over the public internet. */
var UPLOAD_FOLDER = 'AutoPost uploads';
var MAX_UPLOAD_MB = 20;

/* Bump this whenever you change this file. Opening the /exec URL in a browser
   shows the version that is actually LIVE — which is the deployed one, not the
   one in the editor. If it doesn't match, the deployment wasn't updated. */
var VERSION = '6-review';

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
  timestamp:  ['timestamp', 'date', 'submitted', 'submitted at', 'created', 'time']
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
    var action = body.action || 'submit';
    if (action === 'list')      return respond(listRows(body));
    if (action === 'setStatus') return respond(setRowStatus(body));
    if (action === 'update')    return respond(updateRow(body));

    var items = body.media || [];
    if (items.length > MAX_MEDIA) {
      return respond({ ok: false, error: 'At most ' + MAX_MEDIA + ' media items per post.' });
    }

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
   APPROVALS — read pending rows and flip their status
   ============================================================ */

/**
 * Create the approval key. Run once from the editor, copy it out of the
 * execution log, and give it only to whoever is allowed to publish.
 * Running it again replaces the key and locks out the old one.
 */
function newApprovalKey() {
  var key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  PropertiesService.getScriptProperties().setProperty(APPROVAL_KEY_PROP, key);
  Logger.log('Approval key (store it somewhere safe): ' + key);
  return key;
}

/**
 * '' when allowed, otherwise the refusal to send back.
 *
 * The endpoint is public and SHARED_TOKEN is in the page source, so anyone can
 * reach this. Two ceilings apply: failed attempts (brute force) and total calls
 * (burning the script's daily execution quota, which would take submissions
 * down with it).
 */
function checkApproval(body) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(APPROVAL_KEY_PROP) || '';
  if (!key) return 'Approvals are not available.';

  var q = readQuota(props);
  if (q.apFail >= MAX_APPROVAL_FAILS_PER_DAY) {
    return 'Too many failed attempts. Approvals are locked until tomorrow.';
  }
  if (q.apCall >= MAX_APPROVAL_CALLS_PER_DAY) {
    return 'Too many approval requests today.';
  }
  q.apCall += 1;

  /* Compare every character rather than bailing at the first mismatch, so
     response timing cannot be walked to recover the key. */
  var given = String(body.key || '');
  var diff = (given.length === key.length) ? 0 : 1;
  for (var i = 0; i < key.length; i++) {
    diff |= (key.charCodeAt(i) ^ (given.charCodeAt(i) || 0));
  }
  var ok = diff === 0;

  if (!ok) q.apFail += 1;
  writeQuota(props, q);
  return ok ? '' : 'Wrong approval key.';
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

/** The most recent rows, with just enough to decide whether to approve. */
function listRows(body) {
  var refusal = checkApproval(body);
  if (refusal) return { ok: false, error: refusal };

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
  var cResult = -1;
  for (var h = 0; h < headers.length; h++) if (headers[h] === 'result') cResult = h;

  var take = Math.min(lastRow - 1, 25);          // newest 25 is plenty to review
  var rows = [];
  for (var r = lastRow; r > lastRow - take; r--) {
    var v = values[r - 1];
    rows.push({
      row: r,
      driveUrl:   cDrive  > -1 ? String(v[cDrive])  : '',
      caption:    cCap    > -1 ? String(v[cCap])    : '',
      status:     cStatus > -1 ? String(v[cStatus]) : '',
      postStatus: cPost   > -1 ? String(v[cPost])   : '',
      scheduledAt: cWhen  > -1 ? String(v[cWhen])   : '',
      result:     cResult > -1 ? String(v[cResult]) : '',
      platforms: platformsIn(headers, v)
    });
  }
  return {
    ok: true,
    rows: rows,
    statuses: [NEW_STATUS, PUBLISH_STATUS],
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
    if (ps && ps !== QUEUED_STATUS) {
      return { error: 'Row ' + row + ' was already handled (' + ps + ').' };
    }
  }
  return { sheet: sheet, row: row, headers: headers };
}

/** Flip one row between "held" and "approved". Nothing else is writable. */
function setRowStatus(body) {
  var refusal = checkApproval(body);
  if (refusal) return { ok: false, error: refusal };

  var status = String(body.status || '');
  if (status !== NEW_STATUS && status !== PUBLISH_STATUS) {
    return { ok: false, error: 'Status must be "' + NEW_STATUS + '" or "' + PUBLISH_STATUS + '".' };
  }

  var t = openEditableRow(body);
  if (t.error) return { ok: false, error: t.error };

  var cStatus = colIndex(t.headers, FIELD_ALIASES.status);
  if (cStatus < 0) return { ok: false, error: 'No status column in this sheet.' };

  t.sheet.getRange(t.row, cStatus + 1).setValue(status);
  return { ok: true, row: t.row, status: status };
}

/**
 * Edit a queued row from the review page: caption, media, platforms, schedule.
 *
 * Deliberately NOT writable: `status` (that is setRowStatus, so approving stays
 * one explicit action) and `post status` (that belongs to n8n). Every field is
 * optional — only what the page sends gets touched.
 */
function updateRow(body) {
  var refusal = checkApproval(body);
  if (refusal) return { ok: false, error: refusal };

  var t = openEditableRow(body);
  if (t.error) return { ok: false, error: t.error };
  var sheet = t.sheet, row = t.row, headers = t.headers;

  var writes = [];   // [colIndex, value] — collected first so a bad field writes nothing

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
    var overQuota = checkUploadQuota(countUploads(items));
    if (overQuota) return { ok: false, error: overQuota };

    var resolved = resolveMedia(items);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (!resolved.urls.length) return { ok: false, error: 'None of that media could be resolved.' };

    var cDrive = colIndex(headers, FIELD_ALIASES.driveUrl);
    if (cDrive < 0) return { ok: false, error: 'No media column in this sheet.' };
    writes.push([cDrive, resolved.urls.join(', ')]);

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

  return { ok: true, row: row, scheduleStored: scheduleStored };
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
  var q = { date: today, rows: 0, uploads: 0, apCall: 0, apFail: 0 };
  var raw = props.getProperty('quota');
  if (raw) {
    try {
      var prev = JSON.parse(raw);
      if (prev && prev.date === today) {
        q.rows    = prev.rows    || 0;
        q.uploads = prev.uploads || 0;
        q.apCall  = prev.apCall  || 0;
        q.apFail  = prev.apFail  || 0;
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
