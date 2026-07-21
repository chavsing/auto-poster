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
var SHARED_TOKEN = '';  // optional: set a password here AND in index.html's AUTH_TOKEN

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
    if (!body.driveUrl || !body.caption) {
      return respond({ ok: false, error: 'driveUrl and caption are required.' });
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

    return respond({
      ok: true,
      row: sheet.getLastRow(),
      platforms: platforms.length
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
  if (matches(header, FIELD_ALIASES.status))      return 'new';

  return '';   // unknown column: leave it alone
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
  return respond({ ok: true, service: 'AutoPost sheet endpoint', ready: true });
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
        token: SHARED_TOKEN
      })
    }
  };
  Logger.log(doPost(fake).getContent());
}
