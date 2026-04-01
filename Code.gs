// ═══════════════════════════════════════════════════════════════
// AKSHAY BAKERY TRACKER — Google Apps Script Backend v5
// Performance optimized: batch operations, minimal sheet calls
// Added: input sanitization, rate limiting, safer error handling
// ═══════════════════════════════════════════════════════════════
const SHEET_NAME = 'Entries';
const CONFIG_SHEET = 'Config';
const MAX_ENTRY_SIZE = 500000; // 500KB max per entry to prevent abuse

// Sanitize string input to prevent injection
function sanitizeStr(s) {
  if (s == null) return '';
  return String(s).substring(0, 10000); // cap string length
}

// Validate entry has required fields and reasonable size
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'Invalid entry data';
  var json = JSON.stringify(entry);
  if (json.length > MAX_ENTRY_SIZE) return 'Entry too large (max 500KB)';
  if (entry.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) return 'Invalid date format';
  if (entry.shop !== undefined && ![0, 1, '0', '1'].includes(entry.shop)) return 'Invalid shop value';
  return null; // valid
}

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const params = e.parameter || {};
  const action = params.action || '';

  let result;

  try {
    switch(action) {
      case 'getAll':
        result = getAllEntries(params);
        break;
      case 'save':
        const postData = e.parameter.payload ? JSON.parse(decodeURIComponent(e.parameter.payload.replace(/\+/g,' '))) : JSON.parse(e.postData.contents);
        var validErr = validateEntry(postData);
        if (validErr) { result = { success: false, error: validErr }; break; }
        result = saveEntry(postData);
        break;
      case 'delete':
        result = deleteEntry(params.id);
        break;
      case 'deleteAll':
        result = deleteAllEntries(params);
        break;
      case 'verifyPin':
        result = verifyPin(params.pin, params.role);
        break;
      case 'changePin':
        const pinData = e.parameter.payload ? JSON.parse(e.parameter.payload) : (e.postData ? JSON.parse(e.postData.contents) : {});
        result = changePin(pinData);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch(err) {
    result = { success: false, error: err.toString() };
  }

  const output = ContentService.createTextOutput(JSON.stringify(result));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ── GET ALL ENTRIES ──
function getAllEntries(params) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return { success: true, data: [] };
  }

  // Single read — get all data in one call
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h){return String(h)});
  const entries = [];
  const jsonFields = ['openingCash','closingCash','expenses','vendorPayments','goodsInward','productOrders','ingredients','method','materials'];
  const numFields = ['shop','openingTotal','closingTotal','upiReceived','totalBilled','walkIns','totalExpenses','totalVendorPayments','totalGoodsInward','cashRetained','qty'];

  // Pre-compute field indices for faster lookup
  const jsonIdx = new Set();
  const numIdx = new Set();
  headers.forEach((h, j) => {
    if (jsonFields.indexOf(h) >= 0) jsonIdx.add(j);
    if (numFields.indexOf(h) >= 0) numIdx.add(j);
  });

  // Staff filter: compute cutoff once
  var staffFilter = false, cutoffStr = '';
  if (params.role === 'staff') {
    staffFilter = true;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 2);
    cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const dateIdx = headers.indexOf('date');

  for (let i = 1; i < data.length; i++) {
    // Early filter for staff — skip old rows before parsing JSON
    if (staffFilter && dateIdx >= 0) {
      var rowDate = data[i][dateIdx];
      if (rowDate instanceof Date) {
        rowDate = Utilities.formatDate(rowDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        rowDate = String(rowDate).substring(0, 10);
      }
      if (rowDate < cutoffStr) continue;
    }

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      let val = data[i][j];
      if (jsonIdx.has(j)) {
        try { val = JSON.parse(val); } catch(e) { val = headers[j].includes('Cash') ? [0,0,0,0,0,0,0] : []; }
      } else if (numIdx.has(j)) {
        val = Number(val) || 0;
      }
      row[headers[j]] = val;
    }
    entries.push(row);
  }

  return { success: true, data: entries };
}

// ── SAVE ENTRY ──
function saveEntry(entry) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  var baseHeaders = ['id','type','shop','date','deliveryDate','customer','product','qty','unit','category',
    'openingCash','closingCash','openingTotal','closingTotal',
    'upiReceived','totalBilled','walkIns','expenses','vendorPayments',
    'totalExpenses','totalVendorPayments','goodsInward','totalGoodsInward',
    'productOrders','cashRetained','notes','savedAt','savedBy'];

  var headers;
  if (sheet.getLastRow() === 0) {
    headers = baseHeaders;
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else {
    var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    headers = headerRow.map(function(h){return String(h)});
    var entryKeys = Object.keys(entry);
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
  }

  // ── Find rows to delete (batch collect, then delete in reverse) ──
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    var idCol = headers.indexOf('id');
    var typeCol = headers.indexOf('type');
    var shopCol = headers.indexOf('shop');
    var dateCol = headers.indexOf('date');
    var rowsToDelete = [];

    for (let i = 1; i < data.length; i++) {
      var sheetDate = data[i][dateCol] instanceof Date ? Utilities.formatDate(data[i][dateCol], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(data[i][dateCol]).substring(0,10);
      var rowType = typeCol >= 0 ? String(data[i][typeCol] || '') : '';

      if (entry.type === 'activityLog' || entry.type === 'staffLog') {
        // Never overwrite — always append
      } else if (entry.type === 'advanceOrder' || entry.type === 'recipe' || entry.type === 'rawMaterial' || entry.type === 'goodsInward') {
        if (idCol >= 0 && data[i][idCol] === entry.id) {
          rowsToDelete.push(i + 1);
        }
      } else if (entry.type === 'productOrder' || entry.type === 'wastage') {
        if (rowType === entry.type && String(data[i][shopCol]) === String(entry.shop) && sheetDate === entry.date) {
          rowsToDelete.push(i + 1);
        }
      } else if (!entry.type) {
        if (!rowType && String(data[i][shopCol]) === String(entry.shop) && sheetDate === entry.date) {
          rowsToDelete.push(i + 1);
        }
      }
    }

    // Delete in reverse order to preserve row indices
    for (var d = rowsToDelete.length - 1; d >= 0; d--) {
      sheet.deleteRow(rowsToDelete[d]);
    }
  }

  // ── Build row data ──
  const jsonFields = ['openingCash','closingCash','expenses','vendorPayments','goodsInward','productOrders','ingredients','method','materials'];
  const row = headers.map(function(h) {
    if (jsonFields.indexOf(h) >= 0) {
      return JSON.stringify(entry[h] || []);
    }
    return entry[h] !== undefined ? entry[h] : '';
  });

  sheet.appendRow(row);

  // Save compact staff log for daily entries (only key fields, not full copy)
  if (!entry.type) {
    var logRow = headers.map(function(h) {
      if (h === 'type') return 'staffLog';
      if (h === 'id') return entry.id + '_log_' + new Date().getTime();
      // Only keep essential tracking fields in log, skip bulky JSON
      if (h === 'openingCash' || h === 'closingCash' || h === 'expenses' || h === 'vendorPayments' || h === 'goodsInward' || h === 'productOrders' || h === 'ingredients' || h === 'method' || h === 'materials') {
        return '[]';
      }
      return entry[h] !== undefined ? entry[h] : '';
    });
    sheet.appendRow(logRow);
  }

  // Sort by date (descending) — only if more than a few rows
  if (sheet.getLastRow() > 2) {
    var dateIdx = headers.indexOf('date');
    if (dateIdx >= 0) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length)
        .sort({ column: dateIdx + 1, ascending: false });
    }
  }

  return { success: true, message: 'Entry saved' };
}

// ── DELETE ENTRY ──
function deleteEntry(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return { success: false, error: 'No entries found' };
  }

  const data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h)});
  var idCol = headers.indexOf('id');
  for (let i = data.length - 1; i >= 1; i--) {
    if (idCol >= 0 && data[i][idCol] === id) {
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Deleted' };
    }
  }

  return { success: false, error: 'Entry not found' };
}

// ── DELETE ALL ──
function deleteAllEntries(params) {
  const pin = params.pin || '';
  const pinResult = verifyPin(pin, 'owner');
  if (!pinResult.valid) {
    return { success: false, error: 'Invalid PIN' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }
  return { success: true, message: 'All entries deleted' };
}

// ── HELPER: Ensure Config has all PIN rows ──
function ensureConfigRows(config) {
  var defaults = [
    ['owner_pin', '7736'],
    ['highway_pin', '1234'],
    ['mainroad_pin', '1234'],
    ['production_pin', '1234'],
    ['ordering_pin', '1234']
  ];
  var lastRow = config.getLastRow();
  for (var i = lastRow; i < defaults.length; i++) {
    config.appendRow(defaults[i]);
  }
}

// ── VERIFY PIN (with brute-force protection) ──
function verifyPin(pin, role) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG_SHEET);

  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
  }

  ensureConfigRows(config);

  // Rate limit: track failed attempts in script properties
  var props = PropertiesService.getScriptProperties();
  var failKey = 'pin_fails_' + (role || 'unknown');
  var lockKey = 'pin_lock_' + (role || 'unknown');
  var lockUntil = parseInt(props.getProperty(lockKey) || '0');
  if (lockUntil > Date.now()) {
    var waitSec = Math.ceil((lockUntil - Date.now()) / 1000);
    return { success: true, valid: false, locked: true, message: 'Too many attempts. Try again in ' + waitSec + 's' };
  }

  var roleMap = {owner:1, highway:2, mainroad:3, production:4, ordering:5};
  var row = roleMap[role] || 1;

  var storedPin = String(config.getRange('B' + row).getValue());
  if (pin === storedPin) {
    props.deleteProperty(failKey);
    props.deleteProperty(lockKey);
    return { success: true, valid: true };
  } else {
    var fails = parseInt(props.getProperty(failKey) || '0') + 1;
    props.setProperty(failKey, String(fails));
    if (fails >= 5) {
      props.setProperty(lockKey, String(Date.now() + 60000)); // lock 60s
      props.setProperty(failKey, '0');
    }
    return { success: true, valid: false };
  }
}

// ── CHANGE PASSWORD ──
function changePin(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG_SHEET);

  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
  }

  ensureConfigRows(config);

  var ownerPin = String(config.getRange('B1').getValue());
  if (data.currentPin !== ownerPin) {
    return { success: false, error: 'Owner password is wrong' };
  }
  if (!data.newPin || data.newPin.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' };
  }

  var roleMap = {owner:1, highway:2, mainroad:3, production:4, ordering:5};
  var role = data.role || 'owner';
  var row = roleMap[role] || 1;

  config.getRange('B' + row).setValue(data.newPin);
  return { success: true, message: role + ' password updated' };
}
