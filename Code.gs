const SHEET_NAME = 'Entries';
const CONFIG_SHEET = 'Config';
const MAX_ENTRY_SIZE = 500000;
const AUTH_TOKEN_TTL_SEC = 12 * 60 * 60;
const MAX_PIN_LENGTH = 128;
const JSON_FIELDS = ['openingCash', 'closingCash', 'expenses', 'vendorPayments', 'goodsInward', 'productOrders', 'ingredients', 'method', 'materials'];
const NUMBER_FIELDS = ['shop', 'openingTotal', 'closingTotal', 'upiReceived', 'totalBilled', 'walkIns', 'totalExpenses', 'totalVendorPayments', 'totalGoodsInward', 'cashRetained', 'qty', 'lat', 'lng', 'gpsAccuracy', 'distanceFromShop', 'monthlySalary', 'totalAdvances', 'pendingPay', 'paidAmount', 'days', 'radiusMeters', 'leaveBalance', 'annualLeave'];

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  var params = (e && e.parameter) || {};
  var action = String(params.action || '');
  var body = null;
  var result;

  try {
    if (action === 'save' || action === 'changePin') {
      body = getPayloadObject(e);
    }

    switch (action) {
      case 'getAll':
        result = getAllEntries(params);
        break;
      case 'save':
        body = sanitizePayload(body);
        var validationError = validateEntry(body);
        result = validationError ? { success: false, error: validationError } : saveEntry(body, params);
        break;
      case 'delete':
        result = deleteEntry(params.id, params);
        break;
      case 'deleteAll':
        result = deleteAllEntries(params);
        break;
      case 'verifyPin':
        result = verifyPin(params.pin, params.role);
        break;
      case 'changePin':
        result = changePin(sanitizePayload(body), params);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err && err.message ? err.message : String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function getPayloadObject(e) {
  if (e && e.parameter && e.parameter.payload) {
    try {
      return JSON.parse(decodeURIComponent(String(e.parameter.payload).replace(/\+/g, ' ')));
    } catch (err) {
      return JSON.parse(e.parameter.payload);
    }
  }
  if (e && e.postData && e.postData.contents) {
    return JSON.parse(e.postData.contents);
  }
  return {};
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'Invalid entry data';
  var json = JSON.stringify(entry);
  if (!json || json.length > MAX_ENTRY_SIZE) return 'Entry too large (max 500KB)';
  if (entry.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) return 'Invalid date format';
  if (entry.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.deliveryDate))) return 'Invalid delivery date format';
  if (entry.shop !== undefined && [0, 1, '0', '1', -1, '-1', 2, '2'].indexOf(entry.shop) === -1) return 'Invalid shop value';
  return null;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  var clean = JSON.parse(JSON.stringify(payload));
  delete clean.token;
  return clean;
}

function normalizeRole(role) {
  return String(role || '').toLowerCase().trim();
}

function hashSecret(value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return 'sha256:' + Utilities.base64EncodeWebSafe(digest);
}

function isStoredSecretMatch(input, storedValue) {
  var inputStr = String(input || '');
  var stored = String(storedValue || '');
  if (!stored) return { matched: false, needsUpgrade: false };
  if (stored.indexOf('sha256:') === 0) {
    return { matched: hashSecret(inputStr) === stored, needsUpgrade: false };
  }
  return { matched: inputStr === stored, needsUpgrade: inputStr === stored };
}

function createAuthToken(role) {
  var token = Utilities.getUuid() + '.' + Date.now();
  CacheService.getScriptCache().put('auth:' + token, JSON.stringify({ role: role, issuedAt: Date.now() }), AUTH_TOKEN_TTL_SEC);
  return token;
}

function getAuthContext(params, body) {
  var token = '';
  if (params && params.token) token = String(params.token);
  if (!token && body && body.token) token = String(body.token);
  if (!token) return null;
  var cached = CacheService.getScriptCache().get('auth:' + token);
  if (!cached) return null;
  try {
    var auth = JSON.parse(cached);
    auth.token = token;
    return auth;
  } catch (err) {
    return null;
  }
}

function requireAuth(params, body, allowedRoles) {
  var auth = getAuthContext(params, body);
  if (!auth || !auth.role) throw new Error('Authentication required. Please log in again.');
  if (allowedRoles && allowedRoles.length && allowedRoles.indexOf(auth.role) === -1) {
    throw new Error('You do not have permission for this action.');
  }
  return auth;
}

function canAccessShop(auth, shop) {
  if (!auth) return false;
  if (auth.role === 'owner' || auth.role === 'production' || auth.role === 'ordering' || auth.role === 'hr') return true;
  if (auth.role === 'highway') return String(shop) === '0';
  if (auth.role === 'mainroad') return String(shop) === '1';
  return false;
}

function canSaveEntryForRole(auth, entry) {
  var type = String((entry && entry.type) || '');
  if (type === 'activityLog') return true;
  if (auth.role === 'owner') return true;
  if (auth.role === 'highway' || auth.role === 'mainroad') {
    return canAccessShop(auth, entry.shop) && (type === '' || type === 'productOrder' || type === 'wastage' || type === 'staffLog' || type === 'attendance' || type === 'leaveRequest');
  }
  if (auth.role === 'production') {
    return type === 'rawMaterial' || type === 'recipe' || type === 'wastage';
  }
  if (auth.role === 'ordering') {
    return type === 'productOrder' || type === 'goodsInward' || type === 'advanceOrder' || type === 'wastage';
  }
  if (auth.role === 'hr') {
    return type === 'employee' || type === 'attendance' || type === 'leaveRequest' || type === 'salaryRecord' || type === 'shopLocation';
  }
  return false;
}

function canDeleteEntryForRole(auth, record) {
  var type = String((record && record.type) || '');
  if (auth.role === 'owner') return true;
  if (auth.role === 'highway' || auth.role === 'mainroad') {
    return canAccessShop(auth, record.shop) && (type === '' || type === 'productOrder' || type === 'wastage' || type === 'staffLog');
  }
  if (auth.role === 'production') {
    return type === 'rawMaterial' || type === 'recipe' || type === 'wastage';
  }
  if (auth.role === 'ordering') {
    return type === 'productOrder' || type === 'goodsInward' || type === 'advanceOrder' || type === 'wastage';
  }
  if (auth.role === 'hr') {
    return type === 'employee' || type === 'attendance' || type === 'leaveRequest' || type === 'salaryRecord' || type === 'shopLocation';
  }
  return false;
}

function getSheetHeaders(sheet, entry) {
  var baseHeaders = ['id', 'type', 'shop', 'date', 'deliveryDate', 'customer', 'product', 'qty', 'unit', 'category',
    'openingCash', 'closingCash', 'openingTotal', 'closingTotal', 'upiReceived', 'totalBilled', 'walkIns',
    'expenses', 'vendorPayments', 'totalExpenses', 'totalVendorPayments', 'goodsInward', 'totalGoodsInward',
    'productOrders', 'cashRetained', 'notes', 'savedAt', 'savedBy'];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(baseHeaders);
    sheet.getRange(1, 1, 1, baseHeaders.length).setFontWeight('bold');
    return baseHeaders;
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h); });
  var entryKeys = Object.keys(entry || {});
  var added = false;

  for (var i = 0; i < entryKeys.length; i++) {
    if (headers.indexOf(entryKeys[i]) === -1) {
      headers.push(entryKeys[i]);
      added = true;
    }
  }

  if (added) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  return headers;
}

function getAllEntries(params) {
  var auth = requireAuth(params, null, ['owner', 'highway', 'mainroad', 'production', 'ordering', 'hr']);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return { success: true, data: [] };
  }

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h); });
  var entries = [];
  var jsonIdx = {};
  var numIdx = {};
  var dateIdx = headers.indexOf('date');
  var cutoffStr = '';
  var applyRecentStaffFilter = auth.role === 'highway' || auth.role === 'mainroad';

  for (var h = 0; h < headers.length; h++) {
    if (JSON_FIELDS.indexOf(headers[h]) >= 0) jsonIdx[h] = true;
    if (NUMBER_FIELDS.indexOf(headers[h]) >= 0) numIdx[h] = true;
  }

  if (applyRecentStaffFilter) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  for (var i = 1; i < data.length; i++) {
    if (applyRecentStaffFilter && dateIdx >= 0) {
      var rowDate = data[i][dateIdx];
      rowDate = rowDate instanceof Date
        ? Utilities.formatDate(rowDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(rowDate).substring(0, 10);
      if (rowDate < cutoffStr) continue;
    }

    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (jsonIdx[j]) {
        try {
          val = JSON.parse(val);
        } catch (err) {
          val = headers[j].indexOf('Cash') >= 0 ? [0, 0, 0, 0, 0, 0, 0] : [];
        }
      } else if (numIdx[j]) {
        val = Number(val) || 0;
      }
      row[headers[j]] = val;
    }

    if ((auth.role === 'highway' || auth.role === 'mainroad') && !canAccessShop(auth, row.shop)) {
      continue;
    }

    entries.push(row);
  }

  return { success: true, data: entries };
}

function saveEntry(entry, params) {
  var auth = requireAuth(params, entry, ['owner', 'highway', 'mainroad', 'production', 'ordering', 'hr']);
  if (!canSaveEntryForRole(auth, entry)) {
    return { success: false, error: 'You do not have permission to save this record type' };
  }

  entry.savedBy = auth.role;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  var headers = getSheetHeaders(sheet, entry);

  if (sheet.getLastRow() > 1) {
    var data = sheet.getDataRange().getValues();
    var idCol = headers.indexOf('id');
    var typeCol = headers.indexOf('type');
    var shopCol = headers.indexOf('shop');
    var dateCol = headers.indexOf('date');
    var rowsToDelete = [];

    for (var i = 1; i < data.length; i++) {
      var sheetDate = data[i][dateCol] instanceof Date
        ? Utilities.formatDate(data[i][dateCol], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(data[i][dateCol]).substring(0, 10);
      var rowType = typeCol >= 0 ? String(data[i][typeCol] || '') : '';

      if (entry.type === 'activityLog' || entry.type === 'staffLog' || entry.type === 'attendance') {
        continue;
      } else if (entry.type === 'shopLocation') {
        if (rowType === 'shopLocation' && String(data[i][shopCol]) === String(entry.shop)) rowsToDelete.push(i + 1);
      } else if (entry.type === 'employee' || entry.type === 'leaveRequest' || entry.type === 'salaryRecord') {
        if (idCol >= 0 && data[i][idCol] === entry.id) rowsToDelete.push(i + 1);
      } else if (entry.type === 'advanceOrder' || entry.type === 'recipe' || entry.type === 'rawMaterial' || entry.type === 'goodsInward') {
        if (idCol >= 0 && data[i][idCol] === entry.id) rowsToDelete.push(i + 1);
      } else if (entry.type === 'productOrder' || entry.type === 'wastage') {
        if (rowType === entry.type && String(data[i][shopCol]) === String(entry.shop) && sheetDate === entry.date) rowsToDelete.push(i + 1);
      } else if (!entry.type) {
        if (!rowType && String(data[i][shopCol]) === String(entry.shop) && sheetDate === entry.date) rowsToDelete.push(i + 1);
      }
    }

    for (var d = rowsToDelete.length - 1; d >= 0; d--) {
      sheet.deleteRow(rowsToDelete[d]);
    }
  }

  var row = headers.map(function (header) {
    if (JSON_FIELDS.indexOf(header) >= 0) return JSON.stringify(entry[header] || []);
    return entry[header] !== undefined ? entry[header] : '';
  });
  sheet.appendRow(row);

  if (!entry.type) {
    var logRow = headers.map(function (header) {
      if (header === 'type') return 'staffLog';
      if (header === 'id') return entry.id + '_log_' + Date.now();
      if (JSON_FIELDS.indexOf(header) >= 0) return '[]';
      return entry[header] !== undefined ? entry[header] : '';
    });
    sheet.appendRow(logRow);
  }

  if (sheet.getLastRow() > 2) {
    var sortDateIdx = headers.indexOf('date');
    if (sortDateIdx >= 0) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length)
        .sort({ column: sortDateIdx + 1, ascending: false });
    }
  }

  return { success: true, message: 'Entry saved' };
}

function deleteEntry(id, params) {
  var auth = requireAuth(params, null, ['owner', 'highway', 'mainroad', 'production', 'ordering', 'hr']);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return { success: false, error: 'No entries found' };
  }

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h); });
  var idCol = headers.indexOf('id');
  var typeCol = headers.indexOf('type');
  var shopCol = headers.indexOf('shop');

  for (var i = data.length - 1; i >= 1; i--) {
    if (idCol >= 0 && data[i][idCol] === id) {
      var record = {
        type: typeCol >= 0 ? String(data[i][typeCol] || '') : '',
        shop: shopCol >= 0 ? data[i][shopCol] : ''
      };
      if (!canDeleteEntryForRole(auth, record)) {
        return { success: false, error: 'You do not have permission to delete this record' };
      }
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Deleted' };
    }
  }

  return { success: false, error: 'Entry not found' };
}

function deleteAllEntries(params) {
  requireAuth(params, null, ['owner']);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }
  return { success: true, message: 'All entries deleted' };
}

function ensureConfigRows(config) {
  var defaults = [
    ['owner_pin', hashSecret('7736')],
    ['highway_pin', hashSecret('1234')],
    ['mainroad_pin', hashSecret('1234')],
    ['production_pin', hashSecret('1234')],
    ['ordering_pin', hashSecret('1234')],
    ['hr_pin', hashSecret('1234')]
  ];
  var lastRow = config.getLastRow();
  // Fill in any missing rows up to 5
  for (var i = lastRow; i < defaults.length; i++) {
    config.appendRow(defaults[i]);
  }
  // Ensure each existing row has a valid PIN in column B
  for (var i = 0; i < Math.min(lastRow, defaults.length); i++) {
    var val = String(config.getRange('B' + (i + 1)).getValue());
    if (!val || val === 'undefined' || val === 'null') {
      config.getRange('A' + (i + 1)).setValue(defaults[i][0]);
      config.getRange('B' + (i + 1)).setValue(defaults[i][1]);
    }
  }
}

function verifyPin(pin, role) {
  if (!pin || String(pin).length > MAX_PIN_LENGTH) {
    return { success: true, valid: false };
  }

  var normalizedRole = normalizeRole(role);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG_SHEET);

  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
  }

  ensureConfigRows(config);

  var props = PropertiesService.getScriptProperties();
  var failKey = 'pin_fails_' + (normalizedRole || 'unknown');
  var lockKey = 'pin_lock_' + (normalizedRole || 'unknown');
  var lockUntil = parseInt(props.getProperty(lockKey) || '0', 10);
  if (lockUntil > Date.now()) {
    var waitSec = Math.ceil((lockUntil - Date.now()) / 1000);
    return { success: true, valid: false, locked: true, message: 'Too many attempts. Try again in ' + waitSec + 's' };
  }

  var roleMap = { owner: 1, highway: 2, mainroad: 3, production: 4, ordering: 5, hr: 6 };
  var row = roleMap[normalizedRole] || 1;
  var storedPin = String(config.getRange('B' + row).getValue());
  var match = isStoredSecretMatch(pin, storedPin);

  if (match.matched) {
    if (match.needsUpgrade) {
      config.getRange('B' + row).setValue(hashSecret(pin));
    }
    props.deleteProperty(failKey);
    props.deleteProperty(lockKey);
    return { success: true, valid: true, token: createAuthToken(normalizedRole), role: normalizedRole };
  }

  var fails = parseInt(props.getProperty(failKey) || '0', 10) + 1;
  props.setProperty(failKey, String(fails));
  if (fails >= 5) {
    props.setProperty(lockKey, String(Date.now() + 60000));
    props.setProperty(failKey, '0');
  }
  return { success: true, valid: false };
}

function changePin(data, params) {
  requireAuth(params, data, ['owner']);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG_SHEET);

  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
  }

  ensureConfigRows(config);

  var ownerPin = String(config.getRange('B1').getValue());
  if (!isStoredSecretMatch(data.currentPin, ownerPin).matched) {
    return { success: false, error: 'Owner password is wrong' };
  }
  if (!data.newPin || data.newPin.length < 8 || data.newPin.length > MAX_PIN_LENGTH) {
    return { success: false, error: 'Password must be at least 8 characters' };
  }

  var roleMap = { owner: 1, highway: 2, mainroad: 3, production: 4, ordering: 5, hr: 6 };
  var role = normalizeRole(data.role || 'owner');
  var row = roleMap[role] || 1;

  config.getRange('B' + row).setValue(hashSecret(data.newPin));
  return { success: true, message: role + ' password updated' };
}
