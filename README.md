# 企业内网测速系统 v2.1

<img width="1913" height="955" alt="1" src="https://github.com/user-attachments/assets/fd20c83f-9ad6-443c-937f-5bcbd3464c7b" />
<img width="1902" height="960" alt="2" src="https://github.com/user-attachments/assets/978eaca1-9986-4fd1-ade2-d65f4f1da0a6" />
<img width="1914" height="954" alt="3" src="https://github.com/user-attachments/assets/09b636de-ebd7-47e1-9c44-86b2c0f5c140" />
<img width="1910" height="955" alt="4" src="https://github.com/user-attachments/assets/3177b11f-4f69-407c-8a65-53c26472a8ec" />
<img width="1917" height="951" alt="5" src="https://github.com/user-attachments/assets/7c57c89c-ebf0-4f45-baf6-312d9049f580" />
<img width="1911" height="954" alt="6" src="https://github.com/user-attachments/assets/597274f4-6694-46bd-855e-751d40e4d37d" />
<img width="1885" height="955" alt="7" src="https://github.com/user-attachments/assets/72d82749-3089-4f1a-a0b6-ca44549e0bc3" />
<img width="1901" height="952" alt="8" src="https://github.com/user-attachments/assets/90a21461-5ad1-42fa-8733-8fd8a7bc92cb" />


> **作者：CTF_无白** [https://github.com/ctfwubai](https://github.com/ctfwubai)

基于 OpenSpeedTest 引擎二次开发的企业级内网带宽测试平台。集成管理后台、SQLite 持久化存储、设备指纹识别、PDF/HTML 专业报告导出、性能趋势分析等功能，无需外部数据库依赖。

## 功能特性

### 核心测速
- **多线程下载/上传测试** — 基于 OpenSpeedTest 引擎，支持 6 线程并发
- **延迟 (Ping) 与抖动 (Jitter) 测试** — 10 次采样取均值，精确评估网络质量
- **可调测试参数** — 支持 URL 参数自定义测试时长、线程数、数据量（Stress Test 模式）
- **一键重测** — 页面右上角刷新按钮快速重新测试

### 安全认证
- **密码登录** — bcrypt 加密存储，Session 认证（24h 过期）
- **暴力破解防护** — 连续 5 次失败锁定 15 分钟
- **Session 心跳检测** — 每 60 秒检查，过期自动拦截并弹窗提示
- **HTTP-only Cookie** — 防止 XSS 窃取

### 管理后台
- **统计概览** — 总测试数、独立 IP、平均下载/上传/延迟、24h 活跃度
- **测速记录** — 分页浏览、按 IP 过滤、详情查看
- **访问日志** — 保留最新 30 条访问记录
- **IP 统计** — 按 IP 汇总测试次数、访问次数、平均下载
- **设备管理** — Canvas 指纹 + 硬件特征识别设备，追踪多 IP 下的同一设备
- **报告管理** — CSV 导出、HTML 报告、PDF 报告、批量 PDF 导出
- **趋势分析** — 7/14/30/90 天性能趋势图表
- **数据管理** — 数据清理、统计概览

### 设备指纹识别
- Canvas 指纹 + WebGL + 硬件特征（CPU 核心数、内存、屏幕分辨率、时区等）
- 生成唯一设备 ID 并持久化到 localStorage
- 同一设备在不同网络环境下可被识别追踪

### 报告导出
| 格式 | 内容 | 特点 |
|------|------|------|
| HTML | 详细报告 + 评级 + 改进建议 + 历史对比 | 可直接打印/导出 PDF |
| PDF 单条 | 专业排版报告，含评级标准参考 | 单页 A4，含评级标准说明 |
| PDF 批量 | 多条记录合并为一份 PDF 文件 | 每条记录占一页 |
| CSV | 全部测速数据 | UTF-8 BOM 编码，兼容 Excel |

### 综合评级标准（基于下载速度）
| 等级 | 标准 | 说明 |
|------|------|------|
| A+ | ≥ 900 Mbps | 万兆/千兆网络，性能极佳 |
| A | ≥ 500 Mbps | 千兆网络，高带宽应用流畅 |
| B | ≥ 200 Mbps | 百兆网络，日常办公流畅 |
| C | ≥ 100 Mbps | 基础网络，建议排查瓶颈 |
| D | < 100 Mbps | 网络需优化升级 |

### 测速增强
- **测速位置/信息点编号** — 页面左下方输入框，自动保存到 localStorage，随测速结果一起上报
- **自动重试** — 失败请求缓存到 localStorage，页面刷新后自动重试
- **SVG 兜底上报** — 即使引擎回调异常，也能通过 DOM 轮询捕获结果并上报

## 快速启动

### 环境要求
- Node.js >= 16.x
- npm

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务（默认端口 8080，密码 admin123）
node server.js
```

### 自定义端口和密码

```bash
# 环境变量方式
PORT=9090 ADMIN_PASSWORD=yourpassword node server.js

# Windows PowerShell
$env:PORT=9090; $env:ADMIN_PASSWORD="yourpassword"; node server.js

# Windows CMD (start.bat 支持参数)
start.bat 9090 yourpassword
```

### 一键启动脚本

启动脚本会自动检测并杀掉已存在的 Node.js 服务进程，确保每次都用指定端口启动，避免端口冲突导致的自动递增问题。

| 平台 | 脚本 | 用法 |
|------|------|------|
| Windows | `start.bat` | 双击运行，支持 `start.bat [port] [password]` |
| Linux/Mac | `bash start.sh` | `bash start.sh [port] [password]` |

### 重置密码

```bash
node server.js --reset-admin
# 密码重置为: admin123
```

## 访问地址

| 页面 | 地址 |
|------|------|
| 测速主页 | `http://localhost:8080` |
| 管理后台 | `http://localhost:8080/console/dashboard.html` |
| 登录页面 | `http://localhost:8080/console/login.html` |

## Docker 部署

```bash
# 构建镜像
docker build -t speedtest .

# 运行容器
docker run -d \
  --name speedtest \
  -p 8080:8080 \
  -v ./data:/app/data \
  -e ADMIN_PASSWORD=yourpassword \
  speedtest

# 或使用自定义端口
docker run -d \
  --name speedtest \
  -p 9090:8080 \
  -e PORT=8080 \
  speedtest
```

数据目录 `/app/data` 包含 SQLite 数据库和配置，建议挂载持久化。

## 配置项

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `PORT` | 服务端口 | 8080 |
| `ADMIN_PASSWORD` | 管理密码 | admin123 |
| `SESSION_SECRET` | Session 密钥（不设则随机生成） | 随机 |

## 技术架构

```
Speed-Test-main/
├── server.js              # 主服务 (Express)
│   ├── 认证 (Session + bcrypt)
│   ├── 测速 API (下载/上传/保存结果)
│   ├── 管理 API (统计/记录/日志/趋势)
│   ├── PDF 报告生成 (PDFKit)
│   ├── HTML 报告生成
│   └── 前端页面注入 (设备指纹/兜底上报/配置)
├── db.js                  # SQLite 数据库 (better-sqlite3)
│   ├── 测速结果表 (results)
│   ├── 访问日志表 (access_logs)
│   ├── WAL 模式 (高性能并发)
│   └── JSON 备份兼容
├── index.html             # 测速页面 (OpenSpeedTest)
├── console/
│   ├── dashboard.html     # 管理后台
│   └── login.html         # 登录页面
├── assets/
│   ├── js/app-2.5.4.js    # OpenSpeedTest 引擎
│   ├── images/app.svg     # 测速 SVG 界面
│   ├── css/app.css        # 测速样式
│   └── fonts/             # Roboto 字体
├── data/                  # 运行时数据
│   ├── speedtest.db       # SQLite 数据库
│   ├── config.json        # 密码配置
│   └── results.json       # JSON 备份
├── start.bat / start.sh   # 一键启动脚本
└── Dockerfile             # Docker 部署
```

### 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js + Express 4.x |
| 前端 | Vanilla JS + SVG（无框架） |
| 数据库 | SQLite (better-sqlite3, WAL 模式) |
| 加密 | bcryptjs |
| Session | express-session |
| 报告 | PDFKit |
| 测速引擎 | OpenSpeedTest 2.5.4 |

### 数据流

```
用户浏览器 → 测速引擎 → 下载/上传测试 → SVG 结果展示
                                    ↓
                            DOM 轮询捕获结果
                                    ↓
                        POST /api/save-result (XHR)
                                    ↓
                           server.js 处理入库
                                    ↓
                           SQLite (better-sqlite3)
                                    ↓
                     管理后台 API 读取展示 / 报告导出
```

## API 接口

### 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 密码登录 |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/check-auth` | 检查 Session 状态 |
| POST | `/api/change-password` | 修改密码 |

### 测速
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/save-result` | 保存测速结果 |
| GET | `/downloading/*` | 下载测速（10MB 随机数据,支持 Range） |
| POST | `/upload` | 上传测速（接收并丢弃） |

### 数据查询
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 统计概览 |
| GET | `/api/results` | 测速记录（分页） |
| GET | `/api/results/:id` | 单条详情 + 历史 |
| GET | `/api/unique-ips` | IP 统计 |
| GET | `/api/devices` | 设备列表 |
| GET | `/api/logs` | 访问日志 |
| GET | `/api/trends` | 趋势数据 |

### 报告导出
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/export/csv` | 导出 CSV |
| GET | `/api/export/report/:id` | 导出单条 PDF |
| POST | `/api/export/batch-pdf` | 批量导出 PDF |
| GET | `/api/export/html-report/:id` | HTML 报告 |
| GET | `/api/export/summary-report` | 汇总报告 |
| GET | `/api/export/logs-csv` | 访问日志 CSV |

### 管理
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/cleanup` | 清理旧数据 |
| GET | `/health` | 健康检查 |

## URL 参数（测速页面）

测速页面支持以下 URL 查询参数（源自 OpenSpeedTest）：

| 参数 | 说明 | 示例 |
|------|------|------|
| `S` / `Stress` | 压力测试模式（自定义时长） | `/?S=30` 测试 30 秒 |
| `T` / `Test` | 单项测试模式 | `/?T=dl` 仅下载测试 |
| `H` / `Host` | 自定义测速服务器 | `/?H=http://10.0.0.1:8080` |
| `R` / `Run` | 自动开始测试 | `/?R=5` 延迟 5 秒后自动开始 |
| `X` / `XHR` | 自定义并发数 | `/?X=12` 12 线程 |

## 常见问题

### 测速结果没有记录？
检查 `server.log` 是否有错误。常见原因：
- Session 过期：刷新页面重新登录
- 参数重复：v2.0 已修复此问题

### 如何修改端口？
```bash
# 方式 1：环境变量
PORT=9090 node server.js

# 方式 2：start.bat 参数
start.bat 9090
```

### 数据存在哪里？
SQLite 数据库文件在 `data/speedtest.db`，同时定期备份为 `data/results.json` 和 `data/logs.json`。

### 如何备份数据？
直接复制 `data/` 目录即可。JSON 文件可直接用 Excel 打开或导入其他系统。

## 许可证

MIT License - 基于 OpenSpeedTest 构建

OpenSpeedTest: https://github.com/openspeedtest/Speed-Test
