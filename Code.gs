// ═══════════════════════════════════════════════════════════════
// AKSHAY BAKERY TRACKER — Google Apps Script Backend v3
// ═══════════════════════════════════════════════════════════════
const SHEET_NAME = 'Entries';
const CONFIG_SHEET = 'Config';

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

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h){return String(h)});
  const entries = [];
  const jsonFields = ['openingCash','closingCash','expenses','vendorPayments','goodsInward','productOrders','ingredients','method','materials'];
  const numFields = ['shop','openingTotal','closingTotal','upiReceived','totalBilled','walkIns','totalExpenses','totalVendorPayments','totalGoodsInward','cashRetained','qty'];

  for (let i = 1; i < data.length; i++) {
    const row = {};
    headers.forEach((h, j) => {
      let val = data[i][j];
      if (jsonFields.indexOf(h) >= 0) {
        try { val = JSON.parse(val); } catch(e) { val = h.includes('Cash') ? [0,0,0,0,0,0,0] : []; }
      }
      if (numFields.indexOf(h) >= 0) {
        val = Number(val) || 0;
      }
      row[h] = val;
    });
    entries.push(row);
  }

  if (params.role === 'staff') {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 2);
    const cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    return { success: true, data: entries.filter(e => e.date >= cutoffStr) };
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

  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    var idCol = headers.indexOf('id');
    var typeCol = headers.indexOf('type');
    var shopCol = headers.indexOf('shop');
    var dateCol = headers.indexOf('date');
    for (let i = data.length - 1; i >= 1; i--) {
      if (entry.type === 'advanceOrder' || entry.type === 'recipe' || entry.type === 'rawMaterial' || entry.type === 'goodsInward') {
        if (idCol >= 0 && data[i][idCol] === entry.id) {
          sheet.deleteRow(i + 1);
        }
      } else {
        var sheetDate = data[i][dateCol] instanceof Date ? Utilities.formatDate(data[i][dateCol], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(data[i][dateCol]).substring(0,10);
        var rowType = typeCol >= 0 ? data[i][typeCol] : '';
        if (!rowType && data[i][shopCol] == entry.shop && sheetDate == entry.date) {
          sheet.deleteRow(i + 1);
        }
      }
    }
  }

  const jsonFields = ['openingCash','closingCash','expenses','vendorPayments','goodsInward','productOrders','ingredients','method','materials'];
  const row = headers.map(function(h) {
    if (jsonFields.indexOf(h) >= 0) {
      return JSON.stringify(entry[h] || []);
    }
    return entry[h] !== undefined ? entry[h] : '';
  });

  sheet.appendRow(row);

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

// ── VERIFY PIN ──
function verifyPin(pin, role) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG_SHEET);

  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
  }

  ensureConfigRows(config);

  var roleMap = {owner:1, highway:2, mainroad:3, production:4, ordering:5};
  var row = roleMap[role] || 1;

  var storedPin = String(config.getRange('B' + row).getValue());
  return { success: true, valid: pin === storedPin };
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
