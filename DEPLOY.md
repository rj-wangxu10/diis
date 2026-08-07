# DataFoundry 远程服务器部署指南

> 目标：将当前 DataFoundry 项目打包，上传到远程服务器并完成生产级部署。

---

## 1. 本地打包前准备

### 1.1 确认已构建

```bash
npm run build
npm run build:web
```

构建产物：
- API：`apps/api/dist/`
- Web：`apps/web/.next/`
- TUI：`apps/tui/dist/`（可选）

### 1.2 生成强密钥（不要复用 `.env` 中的 placeholder）

```bash
# Linux / macOS / Git Bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

将生成的两个密钥分别填入：
- `SECRET_MASTER_KEY`
- `AUTH_SESSION_SECRET`

### 1.3 配置生产环境 `.env`

复制根目录 `.env` 为 `.env.production`，至少修改以下关键项：

```bash
# === 安全密钥（必须替换） ===
SECRET_MASTER_KEY=your-generated-32-char-random-key
AUTH_SESSION_SECRET=your-generated-32-char-random-key

# === 对外访问地址（必须改为服务器公网域名或 IP） ===
AUTH_PUBLIC_BASE_URL=https://your-domain.com

# === LLM（必须配置） ===
LLM_PROVIDER=openai-compatible
LLM_MODEL=qwen-plus
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=your-llm-api-key

# === 邮件（真实生产必须 SMTP） ===
AUTH_EMAIL_DELIVERY=smtp
AUTH_EMAIL_FROM=DIIS <no-reply@your-domain.com>
AUTH_SMTP_HOST=smtp.your-domain.com
AUTH_SMTP_PORT=587
AUTH_SMTP_SECURE=false
AUTH_SMTP_USER=your-smtp-user
AUTH_SMTP_PASSWORD=your-smtp-password

# === 绑定地址（按需） ===
API_HOST=127.0.0.1
API_PORT=8787
WEB_HOST=127.0.0.1
WEB_PORT=3000

# === 存储路径（建议指向持久化目录） ===
STORAGE_ROOT_DIR=/opt/datafoundry/storage
METADATA_DB_PATH=/opt/datafoundry/storage/metadata/workbench.sqlite
```

> 注意：不要上传本地的 `apps/api/storage/` 开发数据到生产服务器。生产部署建议清空或重新初始化存储。

### 1.4 创建 Web 生产环境文件

```bash
cp apps/web/.env.example apps/web/.env.production.local
```

内容示例：

```bash
API_PROXY_TARGET=http://127.0.0.1:8787
NEXT_PUBLIC_AGENT_RUNTIME_URL=
NEXT_PUBLIC_CONFIG_API_URL=
```

---

## 2. 打包项目

### 2.1 创建部署包

```bash
# 在项目根目录执行
tar -czvf datafoundry-deploy.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='apps/api/storage' \
  --exclude='apps/web/.next/cache' \
  --exclude='*.log' \
  --exclude='.venv' \
  --exclude='apps/api/dist' \
  --exclude='apps/web/.next' \
  --exclude='apps/tui/dist' \
  .
```

> 这里排除了 `node_modules` 和构建产物，到服务器上重新安装并构建。

### 2.2 或者包含构建产物打包（服务器上无需重新构建）

如果服务器也有 Node 22 环境，推荐到服务器上执行 `npm install && npm run build`。

如果想跳过服务器构建，可以先本地构建并打包：

```bash
npm ci
npm run build
npm run build:web
npm run build:tui

tar -czvf datafoundry-deploy-with-build.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='apps/api/storage' \
  --exclude='apps/web/.next/cache' \
  --exclude='*.log' \
  --exclude='.venv' \
  .
```

> 即使包含构建产物，服务器仍然需要 `npm install --production` 或 `npm ci` 安装依赖。

---

## 3. 上传到远程服务器

```bash
scp datafoundry-deploy.tar.gz root@your-server-ip:/opt/
ssh root@your-server-ip
```

---

## 4. 服务器端部署

### 4.1 解压

```bash
cd /opt
mkdir -p datafoundry
tar -xzvf datafoundry-deploy.tar.gz -C datafoundry
cd datafoundry
```

### 4.2 安装依赖

```bash
# 要求 Node.js >= 22
node -v

npm ci
```

### 4.3 配置生产环境

```bash
cp .env.production .env
cp apps/web/.env.production.local apps/web/.env.local
```

确认 `.env` 中的 `AUTH_PUBLIC_BASE_URL`、`SECRET_MASTER_KEY`、`AUTH_SESSION_SECRET`、LLM 和 SMTP 配置正确。

### 4.4 创建持久化存储目录

```bash
mkdir -p /opt/datafoundry/storage
```

> 首次启动会自动创建 SQLite 数据库和必要目录。

### 4.5 构建（如果打包时未包含构建产物）

```bash
npm run build
npm run build:web
```

### 4.6 启动服务

#### 方式 A：直接前台启动（测试）

```bash
npm run start
```

#### 方式 B：使用 deploy.sh 作为后台托管进程（推荐 Ubuntu/Debian）

```bash
./deploy.sh
```

管理命令：

```bash
./deploy.sh status
./deploy.sh stop
./deploy.sh start
./deploy.sh logs
./deploy.sh doctor
```

#### 方式 C：使用 systemd（推荐正式生产）

创建 `/etc/systemd/system/datafoundry.service`：

```ini
[Unit]
Description=DataFoundry
After=network.target

[Service]
Type=simple
User=datafoundry
Group=datafoundry
WorkingDirectory=/opt/datafoundry
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable datafoundry
sudo systemctl start datafoundry
sudo systemctl status datafoundry
```

---

## 5. 反向代理（Nginx）

参考项目中的 `deploy/nginx.datafoundry.conf.example`。

关键注意点：
- `/api/copilotkit` 必须关闭 gzip、proxy buffering，保持 SSE 长连接
- `/api/` 走 Web（Next.js BFF 代理到 API）
- 其他走 Web
- TLS 在 Nginx 层终止

示例配置见 `deploy/nginx.datafoundry.conf.example`。

---

## 6. 验证

```bash
# 健康检查
curl https://your-domain.com/healthz

# 准备就绪检查
curl https://your-domain.com/ready

# 打开浏览器访问
https://your-domain.com/login
```

---

## 7. 首次使用

1. 注册管理员账号
2. 登录后创建 OpenAI-compatible 模型配置
3. 进入 `/data-tasks` 开始数据分析

---

## 8. 更新部署

后续更新代码后：

```bash
# 本地
npm run build
npm run build:web
tar -czvf datafoundry-deploy.tar.gz --exclude='node_modules' --exclude='.git' --exclude='apps/api/storage' --exclude='apps/web/.next/cache' --exclude='*.log' --exclude='.venv' .

# 服务器
./deploy.sh stop
cd /opt/datafoundry
tar -xzvf /opt/datafoundry-deploy.tar.gz --overwrite
npm ci
npm run build
npm run build:web
./deploy.sh
```

---

## 附：远程部署清单

- [ ] Node.js >= 22 已安装
- [ ] `SECRET_MASTER_KEY` 和 `AUTH_SESSION_SECRET` 已替换为强随机字符串
- [ ] `AUTH_PUBLIC_BASE_URL` 已改为真实域名
- [ ] LLM API Key 已配置
- [ ] SMTP 邮件已配置（生产环境）
- [ ] 存储目录已持久化
- [ ] Nginx 反向代理已配置
- [ ] TLS 证书已配置
- [ ] 防火墙已开放 80/443
- [ ] 健康检查通过
