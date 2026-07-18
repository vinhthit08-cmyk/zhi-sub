# 国内稳定部署说明

这个版本用于部署到国内云服务器、学校服务器或国内可访问的网站。它保留现有页面效果和数据快照，同时提供同域名 AI 代理与后台定时数据更新。

## 它解决什么问题

- 访问页面不再依赖 GitHub Pages。
- AI 学情分析不再依赖 `workers.dev`，改为同域名 `/api/analyze`。
- 服务器每 30 秒自动抓取 QuickForm，并把新数据合并进 `site/index.html`。
- QuickForm 老接口额度不足时，不会覆盖或清空已有快照。

## 服务器要求

- Node.js 20 或更高版本。
- 一台国内能访问 `quickform.cn` 和 `ark.cn-beijing.volces.com` 的服务器。
- 如果要公网访问，需要备案域名或服务器公网 IP。

## 启动方式

1. 上传整个仓库到国内服务器。
2. 复制环境变量模板：

```bash
cp domestic.env.example .env
```

3. 编辑 `.env`，把 `ARK_API_KEY` 换成真实密钥，`PUBLIC_DATA_SALT` 换成一串长随机字符。
4. 启动服务：

```bash
set -a
source .env
set +a
npm run serve:domestic
```

Windows PowerShell 可用：

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
  }
}
npm run serve:domestic
```

## 访问地址

- 本机测试：`http://服务器IP:3000/`
- 健康检查：`http://服务器IP:3000/api/health`
- 手动刷新数据：向 `http://服务器IP:3000/api/refresh` 发送 POST 请求

## 正式公开访问

建议用 Nginx 把域名反向代理到 `127.0.0.1:3000`，再配置 HTTPS。

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 重要提醒

- 不要把 `.env` 上传到 GitHub。
- `ARK_API_KEY` 只放服务器环境变量里，不要写进 HTML。
- 如果只是把 `site/index.html` 上传到普通静态空间，可以显示旧快照，但不能由服务器自动保存新快照，也不能稳定使用同域名 AI 代理。
