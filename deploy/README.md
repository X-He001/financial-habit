# Financial Habit 部署指南（Linux 服务器）

前后端一体的单进程部署：后端 Express 同时托管前端构建产物（dist/）和 API。
服务器只需跑一个 Node 进程，SQLite 数据库存一份文件，简单稳定。

## 一、服务器准备

```bash
# 安装 Node.js 18+（以 Ubuntu/Debian 为例，或用 nvm 安装）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node -v   # v18 及以上
npm -v
```

## 二、上传代码

把项目目录传到服务器（方式任选：git clone / scp / rsync），例如放到 `/opt/financial-habit`：

```bash
# 本地上传示例（在本机执行）
scp -r ./项目目录 user@服务器IP:/opt/financial-habit
```

## 三、安装依赖 + 构建前端

```bash
cd /opt/financial-habit
npm install --omit=dev        # 生产依赖（express/cors/better-sqlite3）
npm run build                 # 生成 dist/（前端构建产物）
```

> 说明：`npm run build` 会执行 `tsc -b && vite build`。如果只想装运行所需依赖，
> 用 `npm install --omit=dev` 即可（better-sqlite3 是原生模块，服务器需能联网编译或已提供预编译包）。

## 四、启动（前后端一体，单进程）

```bash
# 前台试跑
npm run server
# 浏览器访问 http://服务器IP:3001/ 应看到网站；/api/health 应返回 {"status":"ok"}
```

环境变量（全部可选，有默认值）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3001` | 服务端口 |
| `DATA_DIR` | `server/data.sqlite` | SQLite 文件路径（可用绝对路径如 `/var/lib/financial-habit`，自动创建） |
| `FRONTEND_DIST` | `./dist` | 前端构建产物目录（一般不用改） |
| `VITE_API_URL` | 同源（不写就用当前域名） | 前端调后端地址，一体部署不用设；分离部署时才需要 |

## 五、常驻运行（systemd，开机自启 + 崩溃自动重启）

1. 复制服务文件并修改里面的路径：

```bash
sudo cp deploy/financial-habit.service /etc/systemd/system/
sudo nano /etc/systemd/system/financial-habit.service
# 确认 ExecStart 里的项目路径（/opt/financial-habit）和 User 正确
```

2. 启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable financial-habit    # 开机自启
sudo systemctl start financial-habit     # 立即启动
sudo systemctl status financial-habit    # 查看状态
```

3. 常用命令：

```bash
sudo systemctl restart financial-habit   # 重启
sudo systemctl stop financial-habit      # 停止
journalctl -u financial-habit -f         # 实时看日志
```

## 六、防火墙 / 反向代理（可选）

- 简单方式：防火墙放行 3001 端口 `sudo ufw allow 3001`，直接访问 `http://IP:3001`
- 推荐方式：Nginx 反向代理 + HTTPS。Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 七、数据备份

SQLite 就是一个文件（默认 `server/data.sqlite`），备份方式：

```bash
# 每日定时备份（示例 crontab：每天 3 点）
0 3 * * * cp /opt/financial-habit/server/data.sqlite /backup/financial-habit-$(date +\%F).sqlite
```

恢复：把备份文件放回原路径，重启服务即可。前端本地 IndexedDB 数据也可通过设置页
「推送本地数据到云端」重新同步到服务器。

## 八、手机/电脑共用数据

1. 在另一台设备的浏览器打开 `http://服务器IP:3001`（或你的域名）
2. 设置页 → 数据同步 → 云端地址填 `http://服务器IP:3001`（或域名）
3. 点「测试连接」确认连通 → 点「推送本地数据到云端」把该设备的本地数据推上去
4. 所有设备共用服务器上的同一份数据（本地 IndexedDB 是缓存副本，服务器 SQLite 是主数据）
