# 企业内网测速系统 — 安装部署指南

## 环境要求

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| Node.js | >= 16.x | 推荐 20.x LTS |
| npm | 随 Node.js 自带 | — |
| 操作系统 | Windows 7+ / Linux / macOS | 全平台支持 |

## 快速安装

### 1. 下载项目

**方式一：解压压缩包**

将 `Speed-Test-main.7z` 解压到目标目录（例如 `D:\speedtest` 或 `/opt/speedtest`）。

**方式二：git 克隆**

```bash
git clone <仓库地址>
cd Speed-Test-main
```

### 2. 安装 Node.js 运行环境

Node.js 是本项目的运行基础，请根据你的操作系统选择安装方式。

---

#### Windows 安装 Node.js

**方法一：使用安装包（推荐）**

在项目目录中找到 `node-v24.16.0-x64.msi`，双击运行，一路点"Next"完成安装。

**方法二：官网下载**

访问 https://nodejs.org/ 下载 LTS 版本的 `.msi` 安装包安装。

安装完成后，打开命令提示符（cmd）或 PowerShell，输入以下命令验证：

```bash
node -v
npm -v
```

看到版本号输出即表示安装成功。

---

#### Linux 安装 Node.js

**Ubuntu / Debian：**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS / RHEL / Fedora：**

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

验证安装：

```bash
node -v
npm -v
```

---

#### macOS 安装 Node.js

```bash
brew install node@20
```

验证安装：

```bash
node -v
npm -v
```

### 3. 安装项目依赖

进入项目目录，执行：

```bash
npm install
```

等待依赖安装完成，看到类似以下输出即成功：

```
added 150 packages in 10s
```

> 如遇网络慢，可使用淘宝镜像：`npm install --registry=https://registry.npmmirror.com`

---

## 启动服务

### 方式一：一键启动脚本（最简单，推荐）

启动脚本会自动帮你检查 Node.js 环境、安装依赖、清理旧进程，无需手动操作。

#### Windows 用户

**直接双击（默认端口 8080）：**
找到项目目录下的 `start.bat`，双击运行即可。

**传参启动（自定义端口和密码）：**
打开命令提示符（cmd），进入项目目录，执行：

```bash
start.bat 9090 yourpassword
```

- 第 1 个参数：端口号（不传则默认 8081）
- 第 2 个参数：管理员密码（不传则默认 admin123）

#### Linux / macOS 用户

```bash
bash start.sh 9090 yourpassword
```

- 第 1 个参数：端口号（不传则默认 8080）
- 第 2 个参数：管理员密码（不传则默认 admin123）

也可以在启动前先设置环境变量：

```bash
export PORT=9090
export ADMIN_PASSWORD=yourpassword
bash start.sh
```

#### PowerShell 用户

```powershell
.\start.ps1 -Port 9090 -Password "yourpassword"
```

---

### 方式二：直接使用 node 命令启动

适合熟悉命令行的用户，不做任何额外操作，直接启动服务。

```bash
node server.js
```

默认端口 **8080**，默认密码 **admin123**。

启动后在浏览器访问 `http://localhost:8080` 即可。

---

### 方式三：自定义端口和密码启动

#### Linux / macOS（Bash）

```bash
PORT=9090 ADMIN_PASSWORD=yourpassword node server.js
```

#### Windows（PowerShell）

```powershell
$env:PORT=9090; $env:ADMIN_PASSWORD="yourpassword"; node server.js
```

#### Windows（CMD 命令提示符）

```bash
set PORT=9090
set ADMIN_PASSWORD=yourpassword
node server.js
```

---

### 方式四：后台静默运行（Linux）

适合放在服务器上长期运行，退出终端后服务不会停止。

```bash
nohup node server.js > speedtest.log 2>&1 &
```

- 日志输出到 `speedtest.log` 文件
- 查看运行状态：`ps aux | grep server.js`
- 停止服务：`kill <进程ID>`

---

### 方式五：注册为系统服务，开机自启（Linux）

适合生产环境，服务崩溃后自动重启，服务器重启后自动启动。

**1. 创建服务文件：**

```bash
sudo vim /etc/systemd/system/speedtest.service
```

**2. 粘贴以下内容（注意修改路径和密码）：**

```ini
[Unit]
Description=企业内网测速系统
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/Speed-Test-main
ExecStart=/usr/bin/node /opt/Speed-Test-main/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=8080
Environment=ADMIN_PASSWORD=yourpassword

[Install]
WantedBy=multi-user.target
```

**3. 启用并启动服务：**

```bash
sudo systemctl daemon-reload
sudo systemctl enable speedtest    # 设置开机自启
sudo systemctl start speedtest     # 立即启动
sudo systemctl status speedtest    # 查看运行状态
```

**常用管理命令：**

```bash
sudo systemctl stop speedtest      # 停止服务
sudo systemctl restart speedtest   # 重启服务
sudo journalctl -u speedtest -f    # 查看实时日志
```

---

### 方式六：使用 PM2 进程管理（Linux / macOS）

PM2 是 Node.js 的进程管理工具，提供负载均衡、自动重启、日志管理等功能。

**1. 安装 PM2：**

```bash
npm install -g pm2
```

**2. 启动服务：**

```bash
pm2 start server.js --name speedtest
```

**3. 设置开机自启：**

```bash
pm2 startup
pm2 save
```

**常用管理命令：**

```bash
pm2 list                    # 查看所有进程
pm2 logs speedtest          # 查看实时日志
pm2 restart speedtest       # 重启
pm2 stop speedtest          # 停止
pm2 delete speedtest        # 删除进程
```

---

## 验证服务是否启动成功

启动后，在浏览器访问以下地址：

| 页面 | 地址 |
|------|------|
| 测速主页 | `http://<服务器IP>:8080` |
| 管理后台 | `http://<服务器IP>:8080/console/dashboard.html` |
| 登录页面 | `http://<服务器IP>:8080/console/login.html` |
| 健康检查 | `http://<服务器IP>:8080/health` |

> 如果在本机测试，`<服务器IP>` 替换为 `localhost`。
>
> 如果局域网内其他设备访问，`<服务器IP>` 替换为这台电脑的局域网 IP（如 `192.168.1.100`）。
>
> 查看本机局域网 IP：
> - Windows：打开 cmd 输入 `ipconfig`，找"IPv4 地址"
> - Linux：`ip addr` 或 `hostname -I`
> - macOS：`ifconfig`

---

## Nginx 反向代理（生产环境推荐）

通过 Nginx 转发请求，可以实现域名访问、HTTPS 加密、端口隐藏等。

### 基本反向代理配置

创建 Nginx 配置文件 `/etc/nginx/conf.d/speedtest.conf`：

```nginx
server {
    listen 80;
    server_name speedtest.example.com;   # 改为你的域名或IP

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # 测速上传需要传输大文件，关闭缓冲
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

检查配置并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 配置 HTTPS（Let's Encrypt）

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 申请证书并自动配置 Nginx
sudo certbot --nginx -d speedtest.example.com

# 证书自动续期（let's encrypt 证书 90 天有效）
sudo certbot renew --dry-run
```

---

## 配置项说明

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `PORT` | 服务端口 | 8080 |
| `ADMIN_PASSWORD` | 管理后台密码 | admin123 |
| `SESSION_SECRET` | Session 密钥（不设则随机生成） | 随机 |

**使用方式：**

```bash
# Linux / macOS
export PORT=9090
export ADMIN_PASSWORD=mysecret
node server.js

# Windows CMD
set PORT=9090
set ADMIN_PASSWORD=mysecret
node server.js

# Windows PowerShell
$env:PORT=9090
$env:ADMIN_PASSWORD="mysecret"
node server.js
```

---

## 密码管理

首次启动时，密码会自动加密存储在 `data/config.json` 中。

**重置密码为默认值 admin123：**

```bash
node server.js --reset-admin
```

**手动修改密码：**

直接编辑 `data/config.json`，将 `password` 字段改为明文密码，然后删除 `hash` 字段，重启服务即可自动重新加密。

---

## 数据目录

所有数据存储在 `data/` 目录下，备份时直接复制整个目录即可。

```
data/
├── speedtest.db       # SQLite 数据库（测速记录、访问日志）
├── config.json        # 加密后的密码配置
├── results.json       # 测速结果 JSON 备份（可 Excel 打开）
└── logs.json          # 访问日志 JSON 备份
```

---

## 防火墙配置

### Windows 防火墙

以管理员身份打开 PowerShell，执行：

```powershell
New-NetFirewallRule -DisplayName "内网测速系统" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

### Linux

```bash
# Ubuntu（ufw）
sudo ufw allow 8080/tcp

# CentOS / RHEL（firewalld）
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

---

## 常见问题

### 端口被占用

启动脚本会自动杀掉旧 Node.js 进程。如需要手动处理：

```bash
# Linux / macOS
lsof -i :8080          # 查看谁在用端口
kill -9 <进程ID>      # 强制释放

# Windows
netstat -ano | findstr :8080    # 查看端口占用
taskkill /F /PID <进程ID>       # 强制结束进程
```

### 如何修改端口

```bash
# 方法 1：启动时传参（start.bat / start.sh）
start.bat 9090

# 方法 2：设置环境变量
set PORT=9090
node server.js

# 方法 3：直接修改 start.bat 第 8 行的默认值（不推荐）
```

### 局域网其他设备无法访问

检查以下几点：

1. **防火墙** — 确认已开放对应端口（见上方防火墙配置）
2. **IP 地址** — 使用这台电脑的局域网 IP，而不是 `localhost`
3. **网络连通** — 在同一局域网下，ping 服务器 IP 确认网络通

### SQLite 编译失败

`better-sqlite3` 需要 C++ 编译环境。

**Ubuntu / Debian：**

```bash
sudo apt install build-essential python3
```

**Windows：**

```bash
npm install --global windows-build-tools
```

**如果还不行，尝试重新编译：**

```bash
npm rebuild better-sqlite3 --build-from-source
```

### 中文 PDF 报告乱码

**Ubuntu / Debian：**

```bash
sudo apt install fonts-noto-cjk
```

**CentOS / RHEL：**

```bash
sudo yum install google-noto-sans-cjk-fonts
```

**Windows** 自带微软雅黑字体，无需额外安装。

---

## 升级版本

1. **备份数据：** 复制 `data/` 目录到安全位置
2. **替换代码：** 将新版文件解压覆盖到项目目录（不要删除 `data/` 目录）
3. **重新安装依赖：** 执行 `npm install`
4. **重启服务：** 按上方启动方式重新运行即可

```bash
# 完整升级示例
cp -r data data_backup          # 备份数据
# 解压新版覆盖...
npm install                     # 重装依赖
bash start.sh                   # 重启服务
```
