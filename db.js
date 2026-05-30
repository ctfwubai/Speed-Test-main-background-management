const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'speedtest.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_FILE);

// 启用 WAL 模式（大幅提升并发性能）
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    downloadSpeed REAL NOT NULL DEFAULT 0,
    uploadSpeed REAL NOT NULL DEFAULT 0,
    ping REAL NOT NULL DEFAULT 0,
    jitter REAL NOT NULL DEFAULT 0,
    dataUsedDL REAL NOT NULL DEFAULT 0,
    dataUsedUL REAL NOT NULL DEFAULT 0,
    userAgent TEXT NOT NULL DEFAULT '',
    deviceInfo TEXT DEFAULT NULL,
    location TEXT NOT NULL DEFAULT '',
    pointId TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_results_time ON results(time);
  CREATE INDEX IF NOT EXISTS idx_results_ip ON results(ip);
  CREATE INDEX IF NOT EXISTS idx_access_logs_time ON access_logs(time);
  CREATE INDEX IF NOT EXISTS idx_access_logs_ip ON access_logs(ip);
`);

// 预编译常用语句
const insertResult = db.prepare(`
  INSERT INTO results (id, ip, time, downloadSpeed, uploadSpeed, ping, jitter,
    dataUsedDL, dataUsedUL, userAgent, deviceInfo, location, pointId)
  VALUES (@id, @ip, @time, @downloadSpeed, @uploadSpeed, @ping, @jitter,
    @dataUsedDL, @dataUsedUL, @userAgent, @deviceInfo, @location, @pointId)
`);

const insertLog = db.prepare(`
  INSERT INTO access_logs (ip, time, method, path, ua)
  VALUES (@ip, @time, @method, @path, @ua)
`);

// ============================================================
// 测速结果操作
// ============================================================

function addResult(result) {
  insertResult.run({
    id: result.id,
    ip: result.ip,
    time: result.time,
    downloadSpeed: result.downloadSpeed,
    uploadSpeed: result.uploadSpeed,
    ping: result.ping,
    jitter: result.jitter,
    dataUsedDL: result.dataUsedDL,
    dataUsedUL: result.dataUsedUL,
    userAgent: result.userAgent,
    deviceInfo: result.deviceInfo ? JSON.stringify(result.deviceInfo) : null,
    location: result.location,
    pointId: result.pointId,
  });
}

function getResults(options = {}) {
  const {
    page = 1,
    pageSize = 20,
    ipFilter = '',
    sortBy = 'time',
    sortOrder = 'desc',
    limit = 0,
    startDate = '',
    endDate = '',
  } = options;

  // 白名单校验排序字段，防止 SQL 注入
  const allowedSort = { time: 'time', downloadSpeed: 'downloadSpeed', uploadSpeed: 'uploadSpeed', ping: 'ping', id: 'id', ip: 'ip' };
  const sortCol = allowedSort[sortBy] || 'time';
  const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

  let where = '';
  const params = {};
  const clauses = [];
  if (ipFilter) {
    clauses.push('ip LIKE @ipFilter');
    params.ipFilter = `%${ipFilter}%`;
  }
  if (startDate) {
    clauses.push('time >= @startDate');
    // 兼容完整 ISO 时间戳和日期字符串两种格式
    params.startDate = startDate.includes('T') ? startDate : startDate + 'T00:00:00.000Z';
  }
  if (endDate) {
    clauses.push('time <= @endDate');
    params.endDate = endDate.includes('T') ? endDate : endDate + 'T23:59:59.999Z';
  }
  if (clauses.length > 0) {
    where = 'WHERE ' + clauses.join(' AND ');
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM results ${where}`).get(params).count;

  let data;
  if (limit > 0) {
    data = db.prepare(`SELECT * FROM results ${where} ORDER BY ${sortCol} ${sortDir} LIMIT @limit`).all({ ...params, limit });
  } else {
    const offset = (page - 1) * pageSize;
    data = db.prepare(`SELECT * FROM results ${where} ORDER BY ${sortCol} ${sortDir} LIMIT @pageSize OFFSET @offset`).all({ ...params, pageSize, offset });
  }

  // 解析 deviceInfo JSON
  data.forEach(r => {
    if (r.deviceInfo) {
      try { r.deviceInfo = JSON.parse(r.deviceInfo); } catch (e) { r.deviceInfo = null; }
    }
  });

  return { results: data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function getResultById(id) {
  const row = db.prepare('SELECT * FROM results WHERE id = ?').get(id);
  if (!row) return null;
  if (row.deviceInfo) {
    try { row.deviceInfo = JSON.parse(row.deviceInfo); } catch (e) { row.deviceInfo = null; }
  }
  return row;
}

function getResultHistory(ip, excludeId, count = 10) {
  return db.prepare('SELECT * FROM results WHERE ip = ? AND id != ? ORDER BY time DESC LIMIT ?').all(ip, excludeId, count);
}

function getDeviceHistory(deviceId, excludeId, count = 10) {
  return db.prepare("SELECT * FROM results WHERE json_extract(deviceInfo, '$.deviceId') = ? AND id != ? ORDER BY time DESC LIMIT ?").all(deviceId, excludeId, count);
}

function getStats() {
  const totalTests = db.prepare('SELECT COUNT(*) as count FROM results').get().count;
  const uniqueIPs = db.prepare('SELECT COUNT(DISTINCT ip) as count FROM results').get().count;
  const totalVisits = db.prepare('SELECT COUNT(*) as count FROM access_logs').get().count;

  const avgs = db.prepare('SELECT AVG(downloadSpeed) as avgDL, AVG(uploadSpeed) as avgUL, AVG(ping) as avgPing FROM results').get();

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentTests = db.prepare('SELECT COUNT(*) as count FROM results WHERE time > ?').get(dayAgo).count;

  const lastTest = db.prepare('SELECT * FROM results ORDER BY time DESC LIMIT 1').get();
  if (lastTest && lastTest.deviceInfo) {
    try { lastTest.deviceInfo = JSON.parse(lastTest.deviceInfo); } catch (e) { lastTest.deviceInfo = null; }
  }

  return {
    totalTests,
    uniqueIPs,
    avgDownload: (avgs.avgDL || 0).toFixed(2),
    avgUpload: (avgs.avgUL || 0).toFixed(2),
    avgPing: (avgs.avgPing || 0).toFixed(1),
    recentTests,
    totalVisits,
    lastTest: lastTest || null,
  };
}

function getUniqueIPs(ipFilter = '', startDate = '', endDate = '') {
  const whereClauses = [];
  const params = {};
  if (ipFilter) {
    whereClauses.push('r.ip LIKE @ipFilter');
    params.ipFilter = `%${ipFilter}%`;
  }
  if (startDate) {
    whereClauses.push('r.time >= @startDate');
    params.startDate = startDate.includes('T') ? startDate : startDate + 'T00:00:00.000Z';
  }
  if (endDate) {
    whereClauses.push('r.time <= @endDate');
    params.endDate = endDate.includes('T') ? endDate : endDate + 'T23:59:59.999Z';
  }
  const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const ipRows = db.prepare(`
    SELECT r.ip,
      COUNT(*) as testCount,
      AVG(r.downloadSpeed) as avgDownload,
      MAX(r.time) as lastTest
    FROM results r ${whereSQL} GROUP BY r.ip
  `).all(params);

  const visitRows = db.prepare(`
    SELECT ip, COUNT(*) as visitCount, MAX(time) as lastVisit
    FROM access_logs GROUP BY ip
  `).all();

  const visitMap = {};
  visitRows.forEach(v => { visitMap[v.ip] = v; });

  return ipRows.map(r => ({
    ip: r.ip,
    testCount: r.testCount,
    visitCount: (visitMap[r.ip] || {}).visitCount || 0,
    lastTest: r.lastTest,
    lastVisit: (visitMap[r.ip] || {}).lastVisit || null,
    avgDownload: (r.avgDownload || 0).toFixed(2),
  })).sort((a, b) => (b.lastTest || '').localeCompare(a.lastTest || ''));
}

function getDevices(startDate = '', endDate = '') {
  let whereDevice = 'deviceInfo IS NOT NULL AND deviceInfo != \'\'';
  const params = {};
  if (startDate) {
    whereDevice += ' AND time >= @startDate';
    params.startDate = startDate.includes('T') ? startDate : startDate + 'T00:00:00.000Z';
  }
  if (endDate) {
    whereDevice += ' AND time <= @endDate';
    params.endDate = endDate.includes('T') ? endDate : endDate + 'T23:59:59.999Z';
  }

  const rows = db.prepare(`
    SELECT deviceInfo, ip, time, downloadSpeed
    FROM results
    WHERE ${whereDevice}
    ORDER BY time DESC
  `).all(params);

  const deviceMap = {};
  rows.forEach(r => {
    let di;
    try { di = typeof r.deviceInfo === 'string' ? JSON.parse(r.deviceInfo) : r.deviceInfo; } catch (e) { return; }
    if (!di || !di.deviceId) return;

    const did = di.deviceId;
    if (!deviceMap[did]) {
      deviceMap[did] = {
        deviceId: did,
        platform: di.platform || '未知',
        cores: di.cores || '未知',
        memory: di.memory || '未知',
        firstSeen: r.time,
        lastSeen: r.time,
        testCount: 0,
        ips: new Set(),
        avgDownload: 0,
        sumDownload: 0,
      };
    }
    const dev = deviceMap[did];
    dev.ips.add(r.ip);
    dev.testCount++;
    dev.sumDownload += r.downloadSpeed;
    dev.avgDownload = dev.sumDownload / dev.testCount;
    if (r.time > dev.lastSeen) dev.lastSeen = r.time;
    if (r.time < dev.firstSeen) dev.firstSeen = r.time;
  });

  return Object.values(deviceMap).map(d => ({
    ...d,
    ips: Array.from(d.ips),
    avgDownload: d.avgDownload.toFixed(2),
  })).sort((a, b) => a.lastSeen > b.lastSeen ? -1 : 1);
}

function getTrendData(days = 30, tzOffset = 0) {
  const cutoff = new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare('SELECT time, downloadSpeed, uploadSpeed, ping, jitter FROM results WHERE time > ? ORDER BY time').all(cutoff);

  const localDateStr = (utcIso) => {
    const d = new Date(utcIso);
    if (tzOffset) {
      // Apply timezone offset to get local date
      const local = new Date(d.getTime() + tzOffset * 60000);
      return local.toISOString().slice(0, 10);
    }
    return utcIso.slice(0, 10);
  };

  const daily = {};
  rows.forEach(r => {
    const day = localDateStr(r.time);
    if (!daily[day]) daily[day] = { dl: [], ul: [], ping: [], jitter: [] };
    daily[day].dl.push(r.downloadSpeed);
    daily[day].ul.push(r.uploadSpeed);
    daily[day].ping.push(r.ping);
    daily[day].jitter.push(r.jitter);
  });

  return Object.entries(daily).sort().map(([day, v]) => ({
    date: day,
    avgDL: +(v.dl.reduce((a, b) => a + b, 0) / v.dl.length).toFixed(1),
    avgUL: +(v.ul.reduce((a, b) => a + b, 0) / v.ul.length).toFixed(1),
    avgPing: +(v.ping.reduce((a, b) => a + b, 0) / v.ping.length).toFixed(1),
    avgJitter: +(v.jitter.reduce((a, b) => a + b, 0) / v.jitter.length).toFixed(1),
    count: v.dl.length,
    maxDL: +Math.max(...v.dl).toFixed(1),
    minDL: +Math.min(...v.dl).toFixed(1),
  }));
}

function getAllResults() {
  return db.prepare('SELECT * FROM results ORDER BY time DESC').all();
}

function cleanupResults(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM results WHERE time < ?').run(cutoff);
  return result.changes;
}

function clearAll() {
  const removedResults = db.prepare('DELETE FROM results').run().changes;
  const removedLogs = db.prepare('DELETE FROM access_logs').run().changes;
  return { removedResults, removedLogs };
}

// ============================================================
// 访问日志操作
// ============================================================

function addLog(entry) {
  insertLog.run({
    ip: entry.ip,
    time: entry.time,
    method: entry.method,
    path: entry.path,
    ua: entry.ua,
  });

  // 控制日志总量：保留最近 30 条，超出时清理旧记录
  const count = db.prepare('SELECT COUNT(*) as count FROM access_logs').get().count;
  if (count > 30) {
    db.prepare('DELETE FROM access_logs WHERE id <= (SELECT id FROM access_logs ORDER BY id DESC LIMIT 1 OFFSET 29)').run();
  }
}

function getLogs(options = {}) {
  const { page = 1, pageSize = 30, ipFilter = '' } = options;

  let where = '';
  const params = {};
  if (ipFilter) {
    where = 'WHERE ip LIKE @ipFilter';
    params.ipFilter = `%${ipFilter}%`;
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM access_logs ${where}`).get(params).count;
  const offset = (page - 1) * pageSize;

  const logs = db.prepare(`SELECT * FROM access_logs ${where} ORDER BY id DESC LIMIT @pageSize OFFSET @offset`).all({ ...params, pageSize, offset });

  return { logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function getAllLogs() {
  return db.prepare('SELECT * FROM access_logs ORDER BY id DESC').all();
}

function cleanupLogs(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM access_logs WHERE time < ?').run(cutoff);
  return result.changes;
}

// ============================================================
// 导出 CSV 数据
// ============================================================

function getResultsForExport(ipFilter = '', startDate = '', endDate = '') {
  const conditions = [];
  const params = {};
  if (ipFilter) {
    conditions.push('ip LIKE @ipFilter');
    params.ipFilter = `%${ipFilter}%`;
  }
  if (startDate) {
    conditions.push('time >= @startDate');
    params.startDate = startDate.includes('T') ? startDate : startDate + 'T00:00:00.000Z';
  }
  if (endDate) {
    conditions.push('time <= @endDate');
    params.endDate = endDate.includes('T') ? endDate : endDate + 'T23:59:59.999Z';
  }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM results ${where} ORDER BY time DESC`).all(params);
}

function getLogsForExport(ipFilter = '', days = 0) {
  let where = [];
  const params = {};
  if (ipFilter) {
    where.push('ip LIKE @ipFilter');
    params.ipFilter = `%${ipFilter}%`;
  }
  if (days > 0) {
    where.push('time > @cutoff');
    params.cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT * FROM access_logs ${whereClause} ORDER BY id DESC`).all(params);
}

// ============================================================
// 数据库备份（JSON 格式，兼容旧版）
// ============================================================

function backupToJSON() {
  const results = db.prepare('SELECT * FROM results ORDER BY time DESC').all();
  const logs = db.prepare('SELECT * FROM access_logs ORDER BY id DESC').all();

  const fs = require('fs');
  fs.writeFileSync(path.join(DATA_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs, null, 2), 'utf8');

  return { results: results.length, logs: logs.length };
}

// 导出
module.exports = {
  addResult,
  getResults,
  getResultById,
  getResultHistory,
  getDeviceHistory,
  getStats,
  getUniqueIPs,
  getDevices,
  getTrendData,
  getAllResults,
  cleanupResults,
  clearAll,
  addLog,
  getLogs,
  getAllLogs,
  cleanupLogs,
  getResultsForExport,
  getLogsForExport,
  backupToJSON,
  db,
};
