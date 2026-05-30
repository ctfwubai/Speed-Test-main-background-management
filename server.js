const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('./db');

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  // 管理密码（默认 admin123，首次启动时自动加密存储）
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  // 服务器端口
  PORT: process.env.PORT || 8080,
  // Session 密钥
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // Session 过期时间（24 小时）
  SESSION_MAX_AGE: 24 * 60 * 60 * 1000,
  // 登录失败锁定阈值
  LOGIN_MAX_ATTEMPTS: 5,
  // 登录失败锁定时间（分钟）
  LOGIN_LOCK_MINUTES: 15,
};

// 以下 JSON 读写函数仅用于 config.json（密码配置）
// 测速结果和访问日志已迁移到 SQLite 数据库 (data/speedtest.db)
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(filePath, defaultValue = []) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return data ? JSON.parse(data) : defaultValue;
    }
  } catch (e) {
    console.error(`读取 ${filePath} 失败:`, e.message);
  }
  return defaultValue;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ============================================================
// 密码管理
// ============================================================
function initPassword() {
  const config = readJSON(CONFIG_FILE, {});
  if (!config.passwordHash) {
    const salt = bcrypt.genSaltSync(10);
    config.passwordHash = bcrypt.hashSync(CONFIG.ADMIN_PASSWORD, salt);
    config.createdAt = new Date().toISOString();
    writeJSON(CONFIG_FILE, config);
    console.log(`[初始化] 管理员密码已设置（默认: ${CONFIG.ADMIN_PASSWORD}）`);
    console.log('[提示] 可通过环境变量 ADMIN_PASSWORD 自定义密码');
  }
  return config;
}

function verifyPassword(password) {
  const config = readJSON(CONFIG_FILE, {});
  return config.passwordHash && bcrypt.compareSync(password, config.passwordHash);
}

function changePassword(newPassword) {
  const config = readJSON(CONFIG_FILE, {});
  const salt = bcrypt.genSaltSync(10);
  config.passwordHash = bcrypt.hashSync(newPassword, salt);
  config.updatedAt = new Date().toISOString();
  writeJSON(CONFIG_FILE, config);
}

// ============================================================
// 速率限制（登录暴力破解防护）
// ============================================================
const loginAttempts = new Map();

function checkLoginRateLimit(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };

  if (record.count >= CONFIG.LOGIN_MAX_ATTEMPTS) {
    const elapsed = (Date.now() - record.lockUntil) / 1000 / 60;
    if (elapsed < CONFIG.LOGIN_LOCK_MINUTES) {
      return {
        allowed: false,
        remainingMinutes: Math.ceil(CONFIG.LOGIN_LOCK_MINUTES - elapsed),
      };
    }
    // 锁定时间已过，重置
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  if (success) {
    loginAttempts.delete(ip);
    return;
  }

  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= CONFIG.LOGIN_MAX_ATTEMPTS) {
    record.lockUntil = Date.now() + CONFIG.LOGIN_LOCK_MINUTES * 60 * 1000;
  }
  loginAttempts.set(ip, record);
}

// ============================================================
// 访问日志
// ============================================================
function logAccess(req, res, next) {
  // 跳过静态资源日志（避免刷屏）
  const skipExtensions = ['.js', '.css', '.svg', '.png', '.ico', '.woff', '.woff2', '.eot', '.ttf', '.webmanifest', '.xml'];
  const ext = path.extname(req.path).toLowerCase();
  if (skipExtensions.includes(ext)) {
    return next();
  }

  const entry = {
    ip: req.ip || req.connection.remoteAddress,
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ua: req.get('User-Agent') || 'Unknown',
  };

  // 异步写入日志
  setImmediate(() => {
    try {
      db.addLog(entry);
    } catch (e) {
      console.error('写入访问日志失败:', e.message);
    }
  });

  next();
}

// ============================================================
// Express 应用
// ============================================================
const app = express();

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(logAccess);

// Session 配置
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: CONFIG.SESSION_MAX_AGE,
    sameSite: 'lax',
  },
}));

// ============================================================
// 认证中间件
// ============================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // API 请求返回 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '未登录', redirect: '/console/login.html' });
  }
  // 页面请求重定向到登录页（带原路径，方便登录后跳回）
  const redirectUrl = '/console/login.html?redirect=' + encodeURIComponent(req.originalUrl);
  res.redirect(redirectUrl);
}

// ============================================================
// 静态文件服务
// ============================================================

// 1. 登录页面 - 不需要认证
app.use('/console/login.html', express.static(path.join(__dirname, 'console/login.html')));

// 2. 管理后台页面 - 需要认证
app.use('/console', requireAuth, express.static(path.join(__dirname, 'console')));

// 2. 测速核心文件（index.html + 资源）- 需要认证
app.use('/assets', requireAuth, express.static(path.join(__dirname, 'assets')));

// 下载测速：动态生成随机数据，替代静态文件
const DOWNLOAD_DATA_SIZE = 10 * 1024 * 1024; // 10MB
const downloadData = Buffer.alloc(DOWNLOAD_DATA_SIZE);
// 用随机数据填充一次（实际速度测试不需要真随机，用简单模式足够）
for (let i = 0; i < DOWNLOAD_DATA_SIZE; i += 1024) {
  downloadData.write(i % 65536 < 32768 ? 'SPEEDTEST_DATA_0123456789ABCDEF' : 'abcdefghijklmnopqrstuvwxyz', i, Math.min(32, DOWNLOAD_DATA_SIZE - i), 'ascii');
}
app.use('/downloading', requireAuth, (req, res) => {
  // OpenSpeedTest 引擎会请求 /downloading/random* 进行下载测速
  // 返回大块数据，不缓存，支持 Range 请求（用于多线程下载）
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', DOWNLOAD_DATA_SIZE);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const match = range.replace(/bytes=/, '').match(/^(\d+)-(\d*)$/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : DOWNLOAD_DATA_SIZE - 1;
      const chunkSize = Math.min(end - start + 1, DOWNLOAD_DATA_SIZE - start);
      if (chunkSize > 0 && start < DOWNLOAD_DATA_SIZE) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${start + chunkSize - 1}/${DOWNLOAD_DATA_SIZE}`);
        res.setHeader('Content-Length', chunkSize);
        return res.end(downloadData.slice(start, start + chunkSize));
      }
    }
  }
  res.end(downloadData);
});

// 3. 上传端点 - 测速用，需要认证
app.use('/upload', requireAuth, (req, res, next) => {
  // 测速工具会 POST 大量垃圾数据到 /upload 用于上行测速
  // 我们只需要接收并丢弃即可
  if (req.method === 'POST') {
    let dataSize = 0;
    req.on('data', (chunk) => { dataSize += chunk.length; });
    req.on('end', () => {
      res.status(200).send('OK');
    });
    return;
  }
  // GET/HEAD 请求用于 ping 测试
  res.status(200).send('OK');
});

// 4. index.html - 动态注入配置（禁用缓存，确保每次都获取最新）
app.get('/', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(generateIndexHTML(req));
});

// ============================================================
// API: 保存测速结果
// ============================================================
app.post('/api/save-result', requireAuth, async (req, res) => {
  try {
    let data = req.body;

    // 兼容 URL 编码格式
    if (typeof data === 'string') {
      const params = new URLSearchParams(data);
      data = Object.fromEntries(params.entries());
    }

    // 安全处理：qs 解析重复 key 可能产生数组，转为首个字符串值
    function safeStr(v) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return String(v[0] || '');
      return '';
    }

    const result = {
      id: generateId(),
      ip: req.ip || req.connection.remoteAddress,
      time: new Date().toISOString(),
      downloadSpeed: parseFloat(data.d) || 0,
      uploadSpeed: parseFloat(data.u) || 0,
      ping: parseFloat(data.p) || 0,
      jitter: parseFloat(data.jit || data.j) || 0,
      dataUsedDL: parseFloat(data.dd) || 0,
      dataUsedUL: parseFloat(data.ud) || 0,
      userAgent: safeStr(data.ua) || (req.get('User-Agent') || ''),
      deviceInfo: parseDeviceInfo(data.dev),
      location: safeStr(data.loc),
      pointId: safeStr(data.pid),
    };

    db.addResult(result);

    res.json({ status: 'ok', id: result.id });
  } catch (e) {
    console.error('保存结果失败:', e.message);
    res.status(500).json({ error: '保存失败' });
  }
});

// ============================================================
// API: 登录/登出
// ============================================================
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  // 检查速率限制
  const rateCheck = checkLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `登录尝试过于频繁，请 ${rateCheck.remainingMinutes} 分钟后重试`,
      remainingMinutes: rateCheck.remainingMinutes,
    });
  }

  const { password, redirect } = req.body;
  if (!password) {
    return res.status(400).json({ error: '请输入密码' });
  }

  if (verifyPassword(password)) {
    req.session.authenticated = true;
    req.session.loginTime = new Date().toISOString();
    recordLoginAttempt(ip, true);
    const target = redirect || '/';
    res.json({ status: 'ok', redirect: target });
  } else {
    recordLoginAttempt(ip, false);
    const attempts = (loginAttempts.get(ip) || {}).count || 0;
    const remaining = CONFIG.LOGIN_MAX_ATTEMPTS - attempts;
    res.status(401).json({
      error: `密码错误${remaining > 0 ? `，还剩 ${remaining} 次尝试机会` : '，账户已临时锁定'}`,
      remainingAttempts: Math.max(0, remaining),
    });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ status: 'ok' });
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ============================================================
// 健康检查（用于 Docker 容器监控）
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

// ============================================================
// API: 修改密码
// ============================================================
app.post('/api/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!verifyPassword(oldPassword)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密码长度至少 4 位' });
  }
  changePassword(newPassword);
  res.json({ status: 'ok', message: '密码已更新' });
});

// ============================================================
// API: 获取数据（管理后台）
// ============================================================
app.get('/api/stats', requireAuth, (req, res) => {
  const stats = db.getStats();
  res.json(stats);
});

app.get('/api/results', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const ipFilter = req.query.ip || '';
  const sortBy = req.query.sortBy || 'time';
  const sortOrder = req.query.sortOrder || 'desc';
  const limit = parseInt(req.query.limit) || 0;
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';

  const result = db.getResults({ page, pageSize, ipFilter, sortBy, sortOrder, limit, startDate, endDate });
  res.json(result);
});

app.get('/api/results/:id', requireAuth, (req, res) => {
  const result = db.getResultById(req.params.id);
  if (!result) return res.status(404).json({ error: '未找到' });

  const history = db.getResultHistory(result.ip, result.id, 10);
  const deviceHistory = result.deviceInfo && result.deviceInfo.deviceId
    ? db.getDeviceHistory(result.deviceInfo.deviceId, result.id, 10)
    : [];

  res.json({ result, history, deviceHistory });
});

// ============================================================
// API: 设备统计
// ============================================================
app.get('/api/devices', requireAuth, (req, res) => {
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  res.json(db.getDevices(startDate, endDate));
});

app.get('/api/logs', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 30;
  const ipFilter = req.query.ip || '';

  const result = db.getLogs({ page, pageSize, ipFilter });
  res.json(result);
});

app.get('/api/unique-ips', requireAuth, (req, res) => {
  const ipFilter = req.query.ip || '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  res.json(db.getUniqueIPs(ipFilter, startDate, endDate));
});

// ============================================================
// API: 导出 CSV
// ============================================================
app.get('/api/export/csv', requireAuth, (req, res) => {
  const ipFilter = req.query.ip || '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const filtered = db.getResultsForExport(ipFilter, startDate, endDate);

  const headers = ['测试ID', 'IP地址', '测试时间', '下载速度(Mbps)', '上传速度(Mbps)', '延迟(ms)', '抖动(ms)', '下载数据量(MB)', '上传数据量(MB)', '测速位置', '信息点编号', '用户代理'];
  const rows = filtered.map(r => [
    r.id,
    r.ip,
    r.time,
    r.downloadSpeed.toFixed(2),
    r.uploadSpeed.toFixed(2),
    r.ping.toFixed(1),
    r.jitter.toFixed(1),
    r.dataUsedDL ? r.dataUsedDL.toFixed(2) : '0',
    r.dataUsedUL ? r.dataUsedUL.toFixed(2) : '0',
    `"${(r.location || '').replace(/"/g, '""')}"`,
    `"${(r.pointId || '').replace(/"/g, '""')}"`,
    `"${(r.userAgent || '').replace(/"/g, '""')}"`,
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=speedtest-results-${new Date().toISOString().slice(0, 10)}.csv`);
  // 添加 BOM 以支持 Excel 中文
  res.send('\ufeff' + csv);
});

// ============================================================
// API: 导出报告 (PDF)
// ============================================================
app.get('/api/export/report/:id', requireAuth, (req, res) => {
  const result = db.getResultById(req.params.id);
  if (!result) return res.status(404).json({ error: '未找到该测速记录' });

  // 获取同一 IP 的历史记录
  const results = db.getAllResults();
  const ipResults = results.filter(r => r.ip === result.ip);
  const avgDL = ipResults.reduce((s, r) => s + r.downloadSpeed, 0) / ipResults.length;
  const avgUL = ipResults.reduce((s, r) => s + r.uploadSpeed, 0) / ipResults.length;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: 40, bottom: 40, left: 45, right: 45 },
    info: {
      Title: `网络测速报告 - ${result.id}`,
      Author: '企业内网测速系统',
      Subject: 'Network Speed Test Report',
    },
  });

  // 文件名：测速位置_信息点编号_日期时间_流水号.pdf
  const fnLoc = (result.location || '未知位置').replace(/[/\\?%*:|"<>]/g, '_');
  const fnPid = (result.pointId || '未知编号').replace(/[/\\?%*:|"<>]/g, '_');
  const fnDate = new Date(result.time).toISOString().slice(0, 19).replace(/[T:]/g, '');
  const fnId = result.id;
  const fileName = `测速报告_${fnLoc}_${fnPid}_${fnDate}_${fnId}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

  // PDF 生成错误处理
  let pdfError = null;
  doc.on('error', (err) => {
    pdfError = err;
    console.error('[PDF] 生成错误:', err.message);
    if (!res.headersSent) {
      try { res.status(500).json({ error: 'PDF 生成失败: ' + err.message }); } catch(e) {}
    }
  });

  doc.pipe(res);

  try {
    const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    let y = doc.page.margins.top;

  // ==================== 辅助函数 ====================
  function fmt(n, d = 1) { return Number(n).toFixed(d); }

  // ==================== 注册字体 ====================
  let fontRegular, fontBold;

  const TTF_CANDIDATES = [
    { path: 'C:\\Windows\\Fonts\\simhei.ttf', regular: true, bold: false },
    { path: '/System/Library/Fonts/PingFang.ttc', regular: true, bold: false },
    { path: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', regular: true, bold: false },
  ];

  for (const c of TTF_CANDIDATES) {
    if (fontRegular && fontBold) break;
    try {
      if (!fs.existsSync(c.path)) continue;
      if (!fontRegular && c.regular) {
        doc.registerFont('Chinese', c.path);
        fontRegular = 'Chinese';
      }
      if (!fontBold && c.bold) {
        doc.registerFont('ChineseBold', c.path);
        fontBold = 'ChineseBold';
      }
    } catch (e) {}
  }

  if (!fontBold && fontRegular) fontBold = fontRegular;

  const FONT = fontRegular || 'Helvetica';
  const FONT_BOLD = fontBold || FONT;
  const ML = doc.page.margins.left;

  // ==================== 头部 ====================
  const headerH = 105;
  const headerGrad = doc.linearGradient(0, 0, doc.page.width, headerH);
  headerGrad.stop(0, '#667eea');
  headerGrad.stop(1, '#764ba2');
  doc.rect(0, 0, doc.page.width, headerH).fill(headerGrad);

  // 标题居中
  doc.font(FONT_BOLD).fontSize(22).fillColor('#ffffff');
  doc.text('网络测速报告', ML, 22, { align: 'center', width: PAGE_W });

  doc.font(FONT).fontSize(10).fillColor('#ffffff', 0.85);
  doc.text('Network Speed Test Report', ML, 48, { align: 'center', width: PAGE_W });

  // 评分
  const g = getGrade(result.downloadSpeed);
  doc.font(FONT_BOLD).fontSize(32).fillColor('#ffffff');
  doc.text(g, ML, 64, { align: 'center', width: PAGE_W });

  // ==================== 核心指标 ====================
  y = headerH + 10;
  const metrics = [
    { label: '下载速度', value: fmt(result.downloadSpeed) + ' Mbps', color: '#339af0' },
    { label: '上传速度', value: fmt(result.uploadSpeed) + ' Mbps', color: '#20c997' },
    { label: '延迟 (Ping)', value: fmt(result.ping, 1) + ' ms', color: '#fcc419' },
    { label: '抖动 (Jitter)', value: fmt(result.jitter, 1) + ' ms', color: '#ff6b6b' },
  ];

  const mColW = (PAGE_W - 10) / 2;
  const mRowH = 52;

  metrics.forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const mx = ML + col * (mColW + 4);
    const my = y + row * (mRowH + 4);

    doc.roundedRect(mx, my, mColW, mRowH, 6).fill('#f8f9fa');
    doc.font(FONT).fontSize(8).fillColor('#868e96');
    doc.text(m.label, mx, my + 6, { align: 'center', width: mColW });
    doc.font(FONT_BOLD).fontSize(16).fillColor(m.color);
    doc.text(m.value, mx, my + 20, { align: 'center', width: mColW });
  });

  y += 2 * (mRowH + 4) + 10;

  // ==================== 测试详情（含测速位置 & 信息点编号） ====================
  y = drawSectionCompact(doc, FONT, FONT_BOLD, '测试详情', y);

  const loc = result.location || '';
  const pid = result.pointId || '';

  const details = [];
  if (loc) details.push(['测速位置', loc]);
  if (pid) details.push(['信息点编号', pid]);
  details.push(['测试 ID', result.id]);
  details.push(['客户端 IP', result.ip]);
  details.push(['设备 ID', result.deviceInfo && result.deviceInfo.deviceId ? result.deviceInfo.deviceId.slice(0, 8) + '...' : '未采集']);
  details.push(['操作系统/平台', result.deviceInfo && result.deviceInfo.platform || '未知']);
  details.push(['测试时间', new Date(result.time).toLocaleString('zh-CN')]);
  details.push(['下载数据量', result.dataUsedDL ? fmt(result.dataUsedDL, 2) + ' MB' : '未知']);
  details.push(['上传数据量', result.dataUsedUL ? fmt(result.dataUsedUL, 2) + ' MB' : '未知']);

  if (result.deviceInfo) {
    const di = result.deviceInfo;
    if (di.cores) details.push(['CPU 核心数', di.cores + ' 核']);
    if (di.memory) details.push(['内存大小', di.memory + ' GB']);
    if (di.timezone) details.push(['时区', di.timezone]);
    if (di.screen) details.push(['屏幕分辨率', di.screen]);
  }

  const labelW = 105;
  const valueX = ML + labelW + 8;
  const valueW = PAGE_W - labelW - 8;

  details.forEach(([k, v]) => {
    doc.font(FONT).fontSize(8.5).fillColor('#495057');
    doc.text(k, ML, y + 1);
    doc.font(FONT).fontSize(8.5).fillColor('#212529');
    doc.text(v, valueX, y + 1, { width: valueW });
    y += 17;
    doc.moveTo(ML, y).lineTo(ML + PAGE_W, y).strokeColor('#e9ecef').lineWidth(0.5).stroke();
  });

  y += 6;

  // ==================== 网络质量评估（含评级标准） ====================
  y = drawSectionCompact(doc, FONT, FONT_BOLD, '网络质量评估', y);

  const qualityRows = [
    ['综合评级', getGrade(result.downloadSpeed)],
    ['延迟质量', getPingQuality(result.ping)],
    ['抖动水平', result.jitter < 2 ? '极稳定' : result.jitter < 5 ? '稳定' : result.jitter < 10 ? '一般' : '不稳定'],
    ['该 IP 测试次数', ipResults.length + ' 次'],
    ['历史平均下载', ipResults.length > 0 ? fmt(avgDL, 2) + ' Mbps' : '-'],
    ['历史平均上传', ipResults.length > 0 ? fmt(avgUL, 2) + ' Mbps' : '-'],
  ];

  qualityRows.forEach(([k, v]) => {
    doc.font(FONT).fontSize(8.5).fillColor('#495057');
    doc.text(k, ML, y + 1);
    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#212529');
    doc.text(v, valueX, y + 1, { width: valueW });
    y += 17;
  });

  y += 4;

  // ==================== 评级参考标准 ====================
  y = drawSectionCompact(doc, FONT, FONT_BOLD, '评级参考标准（下载速度）', y);
  getGradeStandards().forEach(line => {
    doc.font(FONT).fontSize(7.5).fillColor('#868e96');
    doc.text(line, ML + 4, y + 1, { width: PAGE_W - 4 });
    y += 13;
  });

  // ==================== 页脚 ====================
  doc.font(FONT).fontSize(7).fillColor('#adb5bd');
  doc.text(
    `企业内网测速系统 · ${new Date().toLocaleString('zh-CN')} · ID: ${result.id}`,
    ML,
    doc.page.height - doc.page.margins.bottom - 15,
    { align: 'center', width: PAGE_W }
  );

  doc.end();
  } catch (err) {
    console.error('[PDF] 同步错误:', err.message);
    if (!res.headersSent) {
      try { res.status(500).json({ error: 'PDF 生成失败: ' + err.message }); } catch(e) {}
    }
  }
});

// ============================================================
// API: 批量导出 PDF
// ============================================================
app.post('/api/export/batch-pdf', requireAuth, (req, res) => {
  const results = db.getAllResults();
  const ids = req.body.ids || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要导出的记录' });
  }

  const selected = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
  if (selected.length === 0) {
    return res.status(404).json({ error: '未找到所选记录' });
  }

  const doc = new PDFDocument({
    size: 'A4', layout: 'portrait',
    margins: { top: 40, bottom: 40, left: 45, right: 45 },
    info: { Title: `批量测速报告 - ${selected.length} 条记录`, Author: '企业内网测速系统' },
  });

  // 文件名：日期_流水号.pdf
  const batchDate = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '');
  const fileName = `批量测速报告_${batchDate}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

  let pdfError = null;
  doc.on('error', (err) => { pdfError = err; if (!res.headersSent) { try { res.status(500).json({ error: 'PDF 生成失败' }); } catch(e) {} } });
  doc.pipe(res);

  try {
    let fontR, fontB;
    const fontPaths = [
      'C:\\Windows\\Fonts\\simhei.ttf',
      '/System/Library/Fonts/PingFang.ttc',
      '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    ];
    for (const p of fontPaths) {
      try { if (fs.existsSync(p)) { if (!fontR) { doc.registerFont('F', p); fontR = 'F'; } } } catch(e) {}
    }
    if (!fontR) { fontR = 'Helvetica'; fontB = 'Helvetica-Bold'; }
    else fontB = fontR;

    const F = fontR, FB = fontB;
    const ML = doc.page.margins.left;
    const PW = doc.page.width - ML - doc.page.margins.right;

    selected.forEach((r, idx) => {
      if (idx > 0) doc.addPage();

      const ipResults = results.filter(x => x.ip === r.ip);
      const avgDL = ipResults.reduce((s, x) => s + x.downloadSpeed, 0) / ipResults.length;
      const g = getGrade(r.downloadSpeed);
      const loc = r.location || '';
      const pid = r.pointId || '';

      // ==================== 头部 ====================
      const hg = doc.linearGradient(0, 0, doc.page.width, 105);
      hg.stop(0, '#667eea'); hg.stop(1, '#764ba2');
      doc.rect(0, 0, doc.page.width, 105).fill(hg);
      doc.font(FB).fontSize(22).fillColor('#ffffff');
      doc.text('网络测速报告', ML, 22, { align: 'center', width: PW });
      doc.font(F).fontSize(10).fillColor('#ffffff', 0.85);
      doc.text('Network Speed Test Report', ML, 48, { align: 'center', width: PW });
      doc.font(FB).fontSize(32).fillColor('#ffffff');
      doc.text(g, ML, 64, { align: 'center', width: PW });

      // ==================== 核心指标 ====================
      let y = 115;
      const mcw = (PW - 10) / 2;
      const mh = 52;
      const mData = [
        { l: '下载速度', v: r.downloadSpeed.toFixed(1) + ' Mbps', c: '#339af0' },
        { l: '上传速度', v: r.uploadSpeed.toFixed(1) + ' Mbps', c: '#20c997' },
        { l: '延迟 (Ping)', v: r.ping.toFixed(1) + ' ms', c: '#fcc419' },
        { l: '抖动 (Jitter)', v: r.jitter.toFixed(1) + ' ms', c: '#ff6b6b' },
      ];
      mData.forEach((m, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const mx = ML + col * (mcw + 4), my = y + row * (mh + 4);
        doc.roundedRect(mx, my, mcw, mh, 6).fill('#f8f9fa');
        doc.font(F).fontSize(8).fillColor('#868e96');
        doc.text(m.l, mx, my + 5, { align: 'center', width: mcw });
        doc.font(FB).fontSize(15).fillColor(m.c);
        doc.text(m.v, mx, my + 19, { align: 'center', width: mcw });
      });
      y += 2 * (mh + 4) + 8;

      // ==================== 测试详情 ====================
      doc.font(FB).fontSize(10).fillColor('#333');
      doc.text('测试详情', ML, y);
      doc.moveTo(ML, y + 16).lineTo(ML + 50, y + 16).strokeColor('#667eea').lineWidth(1.5).stroke();
      y += 22;

      const lw = 105;
      const vx = ML + lw + 8;
      const vw = PW - lw - 8;
      const dets = [];
      if (loc) dets.push(['测速位置', loc]);
      if (pid) dets.push(['信息点编号', pid]);
      dets.push(['测试 ID', r.id]);
      dets.push(['客户端 IP', r.ip]);
      dets.push(['测试时间', new Date(r.time).toLocaleString('zh-CN')]);
      dets.push(['下载数据量', r.dataUsedDL ? r.dataUsedDL.toFixed(2) + ' MB' : '-']);
      dets.push(['上传数据量', r.dataUsedUL ? r.dataUsedUL.toFixed(2) + ' MB' : '-']);

      dets.forEach(([k, v]) => {
        doc.font(F).fontSize(8.5).fillColor('#495057');
        doc.text(k, ML, y);
        doc.font(F).fontSize(8.5).fillColor('#212529');
        doc.text(v, vx, y, { width: vw });
        y += 17;
        doc.moveTo(ML, y).lineTo(ML + PW, y).strokeColor('#e9ecef').lineWidth(0.5).stroke();
      });
      y += 6;

      // ==================== 网络质量评估（含评级标准） ====================
      doc.font(FB).fontSize(10).fillColor('#333');
      doc.text('网络质量评估', ML, y);
      doc.moveTo(ML, y + 16).lineTo(ML + 50, y + 16).strokeColor('#667eea').lineWidth(1.5).stroke();
      y += 22;

      const qRows = [
        ['综合评级', g],
        ['延迟质量', getPingQuality(r.ping)],
        ['抖动水平', r.jitter < 2 ? '极稳定' : r.jitter < 5 ? '稳定' : r.jitter < 10 ? '一般' : '不稳定'],
        ['该 IP 测试次数', ipResults.length + ' 次'],
        ['本页序号', (idx + 1) + ' / ' + selected.length],
      ];
      qRows.forEach(([k, v]) => {
        doc.font(F).fontSize(8.5).fillColor('#495057');
        doc.text(k, ML, y);
        doc.font(FB).fontSize(8.5).fillColor('#212529');
        doc.text(v, vx, y, { width: vw });
        y += 17;
      });

      y += 4;

      // ==================== 评级参考标准 ====================
      doc.font(FB).fontSize(9).fillColor('#333');
      doc.text('评级参考标准（下载速度）', ML, y);
      doc.moveTo(ML, y + 15).lineTo(ML + 50, y + 15).strokeColor('#667eea').lineWidth(1).stroke();
      y += 20;
      getGradeStandards().forEach(line => {
        doc.font(F).fontSize(7.5).fillColor('#868e96');
        doc.text(line, ML + 4, y, { width: PW - 4 });
        y += 13;
      });

      // ==================== 页脚 ====================
      doc.font(F).fontSize(7).fillColor('#adb5bd');
      doc.text(
        `企业内网测速系统 · ${new Date().toLocaleString('zh-CN')} · ID: ${r.id}`,
        ML, doc.page.height - doc.page.margins.bottom - 15,
        { align: 'center', width: PW }
      );
    });

    doc.end();
  } catch (err) {
    console.error('[PDF Batch] 错误:', err.message);
    if (!res.headersSent) { try { res.status(500).json({ error: '批量 PDF 生成失败' }); } catch(e) {} }
  }
});

// ============================================================
// API: 导出 HTML 专业测速报告
// ============================================================
app.get('/api/export/html-report/:id', requireAuth, (req, res) => {
  const result = db.getResultById(req.params.id);
  if (!result) return res.status(404).json({ error: '未找到该测速记录' });

  const results = db.getAllResults();
  const ipResults = results.filter(r => r.ip === result.ip);
  const avgDL = ipResults.reduce((s, r) => s + r.downloadSpeed, 0) / ipResults.length;
  const avgUL = ipResults.reduce((s, r) => s + r.uploadSpeed, 0) / ipResults.length;
  const maxDL = Math.max(...ipResults.map(r => r.downloadSpeed));
  const minDL = Math.min(...ipResults.map(r => r.downloadSpeed));
  const recentHistory = ipResults.slice(-10).reverse();

  const grade = getGrade(result.downloadSpeed);
  const pingQ = getPingQuality(result.ping);
  const jitterQ = result.jitter < 2 ? '极稳定' : result.jitter < 5 ? '稳定' : result.jitter < 10 ? '一般' : '不稳定';
  const suggestions = getSuggestions(result);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>网络测速报告 - ${result.id}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #212529; }
  .report { max-width: 900px; margin: 24px auto; background: white; border-radius: 16px; box-shadow: 0 2px 20px rgba(0,0,0,0.08); overflow: hidden; }
  .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; color: white; text-align: center; }
  .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
  .header .sub { font-size: 14px; opacity: 0.8; }
  .header .grade { font-size: 56px; font-weight: 800; margin: 12px 0 4px; letter-spacing: 4px; }
  .header .grade-label { font-size: 13px; opacity: 0.7; }
  .section { padding: 28px 32px; border-bottom: 1px solid #f1f3f5; }
  .section:last-child { border-bottom: none; }
  .section h2 { font-size: 16px; font-weight: 600; color: #333; margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }
  .section h2::before { content: ''; display: inline-block; width: 4px; height: 18px; background: #667eea; border-radius: 2px; }
  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .metric-card { background: #f8f9fa; border-radius: 10px; padding: 18px; text-align: center; }
  .metric-card .label { font-size: 12px; color: #868e96; margin-bottom: 4px; }
  .metric-card .value { font-size: 26px; font-weight: 700; }
  .metric-card .unit { font-size: 14px; font-weight: 400; color: #868e96; }
  .metric-card.dl .value { color: #339af0; }
  .metric-card.ul .value { color: #20c997; }
  .metric-card.ping .value { color: #fcc419; }
  .metric-card.jitter .value { color: #ff6b6b; }
  .info-table { width: 100%; border-collapse: collapse; }
  .info-table th, .info-table td { padding: 10px 0; border-bottom: 1px solid #f1f3f5; font-size: 14px; text-align: left; }
  .info-table th { color: #868e96; font-weight: 500; width: 140px; }
  .info-table td { color: #212529; }
  .quality-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f1f3f5; }
  .quality-item:last-child { border-bottom: none; }
  .quality-item .label { font-size: 14px; color: #495057; }
  .quality-item .score { font-size: 14px; font-weight: 600; }
  .quality-item .score.good { color: #2f9e44; }
  .quality-item .score.warn { color: #f59f00; }
  .quality-item .score.bad { color: #e03131; }
  .suggestion { padding: 14px 16px; background: #f8f9fa; border-radius: 8px; margin-bottom: 8px; font-size: 14px; line-height: 1.6; }
  .suggestion:last-child { margin-bottom: 0; }
  .suggestion .icon { margin-right: 8px; }
  .history-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .history-table th { padding: 8px 10px; text-align: left; color: #868e96; font-weight: 600; border-bottom: 2px solid #e9ecef; font-size: 12px; }
  .history-table td { padding: 8px 10px; border-bottom: 1px solid #f1f3f5; }
  .history-table tr:hover td { background: #f8f9fa; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
  .badge-dl { color: #339af0; background: #e7f5ff; }
  .badge-ul { color: #20c997; background: #e6fcf5; }
  .badge-ping { color: #f59f00; background: #fff9db; }
  .footer { text-align: center; padding: 20px 32px; font-size: 12px; color: #adb5bd; }
  .print-btn { display: inline-block; margin-top: 16px; padding: 10px 28px; background: #667eea; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; text-decoration: none; }
  .print-btn:hover { background: #5a6fd6; }
  @media print {
    body { background: white; }
    .report { margin: 0; box-shadow: none; border-radius: 0; }
    .print-btn { display: none; }
    .section { break-inside: avoid; }
  }
  @media (max-width: 600px) {
    .report { margin: 0; border-radius: 0; }
    .header { padding: 24px 16px; }
    .header h1 { font-size: 22px; }
    .header .grade { font-size: 42px; }
    .section { padding: 20px 16px; }
    .metrics { grid-template-columns: 1fr 1fr; gap: 8px; }
    .metric-card { padding: 14px; }
    .metric-card .value { font-size: 20px; }
    .info-table th { width: 100px; font-size: 13px; }
    .info-table td { font-size: 13px; }
  }
</style>
</head>
<body>
  <div class="report">
    <div class="header">
      <h1>网络测速报告</h1>
      <div class="sub">Network Speed Test Report</div>
      <div class="grade">${grade}</div>
      <div class="grade-label">综合评级</div>
    </div>

    <div class="section">
      <h2>核心指标</h2>
      <div class="metrics">
        <div class="metric-card dl">
          <div class="label">下载速度</div>
          <div class="value">${result.downloadSpeed.toFixed(1)} <span class="unit">Mbps</span></div>
        </div>
        <div class="metric-card ul">
          <div class="label">上传速度</div>
          <div class="value">${result.uploadSpeed.toFixed(1)} <span class="unit">Mbps</span></div>
        </div>
        <div class="metric-card ping">
          <div class="label">延迟 (Ping)</div>
          <div class="value">${result.ping.toFixed(1)} <span class="unit">ms</span></div>
        </div>
        <div class="metric-card jitter">
          <div class="label">抖动 (Jitter)</div>
          <div class="value">${result.jitter.toFixed(1)} <span class="unit">ms</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>测试详情</h2>
      <table class="info-table">
        <tr><th>测试 ID</th><td>${result.id}</td></tr>
        <tr><th>客户端 IP</th><td style="font-family:monospace">${result.ip}</td></tr>
        <tr><th>设备 ID</th><td style="font-family:monospace;font-size:12px">${result.deviceInfo && result.deviceInfo.deviceId ? result.deviceInfo.deviceId : '未采集'}</td></tr>
        <tr><th>操作系统</th><td>${result.deviceInfo && result.deviceInfo.platform || '未知'}</td></tr>
        <tr><th>测试时间</th><td>${new Date(result.time).toLocaleString('zh-CN')}</td></tr>
        <tr><th>下载数据量</th><td>${result.dataUsedDL ? result.dataUsedDL.toFixed(2) + ' MB' : '未知'}</td></tr>
        <tr><th>上传数据量</th><td>${result.dataUsedUL ? result.dataUsedUL.toFixed(2) + ' MB' : '未知'}</td></tr>
        ${result.deviceInfo && result.deviceInfo.cores ? `<tr><th>CPU 核心数</th><td>${result.deviceInfo.cores} 核</td></tr>` : ''}
        ${result.deviceInfo && result.deviceInfo.memory ? `<tr><th>内存大小</th><td>${result.deviceInfo.memory} GB</td></tr>` : ''}
        ${result.deviceInfo && result.deviceInfo.timezone ? `<tr><th>时区</th><td>${result.deviceInfo.timezone}</td></tr>` : ''}
        ${result.deviceInfo && result.deviceInfo.screen ? `<tr><th>屏幕分辨率</th><td>${result.deviceInfo.screen}</td></tr>` : ''}
      </table>
    </div>

    <div class="section">
      <h2>网络质量评估</h2>
      <div class="quality-item">
        <span class="label">综合评级</span>
        <span class="score ${grade === 'A+' || grade === 'A' ? 'good' : grade === 'B' ? 'warn' : 'bad'}">${grade}</span>
      </div>
      <div class="quality-item">
        <span class="label">延迟质量</span>
        <span class="score ${pingQ === '极佳' || pingQ === '优秀' ? 'good' : pingQ === '良好' ? 'warn' : 'bad'}">${pingQ}</span>
      </div>
      <div class="quality-item">
        <span class="label">抖动水平</span>
        <span class="score ${jitterQ === '极稳定' || jitterQ === '稳定' ? 'good' : jitterQ === '一般' ? 'warn' : 'bad'}">${jitterQ}</span>
      </div>
      <div class="quality-item">
        <span class="label">该 IP 测试次数</span>
        <span class="score">${ipResults.length} 次</span>
      </div>
      <div class="quality-item">
        <span class="label">历史平均下载</span>
        <span class="score">${avgDL.toFixed(1)} Mbps</span>
      </div>
      <div class="quality-item">
        <span class="label">历史最高下载</span>
        <span class="score">${maxDL.toFixed(1)} Mbps</span>
      </div>
      <div class="quality-item">
        <span class="label">历史最低下载</span>
        <span class="score">${minDL.toFixed(1)} Mbps</span>
      </div>
      <div class="quality-item">
        <span class="label">当前排名</span>
        <span class="score">${ipResults.length > 1 ? `高于 ${Math.round((ipResults.filter(r => r.downloadSpeed > result.downloadSpeed).length / ipResults.length) * 100)}% 的历史记录` : '首次测试'}</span>
      </div>
    </div>

    <div class="section">
      <h2>改进建议</h2>
      ${suggestions.map(s => `<div class="suggestion"><span class="icon">${s.icon}</span>${s.text}</div>`).join('')}
    </div>

    <div class="section">
      <h2>评级参考标准（下载速度）</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
        <div style="padding:8px 12px;border-radius:6px;background:#e7f5ff;color:#339af0;font-weight:600;">A+ ≥ 900 Mbps</div>
        <div style="padding:8px 12px;border-radius:6px;background:#e7f5ff;color:#339af0;font-weight:600;">A ≥ 500 Mbps</div>
        <div style="padding:8px 12px;border-radius:6px;background:#fff3bf;color:#f59f00;font-weight:600;">B ≥ 200 Mbps</div>
        <div style="padding:8px 12px;border-radius:6px;background:#fff3bf;color:#f59f00;font-weight:600;">C ≥ 100 Mbps</div>
        <div style="padding:8px 12px;border-radius:6px;background:#ffe3e3;color:#e03131;font-weight:600;">D &lt; 100 Mbps</div>
        <div style="padding:8px 12px;border-radius:6px;background:#f1f3f5;color:#868e96;">低于 100 Mbps 需优化</div>
      </div>
      <p style="font-size:12px;color:#868e96;margin-top:10px;">评级基于下载速度（Mbps），反映内网链路带宽性能。</p>
    </div>

    ${recentHistory.length > 1 ? `
    <div class="section">
      <h2>历史记录（最近 ${recentHistory.length} 次）</h2>
      <table class="history-table">
        <thead><tr>
          <th>时间</th><th>下载</th><th>上传</th><th>延迟</th><th>抖动</th>
        </tr></thead>
        <tbody>
          ${recentHistory.map(r => `
          <tr>
            <td style="white-space:nowrap;font-size:12px">${new Date(r.time).toLocaleString('zh-CN')}</td>
            <td><span class="badge badge-dl">${r.downloadSpeed.toFixed(1)}</span></td>
            <td><span class="badge badge-ul">${r.uploadSpeed.toFixed(1)}</span></td>
            <td><span class="badge badge-ping">${r.ping.toFixed(1)}</span></td>
            <td>${r.jitter.toFixed(1)} ms</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <div style="text-align:center;padding:16px 32px 24px;">
      <button class="print-btn" onclick="window.print()">打印 / 导出 PDF</button>
    </div>

    <div class="footer">
      企业内网测速系统 · 报告生成时间: ${new Date().toLocaleString('zh-CN')} · ID: ${result.id}
    </div>
  </div>
</body>
</html>`);
});

// ============================================================
// API: 综合汇总报告
// ============================================================
app.get('/api/export/summary-report', requireAuth, (req, res) => {
  const results = db.getAllResults();
  const logs = db.getAllLogs();

  const days = parseInt(req.query.days) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const filtered = results.filter(r => new Date(r.time).getTime() > cutoff);

  if (filtered.length === 0) {
    return res.status(404).json({ error: `过去 ${days} 天内无测速数据` });
  }

  const uniqueIPs = new Set(filtered.map(r => r.ip)).size;
  const avgDL = filtered.reduce((s, r) => s + r.downloadSpeed, 0) / filtered.length;
  const avgUL = filtered.reduce((s, r) => s + r.uploadSpeed, 0) / filtered.length;
  const avgPing = filtered.reduce((s, r) => s + r.ping, 0) / filtered.length;
  const avgJitter = filtered.reduce((s, r) => s + r.jitter, 0) / filtered.length;
  const maxDL = Math.max(...filtered.map(r => r.downloadSpeed));
  const minDL = Math.min(...filtered.map(r => r.downloadSpeed));
  const maxUL = Math.max(...filtered.map(r => r.uploadSpeed));

  // 每日统计
  const dailyStats = {};
  filtered.forEach(r => {
    const day = r.time.slice(0, 10);
    if (!dailyStats[day]) dailyStats[day] = { count: 0, sumDL: 0, sumUL: 0, sumPing: 0, ips: new Set() };
    dailyStats[day].count++;
    dailyStats[day].sumDL += r.downloadSpeed;
    dailyStats[day].sumUL += r.uploadSpeed;
    dailyStats[day].sumPing += r.ping;
    dailyStats[day].ips.add(r.ip);
  });

  const dailyRows = Object.entries(dailyStats).sort().map(([day, s]) => ({
    day,
    count: s.count,
    avgDL: (s.sumDL / s.count).toFixed(1),
    avgUL: (s.sumUL / s.count).toFixed(1),
    avgPing: (s.sumPing / s.count).toFixed(1),
    ips: s.ips.size,
  }));

  // 访问统计
  const recentLogs = logs.filter(l => new Date(l.time).getTime() > cutoff);
  const dailyVisits = {};
  recentLogs.forEach(l => {
    const day = l.time.slice(0, 10);
    if (!dailyVisits[day]) dailyVisits[day] = 0;
    dailyVisits[day]++;
  });

  const grade = getGrade(avgDL);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>网络质量汇总报告 - 过去${days}天</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #212529; }
  .report { max-width: 900px; margin: 24px auto; background: white; border-radius: 16px; box-shadow: 0 2px 20px rgba(0,0,0,0.08); overflow: hidden; }
  .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; color: white; text-align: center; }
  .header h1 { font-size: 26px; font-weight: 700; }
  .header .sub { font-size: 14px; opacity: 0.8; margin-top: 4px; }
  .header .grade { font-size: 48px; font-weight: 800; margin: 12px 0 4px; }
  .section { padding: 28px 32px; border-bottom: 1px solid #f1f3f5; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .section h2::before { content: ''; width: 4px; height: 18px; background: #667eea; border-radius: 2px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .stat-card { background: #f8f9fa; border-radius: 10px; padding: 16px; text-align: center; }
  .stat-card .label { font-size: 12px; color: #868e96; }
  .stat-card .value { font-size: 24px; font-weight: 700; margin: 4px 0; }
  .stat-card .value.green { color: #20c997; }
  .stat-card .value.blue { color: #339af0; }
  .stat-card .value.yellow { color: #fcc419; }
  .stat-card .value.red { color: #ff6b6b; }
  .stat-card .value.purple { color: #764ba2; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; color: #868e96; font-weight: 600; border-bottom: 2px solid #e9ecef; }
  td { padding: 8px 10px; border-bottom: 1px solid #f1f3f5; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
  .badge-dl { color: #339af0; background: #e7f5ff; }
  .badge-ul { color: #20c997; background: #e6fcf5; }
  .badge-ping { color: #f59f00; background: #fff9db; }
  .footer { text-align: center; padding: 20px; font-size: 12px; color: #adb5bd; }
  .print-btn { display: inline-block; margin-top: 12px; padding: 10px 28px; background: #667eea; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  @media print { body { background: white; } .report { margin: 0; box-shadow: none; border-radius: 0; } .print-btn { display: none; } }
  @media (max-width: 600px) { .report { margin: 0; border-radius: 0; } .header { padding: 24px 16px; } .section { padding: 20px 16px; } .grid-3 { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
  <div class="report">
    <div class="header">
      <h1>网络质量汇总报告</h1>
      <div class="sub">过去 ${days} 天 · ${new Date().toLocaleDateString('zh-CN')}</div>
      <div class="grade">${grade}</div>
      <div class="sub">综合评级</div>
    </div>

    <div class="section">
      <h2>总体统计</h2>
      <div class="grid-3">
        <div class="stat-card"><div class="label">测速次数</div><div class="value blue">${filtered.length}</div><div class="label">次</div></div>
        <div class="stat-card"><div class="label">独立客户端</div><div class="value purple">${uniqueIPs}</div><div class="label">个 IP</div></div>
        <div class="stat-card"><div class="label">访问次数</div><div class="value">${recentLogs.length}</div><div class="label">次</div></div>
      </div>
    </div>

    <div class="section">
      <h2>平均性能</h2>
      <div class="grid-3">
        <div class="stat-card"><div class="label">平均下载</div><div class="value blue">${avgDL.toFixed(1)}</div><div class="label">Mbps</div></div>
        <div class="stat-card"><div class="label">平均上传</div><div class="value green">${avgUL.toFixed(1)}</div><div class="label">Mbps</div></div>
        <div class="stat-card"><div class="label">平均延迟</div><div class="value yellow">${avgPing.toFixed(1)}</div><div class="label">ms</div></div>
      </div>
      <div style="margin-top:12px;">
        <div class="grid-3">
          <div class="stat-card"><div class="label">最高下载</div><div class="value blue">${maxDL.toFixed(1)}</div><div class="label">Mbps</div></div>
          <div class="stat-card"><div class="label">最低下载</div><div class="value red">${minDL.toFixed(1)}</div><div class="label">Mbps</div></div>
          <div class="stat-card"><div class="label">平均抖动</div><div class="value">${avgJitter.toFixed(1)}</div><div class="label">ms</div></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>每日统计</h2>
      <table>
        <thead><tr><th>日期</th><th>测试次数</th><th>平均下载</th><th>平均上传</th><th>平均延迟</th><th>客户端数</th></tr></thead>
        <tbody>
          ${dailyRows.map(d => `
          <tr>
            <td style="font-size:12px">${d.day}</td>
            <td>${d.count}</td>
            <td><span class="badge badge-dl">${d.avgDL}</span></td>
            <td><span class="badge badge-ul">${d.avgUL}</span></td>
            <td><span class="badge badge-ping">${d.avgPing}</span></td>
            <td>${d.ips}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div style="text-align:center;padding:16px 32px 24px;">
      <button class="print-btn" onclick="window.print()">打印 / 导出 PDF</button>
    </div>

    <div class="footer">企业内网测速系统 · 报告生成: ${new Date().toLocaleString('zh-CN')}</div>
  </div>
</body>
</html>`);
});

// ============================================================
// API: 趋势数据（用于图表）
// ============================================================
app.get('/api/trends', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const tzOffset = parseInt(req.query.tz) || 0;
  const trendData = db.getTrendData(days, tzOffset);
  const totalTests = db.getStats().totalTests;

  res.json({ trendData, totalTests, filteredCount: trendData.reduce((s, d) => s + d.count, 0) });
});

// ============================================================
// API: 数据管理（清理旧数据）
// ============================================================
app.post('/api/cleanup', requireAuth, async (req, res) => {
  const days = parseInt(req.body.days) || 90;

  const removedResults = db.cleanupResults(days);
  const removedLogs = db.cleanupLogs(days);

  // 清理后备份到 JSON 以保持兼容
  try {
    db.backupToJSON();
  } catch (e) {
    console.error('备份到 JSON 失败:', e.message);
  }

  const remainingResults = db.getStats().totalTests;
  const remainingLogs = db.getLogs({ page: 1, pageSize: 1 }).total;

  res.json({
    status: 'ok',
    message: `已清理 ${days} 天前的数据`,
    removedResults,
    removedLogs,
    remainingResults,
    remainingLogs,
  });
});

// ============================================================
// API: 重置所有数据
// ============================================================
app.post('/api/clear-all', requireAuth, async (req, res) => {
  const result = db.clearAll();

  // 备份空数据
  try { db.backupToJSON(); } catch (e) {}

  res.json({
    status: 'ok',
    message: '所有数据已重置',
    removedResults: result.removedResults,
    removedLogs: result.removedLogs,
  });
});

// ============================================================
// API: 导出访问日志 CSV
// ============================================================
app.get('/api/export/logs-csv', requireAuth, (req, res) => {
  const ipFilter = req.query.ip || '';
  const days = parseInt(req.query.days) || 0;
  const filtered = db.getLogsForExport(ipFilter, days);

  const headers = ['时间', 'IP地址', '请求方法', '路径', '用户代理'];
  const rows = filtered.map(l => [
    l.time,
    l.ip,
    l.method,
    l.path,
    `"${(l.ua || '').replace(/"/g, '""')}"`,
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=access-logs-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send('\ufeff' + csv);
});

// ============================================================
// PDF 辅助函数
// ============================================================
function drawSection(doc, font, fontBold, title, y) {
  // 检查是否需要分页
  if (y + 40 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.font(fontBold).fontSize(13).fillColor('#333333');
  doc.text(title, doc.page.margins.left, y);

  doc.moveTo(doc.page.margins.left, y + 22)
     .lineTo(doc.page.margins.left + 60, y + 22)
     .strokeColor('#667eea').lineWidth(2).stroke();

  return y + 32;
}

// 紧凑版 section 标题（单页报告使用）
function drawSectionCompact(doc, font, fontBold, title, y) {
  if (y + 30 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font(fontBold).fontSize(11).fillColor('#333333');
  doc.text(title, doc.page.margins.left, y);
  doc.moveTo(doc.page.margins.left, y + 18)
     .lineTo(doc.page.margins.left + 50, y + 18)
     .strokeColor('#667eea').lineWidth(1.5).stroke();
  return y + 24;
}

// ============================================================
// 启动服务器
// ============================================================
initPassword();

// 如果是 --reset-admin 模式
if (process.argv.includes('--reset-admin')) {
  const config = readJSON(CONFIG_FILE, {});
  const salt = bcrypt.genSaltSync(10);
  config.passwordHash = bcrypt.hashSync('admin123', salt);
  config.updatedAt = new Date().toISOString();
  writeJSON(CONFIG_FILE, config);
  console.log('[重置] 管理员密码已重置为: admin123');
  process.exit(0);
}

// 将 SQLite 数据备份到 JSON（兼容旧版）
try {
  const backup = db.backupToJSON();
  console.log(`[数据库] 已备份 ${backup.results} 条测速结果, ${backup.logs} 条日志`);
} catch (e) {
  console.error('[数据库] 备份失败:', e.message);
}

// 全局异常保护，防止服务器因未捕获的异常而崩溃
process.on('uncaughtException', (err) => {
  console.error('[崩溃] 未捕获异常:', err.message);
  console.error(err.stack);
  // 记录到文件以便事后分析
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'crash.log'),
      `[${new Date().toISOString()}] ${err.stack}\n---\n`);
  } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[崩溃] 未处理的 Promise 拒绝:', reason);
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'crash.log'),
      `[${new Date().toISOString()}] ${reason}\n---\n`);
  } catch (e) {}
});

const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  const interfaces = require('os').networkInterfaces();
  const addresses = [];
  Object.keys(interfaces).forEach(ifname => {
    interfaces[ifname].forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });

  console.log('='.repeat(55));
  console.log('  企业内网测速系统 v2.0');
  console.log('='.repeat(55));
  console.log(`  服务端口: ${CONFIG.PORT}`);
  console.log(`  访问地址:`);
  console.log(`    http://localhost:${CONFIG.PORT}`);
  addresses.forEach(addr => {
    console.log(`    http://${addr}:${CONFIG.PORT}`);
  });
  console.log('');
  console.log('  管理后台: /console/dashboard.html');
  console.log('  默认密码: admin123');
  console.log('  (通过环境变量 ADMIN_PASSWORD 修改)');
  console.log('='.repeat(55));
});

// ============================================================
// 辅助函数
// ============================================================

// 综合评级
function getGrade(speed) {
  return speed >= 900 ? 'A+' : speed >= 500 ? 'A' : speed >= 200 ? 'B' : speed >= 100 ? 'C' : 'D';
}

// 评级参考标准
function getGradeStandards() {
  return [
    'A+：≥900 Mbps  ·  万兆/千兆网络，性能极佳',
    'A：≥500 Mbps  ·  千兆网络，适合高带宽应用',
    'B：≥200 Mbps  ·  百兆网络，日常办公流畅',
    'C：≥100 Mbps  ·  基础网络，建议排查瓶颈',
    'D：<100 Mbps  ·  网络需优化升级',
  ];
}

// 延迟质量
function getPingQuality(ms) {
  return ms < 1 ? '极佳' : ms < 5 ? '优秀' : ms < 20 ? '良好' : ms < 50 ? '一般' : '较差';
}

// 网络改进建议生成器
function getSuggestions(result) {
  const suggestions = [];
  const dl = result.downloadSpeed;
  const ul = result.uploadSpeed;
  const ping = result.ping;
  const jitter = result.jitter;

  if (dl >= 900) {
    suggestions.push({ icon: '🚀', text: '下载速度极快（≥900 Mbps），万兆/千兆网络运行正常。' });
  } else if (dl >= 500) {
    suggestions.push({ icon: '✅', text: '下载速度优秀（≥500 Mbps），适合高带宽应用，如4K视频流、大文件传输。' });
  } else if (dl >= 200) {
    suggestions.push({ icon: '👍', text: '下载速度良好（≥200 Mbps），日常办公和流媒体使用流畅。' });
  } else if (dl >= 100) {
    suggestions.push({ icon: '⚡', text: `下载速度 ${dl.toFixed(1)} Mbps，建议检查网络设备是否为千兆规格，网线是否为 Cat5e 以上。` });
  } else {
    suggestions.push({ icon: '⚠️', text: `下载速度 ${dl.toFixed(1)} Mbps 偏低，建议：1) 检查网线连接是否松动 2) 确认交换机端口速率 3) 排查是否存在带宽抢占。` });
  }

  if (ul < 10) {
    suggestions.push({ icon: '📤', text: `上传速度 ${ul.toFixed(1)} Mbps 较低，影响文件上传和视频会议质量。建议检查上行链路是否存在限速。` });
  } else if (ul < 50) {
    suggestions.push({ icon: '📤', text: `上传速度 ${ul.toFixed(1)} Mbps，基本满足日常需求。大量上传场景下建议关注。` });
  }

  if (ping < 1) {
    suggestions.push({ icon: '🎯', text: `极低延迟 ${ping.toFixed(1)} ms，网络响应极快，适合实时应用。` });
  } else if (ping < 5) {
    suggestions.push({ icon: '🎯', text: `延迟 ${ping.toFixed(1)} ms 优秀，内网性能良好。` });
  } else if (ping < 20) {
    suggestions.push({ icon: '⏱️', text: `延迟 ${ping.toFixed(1)} ms 正常。如果出现卡顿，请检查是否存在网络环路或广播风暴。` });
  } else {
    suggestions.push({ icon: '⏱️', text: `延迟 ${ping.toFixed(1)} ms 偏高，建议检查：1) 网络设备负载 2) 是否存在跨网段路由 3) 交换机性能是否足够。` });
  }

  if (jitter < 2) {
    suggestions.push({ icon: '📊', text: `抖动 ${jitter.toFixed(1)} ms 极低，网络稳定性非常好。` });
  } else if (jitter < 5) {
    suggestions.push({ icon: '📊', text: `抖动 ${jitter.toFixed(1)} ms 在正常范围内。` });
  } else {
    suggestions.push({ icon: '📊', text: `抖动 ${jitter.toFixed(1)} ms 偏高，可能导致音视频通话断续。建议检查网络拥塞情况。` });
  }

  if (ul > 0 && dl > 0) {
    const ratio = dl / ul;
    if (ratio > 10) {
      suggestions.push({ icon: '⚖️', text: `下载/上传比例 ${ratio.toFixed(1)}:1，上下行严重不对等。如果是光纤宽带，请联系运营商检查。` });
    }
  }

  return suggestions;
}

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// 生成 index.html（注入 saveData 配置和设备指纹采集）- 带缓存
let cachedIndexHTML = null;

function generateIndexHTML(req) {
  if (cachedIndexHTML) return cachedIndexHTML;

  const indexPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // 覆盖原始 index.html 中的默认值，确保 saveData 和 saveDataURL 正确
  html = html.replace('var saveData = false;', 'var saveData = true;');
  html = html.replace('var saveDataURL = "//yourDatabase.Server.com:4500/save?data=";', 'var saveDataURL = "/api/save-result";');

  // 在 </head> 前注入配置
  const injectScript = `
<script>
// === 企业内网测速系统增强配置 ===
var saveData = true;
var saveDataURL = "/api/save-result";

// 设备指纹采集（代替 MAC 地址，用于设备识别）
(function() {
  try {
    // 生成或读取本地设备 ID
    var deviceId = localStorage.getItem('_speedtest_device_id');
    if (!deviceId) {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      deviceId = Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      localStorage.setItem('_speedtest_device_id', deviceId);
    }

    // 采集设备特征数据
    var canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    var ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = '18px Arial';
    ctx.fillText('Cwm fjordbank glyphs', 4, 45);
    ctx.fillStyle = 'red';
    ctx.font = '11px Arial';
    ctx.fillText('SpeedTest', 30, 5);
    // toDataURL 太长（~30KB），仅取末尾64字符作为简短指纹
    var canvasFingerprint = canvas.toDataURL().slice(-64);

    var deviceInfo = {
      deviceId: deviceId,
      canvasFingerprint: canvasFingerprint,
      ua: navigator.userAgent,
      platform: navigator.platform || '',
      cores: navigator.hardwareConcurrency || 0,
      memory: navigator.deviceMemory || 0,
      language: navigator.language || '',
      languages: (navigator.languages || []).join(','),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      screen: screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
      touchSupport: 'ontouchstart' in window,
    };

    // 保存到全局，方便调试
    window._speedtestDevice = deviceInfo;
    console.log('[设备识别] ID:', deviceId.slice(0, 8) + '...');
  } catch(e) {
    console.warn('[设备识别] 初始化失败:', e.message);
  }
})();

// === 测速结果缓存与自动上报 ===
(function() {
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._stUrl = url;
    return origOpen.apply(this, arguments);
  };

  // 页面加载时重试失败队列
  function retryPending() {
    try {
      var pending = JSON.parse(localStorage.getItem('_speedtest_pending') || '[]');
      if (pending.length === 0) return;
      var remaining = [];
      pending.forEach(function(item) {
        var xhr = new XMLHttpRequest();
        xhr._stRetry = true;
        xhr.open('POST', '/api/save-result', true);
        xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
        xhr.onload = function() {
          if (xhr.status !== 200) remaining.push(item);
        };
        xhr.onerror = function() { remaining.push(item); };
        xhr.send(item.body);
      });
      localStorage.setItem('_speedtest_pending', JSON.stringify(remaining));
    } catch(e) { console.warn('[测速] 重试失败:', e.message); }
  }

  XMLHttpRequest.prototype.send = function(body) {
    if (this._stUrl && typeof this._stUrl === 'string' && this._stUrl.indexOf('/api/save-result') !== -1 && !this._stRetry) {
      if (body && typeof body === 'string') {
        try {
          console.log('[拦截] 捕获到引擎 save-result 请求, body=' + body.substring(0, 120));
          var _loc = localStorage.getItem('_speedtest_location') || '';
          var _pid = localStorage.getItem('_speedtest_pointId') || '';
          var _dev = window._speedtestDevice ? JSON.stringify(window._speedtestDevice) : '';
          // 只在 body 尚未包含这些参数时追加，避免兜底轮询导致的重复 key
          // 重复 key 会被 qs 解析为数组，导致 SQLite 绑定失败
          if (body.indexOf('&loc=') === -1) {
            body += '&loc=' + encodeURIComponent(_loc);
          }
          if (body.indexOf('&pid=') === -1) {
            body += '&pid=' + encodeURIComponent(_pid);
          }
          if (body.indexOf('&dev=') === -1) {
            body += '&dev=' + encodeURIComponent(_dev);
          }
          console.log('[拦截] 增强后 body=' + body.substring(0, 200));

          // 写入待发送队列
          var pending = JSON.parse(localStorage.getItem('_speedtest_pending') || '[]');
          pending.push({ body: body, time: new Date().toISOString() });
          localStorage.setItem('_speedtest_pending', JSON.stringify(pending));

          // 请求成功时从队列移除 + 记入历史
          var self = this;
          var origOnload = this.onload;
          this.onload = function() {
            if (self.status === 200) {
              try {
                var p = JSON.parse(localStorage.getItem('_speedtest_pending') || '[]');
                var kept = p.filter(function(e) { return e.body !== body; });
                localStorage.setItem('_speedtest_pending', JSON.stringify(kept));

                var hist = JSON.parse(localStorage.getItem('_speedtest_history') || '[]');
                var entry = { time: new Date().toISOString(), body: body, status: 'saved' };
                var resp = JSON.parse(self.responseText);
                if (resp && resp.id) entry.id = resp.id;
                hist.push(entry);
                if (hist.length > 200) hist = hist.slice(-200);
                localStorage.setItem('_speedtest_history', JSON.stringify(hist));
              } catch(e) {}
            }
            if (typeof origOnload === 'function') origOnload.apply(self, arguments);
          };
        } catch(e) { console.warn('[测速] 缓存失败:', e.message); }
      }
    }
    origSend.call(this, body);
  };

  // 页面加载后尝试重试
  if (document.readyState === 'complete') { retryPending(); }
  else { window.addEventListener('load', retryPending); }
})();

// === SVG 结果监听兜底（引擎 Y(5) 可能因异常未调用）===
(function() {
  console.log('[兜底] SVG 结果监听已启动');
  var _sentFlag = false;
  var pollTimer = setInterval(function() {
    if (_sentFlag) { clearInterval(pollTimer); return; }

    var downEl = document.getElementById('downResult');
    var upEl = document.getElementById('upRestxt');
    var pingEl = document.getElementById('pingResult');
    var jitterEl = document.getElementById('jitterDesk');

    if (!downEl || !upEl || !pingEl) return;

    var dl = downEl.textContent.trim();
    var ul = upEl.textContent.trim();
    var pi = pingEl.textContent.trim();

    // 只认非默认值：down=--- / up=--- / ping=--
    if (dl === '---' || ul === '---' || pi === '--' || dl === '' || ul === '' || pi === '') return;
    var dlNum = parseFloat(dl);
    var ulNum = parseFloat(ul);
    if (isNaN(dlNum) || dlNum <= 0) return; // 测速尚未完成

    var pingNum = parseFloat(pi) || 0;
    var jitterNum = jitterEl ? parseFloat(jitterEl.textContent.trim()) || 0 : 0;
    _sentFlag = true;
    clearInterval(pollTimer);

    var loc = localStorage.getItem('_speedtest_location') || '';
    var pid = localStorage.getItem('_speedtest_pointId') || '';
    var dev = window._speedtestDevice ? JSON.stringify(window._speedtestDevice) : '';
    var ua = navigator.userAgent;

    console.log('[兜底] 捕获到测速结果: ↓' + dlNum + ' ↑' + ulNum + ' ping:' + pingNum + 'ms', { loc: loc, pid: pid });

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/save-result', true);
    xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
    xhr.onload = function() {
      console.log('[兜底] 上报结果:', xhr.status, xhr.responseText);
    };
    xhr.onerror = function() {
      console.warn('[兜底] 上报失败（网络错误）');
    };
    xhr.send('d=' + dlNum + '&u=' + ulNum + '&p=' + pingNum +
             '&jit=' + jitterNum + '&loc=' + encodeURIComponent(loc) +
             '&pid=' + encodeURIComponent(pid) + '&dev=' + encodeURIComponent(dev) +
             '&ua=' + encodeURIComponent(ua));
  }, 1500);
})();

// === Session 心跳检测 ===
(function() {
  var checkSession = function() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/check-auth', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var authData = JSON.parse(xhr.responseText);
          if (!authData.authenticated) {
            clearInterval(sessionTimer);
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div style="background:white;border-radius:16px;padding:36px 40px;text-align:center;max-width:360px;box-shadow:0 20px 60px rgba(0,0,0,0.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif;animation:stFadeIn 0.3s ease-out;">' +
              '<div style="margin-bottom:14px;"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#e03131" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
              '<h2 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#212529;">会话已过期</h2>' +
              '<p style="color:#868e96;font-size:14px;margin:0 0 24px;line-height:1.5;">您的登录会话已失效，<br>请重新登录以继续使用</p>' +
              '<a href="/console/login.html?redirect=/" style="display:inline-block;padding:11px 32px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">去登录</a>' +
              '</div>';
            document.body.appendChild(overlay);
          }
        } catch(e) {}
      }
    };
    xhr.send();
  };
  // 每 60 秒检查一次会话状态
  var sessionTimer = setInterval(checkSession, 60000);
  // 页面加载时立即检查一次
  setTimeout(checkSession, 1000);
})();
</script>
</head>`;

  html = html.replace('</head>', injectScript);

  // 在 </body> 前注入修改密码 UI
  const injectBody = `
<div id="st-toolbar">
  <button id="st-retest-btn" onclick="stRetest()" title="重新测试">
    <svg viewBox="0 0 24 24" width="20" height="20">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  </button>
  <button id="st-settings-btn" onclick="stToggleSettings()" title="设置">
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  </button>
</div>

	<div id="st-modal-overlay" onclick="if(event.target===this)stCloseModal()">
	  <div id="st-modal">
	    <div class="st-modal-header">
	      <h3>设置</h3>
	      <button class="st-modal-close" onclick="stCloseModal()">
	        <svg viewBox="0 0 24 24" width="20" height="20">
	          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
	        </svg>
	      </button>
	    </div>

		    <div style="text-align:center;padding:4px 0 16px;color:#868e96;font-size:13px;">
		      <button class="st-btn-link" onclick="stLogout()" style="background:none;border:none;color:#e03131;cursor:pointer;font-size:13px;font-family:inherit;text-decoration:underline;padding:0;">退出登录</button>
		    </div>
	  </div>
	</div>

	<!-- 测速位置 & 信息点编号 — 左下方直接显示 -->
	<div id="st-loc-bar">
	  <div class="st-loc-field">
	    <label for="st-location">测速位置</label>
	    <input id="st-location" type="text" placeholder="例如：三楼机房A" maxlength="50">
	  </div>
	  <div class="st-loc-field">
	    <label for="st-pointId">信息点编号</label>
	    <input id="st-pointId" type="text" placeholder="例如：SW-03-Port12" maxlength="50">
	  </div>
	</div>

<style>
#st-toolbar { position: fixed; top: 12px; right: 12px; z-index: 9999; display: flex; gap: 8px; }
#st-retest-btn, #st-settings-btn {
  width: 40px; height: 40px; border-radius: 50%; border: none;
  background: rgba(255,255,255,0.92); box-shadow: 0 2px 12px rgba(0,0,0,0.12);
  cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
  display: flex; align-items: center; justify-content: center; color: #495057;
}
#st-settings-btn:hover { transform: scale(1.08); box-shadow: 0 4px 16px rgba(0,0,0,0.18); color: #667eea; }
#st-retest-btn:hover { transform: scale(1.08); box-shadow: 0 4px 16px rgba(0,0,0,0.18); color: #2f9e44; }
/* 测速位置 & 信息点编号 — 左下方输入栏 */
#st-loc-bar {
  position: fixed;
  left: 18px;
  bottom: 18px;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(255,255,255,0.90);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  padding: 10px 14px;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.10);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  min-width: 180px;
}
.st-loc-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.st-loc-field label {
  font-size: 12px;
  color: #495057;
  white-space: nowrap;
  font-weight: 500;
  min-width: 54px;
}
.st-loc-field input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid #dee2e6;
  border-radius: 5px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
  min-width: 100px;
}
.st-loc-field input:focus {
  border-color: #667eea;
  box-shadow: 0 0 0 2px rgba(102,126,234,0.15);
}
@media (max-width: 480px) {
  #st-loc-bar { left: 10px; bottom: 10px; padding: 8px 10px; min-width: 140px; }
  .st-loc-field label { font-size: 11px; min-width: 44px; }
  .st-loc-field input { font-size: 11px; padding: 4px 6px; min-width: 70px; }
}
#st-modal-overlay {
  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.45); z-index: 10000;
  align-items: center; justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#st-modal-overlay.st-active { display: flex; }
#st-modal {
  background: white; border-radius: 16px; padding: 24px; width: 90%; max-width: 380px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.2); animation: stFadeIn 0.2s ease-out;
}
@keyframes stFadeIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
.st-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.st-modal-header h3 { margin: 0; font-size: 17px; font-weight: 700; color: #212529; }
.st-modal-close { background: none; border: none; cursor: pointer; color: #868e96; padding: 4px; border-radius: 6px; display: flex; }
.st-modal-close:hover { background: #f1f3f5; color: #495057; }
.st-btn-logout {
  width: 100%; padding: 10px; background: white; color: #e03131; border: 2px solid #e03131;
  border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit;
  display: flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.2s;
}
.st-btn-logout:hover { background: #fff5f5; }
</style>

<script>
function stToggleSettings() {
  document.getElementById('st-modal-overlay').classList.toggle('st-active');
}
function stCloseModal() {
  document.getElementById('st-modal-overlay').classList.remove('st-active');
}
// 测速位置 & 信息点编号 — 输入即自动保存
document.addEventListener('DOMContentLoaded', function() {
  var locInput = document.getElementById('st-location');
  var pidInput = document.getElementById('st-pointId');
  if (locInput) {
    locInput.value = localStorage.getItem('_speedtest_location') || '';
    locInput.addEventListener('input', function() {
      localStorage.setItem('_speedtest_location', this.value);
    });
  }
  if (pidInput) {
    pidInput.value = localStorage.getItem('_speedtest_pointId') || '';
    pidInput.addEventListener('input', function() {
      localStorage.setItem('_speedtest_pointId', this.value);
    });
  }
  // 确保 resultsData 不可点击（移除 SVGA 元素可能残留的 href）
  var cleanLinks = function() {
    var el = document.getElementById('resultsData');
    if (el) {
      try { el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); } catch(e) {}
      try { el.removeAttribute('xlink:href'); } catch(e) {}
      try { el.removeAttribute('href'); } catch(e) {}
      try { el.removeAttribute('target'); } catch(e) {}
      el.style.cursor = 'default';
    }
  };
  // 测速完成后 SVG 会被更新，检测变化并清理
  var obs = new MutationObserver(cleanLinks);
  var svgRoot = document.querySelector('svg') || document.body;
  obs.observe(svgRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['xlink:href'] });
  cleanLinks();
});
async function stLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/console/login.html';
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') stCloseModal();
});
function stRetest() {
  location.reload();
}
</script>
</body>`;

  html = html.replace('</body>', injectBody);

  cachedIndexHTML = html;
  return html;
}

// 生成专业的 HTML 测速报告
// 解析设备指纹信息
function parseDeviceInfo(dev) {
  try {
    if (!dev) return null;
    // 防御 qs 数组：取首个非空元素
    if (Array.isArray(dev)) dev = dev.find(v => v) || null;
    if (!dev) return null;
    const d = typeof dev === 'string' ? JSON.parse(decodeURIComponent(dev)) : dev;
    if (!d || typeof d !== 'object') return null;
    return {
      deviceId: d.deviceId || null,
      platform: d.platform || null,
      cores: d.cores || null,
      memory: d.memory || null,
      language: d.language || null,
      languages: d.languages || null,
      timezone: d.timezone || null,
      screen: d.screen || null,
      touchSupport: d.touchSupport || null,
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 优雅退出
// ============================================================
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
