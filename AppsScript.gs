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

/* This script's only job is to append the row. n8n polls the sheet on its own
   schedule and decides when to publish — nothing here talks to n8n. */

/* What a fresh submission lands as. The `status` dropdown holds exactly two
   values: 'For review' (held) and 'Publish' (n8n picks it up). This must be
   the held one — a human moves the row to 'Publish' after reviewing.
   CHANGING THIS FILE IS NOT ENOUGH: redeploy as a NEW VERSION or the live
   /exec URL keeps running the old code. */
var NEW_STATUS = 'For review';

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
var VERSION = '4-carousel';

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
    var items = body.media || [];
    if (items.length > MAX_MEDIA) {
      return respond({ ok: false, error: 'At most ' + MAX_MEDIA + ' media items per post.' });
    }

    var fileCount = 0;
    for (var m = 0; m < items.length; m++) {
      if (items[m] && items[m].type === 'upload') fileCount++;
    }
    var overQuota = checkQuota(fileCount);
    if (overQuota) return respond({ ok: false, error: overQuota });

    /* Resolve the ordered list to Drive URLs, uploading the entries that need
       it. Order is preserved because item 1 is the carousel cover. Everything
       downstream — this script's row builder, n8n, Blotato — only ever sees
       Drive URLs, so none of them know an upload happened. */
    var urls = [], ids = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k] || {};
      if (it.type === 'upload' && it.dataBase64) {
        var saved = saveUpload(it);
        if (!saved.ok) return respond({ ok: false, error: 'Item ' + (k + 1) + ': ' + saved.error });
        urls.push(saved.url);
        ids.push(saved.id);
      } else if (it.type === 'link' && it.url) {
        urls.push(it.url);
        ids.push(driveIdFrom(it.url));
      }
    }

    if (urls.length) {
      body.driveUrl = urls.join(', ');
      body.driveFileId = ids.join(', ');
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
    var scheduleStored = writeSchedule(sheet, headers, body.scheduledAt);

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
  if (matches(header, FIELD_ALIASES.caption))     return body.caption || '';
  if (matches(header, FIELD_ALIASES.platforms))   return platforms.join(', ');
  if (matches(header, FIELD_ALIASES.ytTitle))     return body.youtube ? body.youtube.title : '';
  if (matches(header, FIELD_ALIASES.ytPrivacy))   return body.youtube ? body.youtube.privacy : '';
  if (matches(header, FIELD_ALIASES.scheduledAt)) return '';   // written as text below
  if (matches(header, FIELD_ALIASES.timezone))    return body.timezone || '';
  if (matches(header, FIELD_ALIASES.status))      return NEW_STATUS;
  /* n8n reads ONLY rows sitting at this marker, so a published row is never
     fetched again — the sweep stays the same size however big the sheet gets. */
  if (matches(header, FIELD_ALIASES.postStatus))  return QUEUED_STATUS;

  return '';   // unknown column: leave it alone
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
function checkQuota(uploadCount) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  var q = { date: today, rows: 0, uploads: 0 };
  var raw = props.getProperty('quota');
  if (raw) {
    try {
      var prev = JSON.parse(raw);
      if (prev && prev.date === today) q = prev;   // stale day => start over
    } catch (ignored) {}
  }

  if (q.rows >= MAX_ROWS_PER_DAY) {
    return 'Daily submission limit reached. Try again tomorrow.';
  }
  if (uploadCount > 0 && q.uploads + uploadCount > MAX_UPLOADS_PER_DAY) {
    return 'Daily upload limit reached. Paste a Drive link instead, or try again tomorrow.';
  }

  q.rows += 1;
  q.uploads += uploadCount;
  props.setProperty('quota', JSON.stringify(q));
  return '';
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
function writeSchedule(sheet, headers, scheduledAt) {
  if (!scheduledAt) return true;   // nothing to store

  var col = -1;
  for (var i = 0; i < headers.length; i++) {
    if (matches(headers[i], FIELD_ALIASES.scheduledAt)) { col = i; break; }
  }
  // No schedule column. Say so instead of dropping the time on the floor —
  // a blank publish time means "post immediately", which is not what the
  // person who picked a date was asking for.
  if (col < 0) return false;

  var cell = sheet.getRange(sheet.getLastRow(), col + 1);
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
