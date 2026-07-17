# GitHub Pages 单网页自动更新版

最终部署产物只有 `site/index.html` 一个网页文件。GitHub Actions 每15分钟获取一次数据，合并上一版匿名快照，然后重新发布到 GitHub Pages。访客打开页面后每5分钟自动刷新，以看到 Actions 最近生成的数据。

## 第一次发布

1. 在 GitHub 新建一个仓库，建议仓库中只放本目录内容。
2. 进入仓库 `Settings → Secrets and variables → Actions`，添加两个 Repository secrets：
   - `QUICKFORM_APIS`：四个接口用英文逗号连接。
   - `PUBLIC_DATA_SALT`：至少32位、长期不变的随机字符串，用于生成稳定匿名编号。
3. 进入 `Settings → Pages`，将 Source 设为 `GitHub Actions`。
4. 打开 `Actions → 更新数据并部署单页 → Run workflow`，执行第一次发布。
5. 工作流结束后，Pages 页面会显示公开网址。

## 数据不会被空响应覆盖

- 接口成功且返回非空记录时才生成新快照。
- 新匿名记录与 `site/index.html` 内的上一版匿名记录合并。
- 学习分数、完成章节、互动数等使用历史与最新数据的较大值，避免接口只返回最近数据导致旧指标下降。
- 所有接口同时失败时，保留上一版生成时间和全部页面数据。
- `site/index.html` 会自动提交回仓库，因此可以通过 Git 历史恢复任意旧版本。

## 公开范围与隐私提醒

- 最终 HTML 按当前发布要求包含学生真实姓名、所属班级、学习统计、留言和笔记正文；公开部署前请确认已取得学校及监护人允许。
- 最终 HTML 不包含 QuickForm 接口地址、IP或密钥。
- 四个接口只配置在 GitHub Actions Secrets 中。
- 仓库中不要上传 `quickform_backups`、`seed_data`、Supabase 导出或其他原始学生资料。

## 更新频率

工作流计划为每小时第7、22、37、52分钟运行，即约15分钟一次。GitHub Actions 定时任务可能延迟，因此不能视为严格实时系统。页面自身每5分钟刷新一次，但只有 Actions 已生成新版本时才会出现新数据。
