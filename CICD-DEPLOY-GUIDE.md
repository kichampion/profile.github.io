# 🚀 静态网站 CICD 部署全流程教程

## 从零搭建 GitHub Actions 自动部署到自有服务器

---

## 📋 目录

1. [项目概况](#1-项目概况)
2. [整体架构](#2-整体架构)
3. [服务器配置](#3-服务器配置)
4. [GitHub 配置](#4-github-配置)
5. [代码配置](#5-代码配置)
6. [触发部署](#6-触发部署)
7. [常见问题排查](#7-常见问题排查)
8. [进阶优化](#8-进阶优化)

---

## 1. 项目概况

### 当前项目特点

| 项目属性 | 详情 |
|---------|------|
| 项目类型 | 纯静态网站（HTML + JS + CSS + JSON） |
| 仓库地址 | `git@github.com:skyshowjoker/profile.github.io.git` |
| 主要文件 | `index.html`, `nba-data.js`, `colorbox-ai_v2.1.6.js`, `fetch-nba-data.py` 等 |
| 构建工具 | 无（无需 npm/build） |
| 部署方式 | 直接拷贝文件到服务器 Nginx 目录 |

### 核心文件清单

```
skyshowjoker.github.io/
├── index.html              # 主页面（NBA 82-0 大挑战）
├── nba-data.js             # NBA 球员数据（2.6MB）
├── colorbox-ai_v2.1.6.js   # AI 相关 JS
├── __ai_app.html           # AI 应用页面
├── fetch-nba-data.py       # 数据抓取脚本
├── name_map.json           # 球员名称映射
├── pos_map.json            # 位置映射
├── resume/                 # 简历子页面
│   ├── index.html
│   └── resume-en.html
├── static/                 # 静态资源
│   ├── css/
│   ├── fonts/
│   ├── image/
│   └── js/
└── temp/                   # 临时文件（不需要部署）
```

---

## 2. 整体架构

### 工作流程

```
你本地 push 代码 → GitHub 仓库
                         ↓
                  GitHub Actions 触发
                         ↓
              通过 SSH 连接到你的服务器
                         ↓
              拉取最新代码到服务器
                         ↓
              复制文件到 Nginx 目录
                         ↓
              用户访问你的域名 ✅
```

### 架构图

```
┌──────────────┐     git push      ┌──────────────────┐
│  你的电脑     │ ───────────────→  │  GitHub 仓库      │
│  (git push)  │                   │  skyshowjoker/   │
└──────────────┘                   │  profile.github.io│
                                   └────────┬─────────┘
                                            │ 触发
                                            ▼
                                   ┌──────────────────┐
                                   │  GitHub Actions   │
                                   │  (CI/CD Runner)   │
                                   │  - 检出代码       │
                                   │  - SSH 连接服务器  │
                                   │  - 执行部署脚本   │
                                   └────────┬─────────┘
                                            │ SSH + rsync
                                            ▼
                                   ┌──────────────────┐
                                   │  你的服务器       │
                                   │  ┌─────────────┐ │
                                   │  │  Nginx      │ │
                                   │  │  /var/www/  │ │
                                   │  │  skyshow/   │ │
                                   │  └─────────────┘ │
                                   └──────────────────┘
                                            │
                                            ▼
                                   👤 用户访问你的域名
```

---

## 3. 服务器配置

> **前提**：你已有一台 Linux 服务器（Ubuntu/CentOS 均可），并且可以通过 SSH 登录。

### 3.1 登录服务器

```bash
ssh root@你的服务器IP
```

### 3.2 创建部署专用用户（推荐，安全最佳实践）

```bash
# 创建 deploy 用户
sudo useradd -m -s /bin/bash deploy

# 设置密码（可选，我们用 SSH Key）
sudo passwd deploy

# 将 deploy 用户加入 www-data 组（Ubuntu）或 nginx 组
sudo usermod -aG www-data deploy   # Ubuntu/Debian
# sudo usermod -aG nginx deploy    # CentOS/RHEL
```

### 3.3 安装 Nginx

**Ubuntu/Debian：**
```bash
sudo apt update
sudo apt install nginx -y
sudo systemctl enable nginx
sudo systemctl start nginx
```

**CentOS/RHEL：**
```bash
sudo yum install nginx -y
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 3.4 创建网站目录

```bash
# 创建网站根目录
sudo mkdir -p /var/www/skyshow

# 将目录所有权给 deploy 用户
sudo chown -R deploy:www-data /var/www/skyshow

# 设置目录权限
sudo chmod -R 755 /var/www/skyshow
```

### 3.5 配置 Nginx 虚拟主机

创建 Nginx 配置文件：

```bash
sudo nano /etc/nginx/sites-available/skyshow
```

写入以下内容（**请替换 `your-domain.com` 为你的实际域名或服务器 IP**）：

```nginx
server {
    listen 80;
    server_name your-domain.com;   # 替换为你的域名或 IP

    root /var/www/skyshow;
    index index.html;

    # 日志文件
    access_log /var/log/nginx/skyshow_access.log;
    error_log /var/log/nginx/skyshow_error.log;

    # Gzip 压缩（加速大文件传输）
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;
    gzip_min_length 1000;
    gzip_comp_level 6;

    # 静态资源缓存（7天）
    location /static/ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # JSON 数据文件缓存（1天）
    location ~* \.(json|js)$ {
        expires 1d;
        add_header Cache-Control "public";
    }

    # HTML 文件不缓存
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache";
    }

    # 主入口
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 安全：禁止访问隐藏文件
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
```

启用站点：

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/skyshow /etc/nginx/sites-enabled/

# 测试配置是否正确
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

### 3.6 配置防火墙

```bash
# 如果使用 ufw（Ubuntu）
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp    # SSH 端口
sudo ufw enable

# 如果使用 firewalld（CentOS）
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
```

### 3.7 生成 SSH Key 给 GitHub Actions 使用

在**服务器上**执行：

```bash
# 切换到 deploy 用户
sudo su - deploy

# 生成 SSH Key（一路回车，不要设置密码）
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/id_ed25519

# 查看公钥（复制输出内容，后面会用到）
cat ~/.ssh/id_ed25519.pub

# 将公钥加入 authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys

# 设置正确权限
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
chmod 600 ~/.ssh/id_ed25519

# 查看私钥（复制输出内容，后面会用到）
cat ~/.ssh/id_ed25519
```

> ⚠️ **重要**：请将上述输出的**公钥**和**私钥**都保存下来，后面配置 GitHub 时需要用到。

### 3.8 验证 SSH 连接（在服务器本地测试）

```bash
# 仍在 deploy 用户下
ssh -o StrictHostKeyChecking=no deploy@localhost "echo 'SSH OK'"
# 应该输出：SSH OK
```

---

## 4. GitHub 配置

### 4.1 添加 SSH 私钥到 GitHub Secrets

这是最关键的一步！GitHub Actions 需要通过 SSH 连接到你的服务器。

1. 打开你的 GitHub 仓库页面：https://github.com/skyshowjoker/profile.github.io
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**，添加以下 4 个 Secrets：

| Secret 名称 | 值 | 说明 |
|-------------|-----|------|
| `SSH_PRIVATE_KEY` | 服务器上 `~/.ssh/id_ed25519` 的**私钥**内容 | GitHub Actions 用这个登录服务器 |
| `SSH_HOST` | 你的服务器 IP 地址 | 如 `123.456.789.0` |
| `SSH_USER` | `deploy` | 服务器上的部署用户名 |
| `SSH_PORT` | `22` | SSH 端口（如果改了端口就填你的） |

> 📝 **SSH_PRIVATE_KEY 的格式**：复制时请包含完整的 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----`，包括首尾行。

填写示例：
```
SSH_PRIVATE_KEY:
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
...（中间很多行）...
-----END OPENSSH PRIVATE KEY-----
```

### 4.2 验证 Secrets 配置

确保 4 个 Secrets 都已添加：

![Secrets 列表应该包含 4 项](你可以在 Settings → Secrets and variables → Actions 中看到它们)

---

## 5. 代码配置

### 5.1 创建 GitHub Actions 工作流文件

在你的**本地项目根目录**创建以下目录和文件：

```bash
mkdir -p .github/workflows
```

### 5.2 创建部署工作流

创建文件 `.github/workflows/deploy.yml`：

```yaml
name: 🚀 Deploy to Server

on:
  push:
    branches:
      - main        # 当 main 分支有 push 时触发
  workflow_dispatch: # 允许手动触发部署

jobs:
  deploy:
    name: Deploy to Production Server
    runs-on: ubuntu-latest

    steps:
      # ─── 第 1 步：检出代码 ───
      - name: 📥 Checkout Code
        uses: actions/checkout@v4

      # ─── 第 2 步：清理不需要部署的文件 ───
      - name: 🧹 Clean Up Unnecessary Files
        run: |
          # 删除不需要部署的文件和目录
          rm -rf .git
          rm -rf .github
          rm -rf .idea
          rm -rf temp
          rm -rf .claude
          rm -f .gitignore
          rm -f README.md
          rm -f "Genimex Group.pdf"
          echo "✅ Cleanup done. Files to deploy:"
          ls -la

      # ─── 第 3 步：通过 rsync 同步到服务器 ───
      - name: 🚀 Deploy via rsync
        uses: burnett01/rsync-deployments@7.0.1
        with:
          switches: -avzr --delete
          path: ./
          remote_path: /var/www/skyshow/
          remote_host: ${{ secrets.SSH_HOST }}
          remote_user: ${{ secrets.SSH_USER }}
          remote_port: ${{ secrets.SSH_PORT }}
          remote_key: ${{ secrets.SSH_PRIVATE_KEY }}

      # ─── 第 4 步：部署后校验 ───
      - name: ✅ Verify Deployment
        run: |
          echo "🎉 Deployment completed!"
          echo "📋 Visit your site at: http://${{ secrets.SSH_HOST }}"
```

### 5.3 创建 `.gitignore` 文件

在项目根目录创建 `.gitignore`：

```gitignore
# IDE
.idea/

# Claude AI
.claude/

# 临时文件
temp/

# 系统文件
.DS_Store
Thumbs.db

# 不需要部署的 PDF
*.pdf
```

### 5.4 项目最终目录结构

```
skyshowjoker.github.io/
├── .github/
│   └── workflows/
│       └── deploy.yml          # ← 部署工作流配置
├── .gitignore                  # ← 新增
├── index.html
├── nba-data.js
├── colorbox-ai_v2.1.6.js
├── __ai_app.html
├── fetch-nba-data.py
├── name_map.json
├── pos_map.json
├── resume/
│   ├── index.html
│   └── resume-en.html
└── static/
    ├── css/
    ├── fonts/
    ├── image/
    └── js/
```

---

## 6. 触发部署

### 6.1 提交代码并推送

```bash
# 进入项目目录
cd /Users/mac/IdeaProjects/skyshowjoker.github.io

# 添加所有文件
git add .

# 提交
git commit -m "feat: add GitHub Actions CICD deployment workflow"

# 推送到 GitHub
git push origin main
```

### 6.2 查看部署状态

1. 打开 GitHub 仓库页面：https://github.com/skyshowjoker/profile.github.io
2. 点击 **Actions** 标签
3. 你会看到正在运行的 `🚀 Deploy to Server` 工作流
4. 点击进去可以看到每一步的实时日志

### 6.3 手动触发部署

除了 push 自动触发，你也可以手动触发：

1. GitHub 仓库 → **Actions** → **🚀 Deploy to Server**
2. 点击 **Run workflow** 按钮
3. 选择 `main` 分支，点击 **Run workflow**

### 6.4 验证部署结果

部署成功后，在浏览器访问：

```
http://你的服务器IP
```

你应该能看到你的 NBA 82-0 大挑战页面！

---

## 7. 常见问题排查

### 7.1 SSH 连接失败

**错误信息**：`ssh: connect to host xxx port 22: Connection refused`

**解决方法**：
- 检查服务器 IP 是否正确
- 检查服务器 SSH 服务是否运行：`systemctl status sshd`
- 检查防火墙是否开放 22 端口
- 检查 `SSH_HOST` Secret 是否填写正确

### 7.2 SSH 权限被拒绝

**错误信息**：`Permission denied (publickey)`

**解决方法**：
- 检查 `SSH_PRIVATE_KEY` Secret 是否完整复制（包含首尾的 `-----BEGIN/END-----`）
- 检查服务器上 `~/.ssh/authorized_keys` 是否包含对应的公钥
- 检查服务器上 `.ssh` 目录权限：`chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`

### 7.3 rsync 权限不足

**错误信息**：`rsync: mkdir "/var/www/skyshow" failed: Permission denied`

**解决方法**：
```bash
# 在服务器上执行
sudo chown -R deploy:www-data /var/www/skyshow
sudo chmod -R 755 /var/www/skyshow
```

### 7.4 Nginx 403 Forbidden

**解决方法**：
```bash
# 检查 Nginx 用户是否有读取权限
sudo chmod -R 755 /var/www/skyshow
sudo chown -R deploy:www-data /var/www/skyshow

# 检查 Nginx 运行用户
ps aux | grep nginx

# 确保 Nginx 用户（通常是 www-data 或 nginx）能访问目录
sudo usermod -aG www-data deploy
```

### 7.5 网站能访问但看不到更新

**解决方法**：
- 清除浏览器缓存（Ctrl+Shift+R 强制刷新）
- 检查 Nginx 缓存配置
- 确认 GitHub Actions 部署日志显示成功

---

## 8. 进阶优化

### 8.1 添加 HTTPS（Let's Encrypt 免费证书）

```bash
# 在服务器上安装 certbot
sudo apt install certbot python3-certbot-nginx -y   # Ubuntu
# sudo yum install certbot python3-certbot-nginx -y  # CentOS

# 自动配置 HTTPS（替换为你的域名）
sudo certbot --nginx -d your-domain.com

# 设置自动续期
sudo certbot renew --dry-run
```

### 8.2 添加部署通知

在 `.github/workflows/deploy.yml` 的末尾添加（需要配置对应平台的 Webhook）：

```yaml
      # ─── 第 5 步：发送通知（可选）───
      - name: 🔔 Notify via Slack/WeChat
        if: always()
        run: |
          if [ "${{ job.status }}" == "success" ]; then
            echo "✅ 部署成功！"
          else
            echo "❌ 部署失败，请检查日志！"
          fi
```

### 8.3 多环境部署（测试/生产）

如果你有测试服务器和生产服务器，可以创建两个工作流：

- `.github/workflows/deploy-staging.yml` — 推送到 `develop` 分支时部署到测试服务器
- `.github/workflows/deploy-prod.yml` — 推送到 `main` 分支时部署到生产服务器

### 8.4 添加部署前检查

```yaml
      # 在 deploy job 之前添加
      check:
        name: Pre-deploy Checks
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - name: 🔍 Check file sizes
            run: |
              echo "Checking for oversized files..."
              find . -type f -size +10M -exec echo "⚠️  Large file: {}" \;
          - name: 🔍 Validate HTML
            run: |
              echo "Basic HTML validation..."
              grep -q "<html" index.html && echo "✅ index.html looks valid" || echo "❌ index.html may be invalid"
```

---

## 📋 快速检查清单

部署前请确认以下所有项目：

- [ ] 服务器已安装 Nginx 并运行
- [ ] 服务器已创建 `deploy` 用户
- [ ] 服务器已创建 `/var/www/skyshow` 目录
- [ ] 服务器已配置 Nginx 虚拟主机
- [ ] 服务器已生成 SSH Key 并配置 authorized_keys
- [ ] GitHub Secrets 已配置 4 个变量（SSH_PRIVATE_KEY, SSH_HOST, SSH_USER, SSH_PORT）
- [ ] 项目已创建 `.github/workflows/deploy.yml`
- [ ] 项目已创建 `.gitignore`
- [ ] 代码已推送到 GitHub main 分支
- [ ] GitHub Actions 运行成功
- [ ] 浏览器能正常访问网站

---

## 🎯 总结

完成以上配置后，你的部署流程将是：

1. **本地改代码** → `git add . && git commit -m "update" && git push`
2. **GitHub Actions 自动运行** → 约 30 秒完成
3. **网站自动更新** → 用户刷新即可看到最新内容

整个过程全自动，你只需要专注写代码，剩下的交给 CI/CD！🚀

---

> 📅 文档生成日期：2026-06-22
> 📦 适用项目：skyshowjoker/profile.github.io（纯静态网站）
