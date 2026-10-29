# 从 GitHub 自动构建并更新 Worker

`cn-video-search` 已通过原生 Cloudflare Workers Builds 连接仓库 `Swebersmith/cn-video-search-worker`，监听 `main` 分支。配置对应现有 Worker，自定义域名仍为 `https://videosearch.webber.qzz.io`。

## 日常更新

1. 修改代码、说明页面或配置。
2. 提交到 `main`，或将 PR 合并到 `main`。
3. Cloudflare 自动拉取该提交，安装依赖并运行检查与测试。
4. 检查通过后执行 Wrangler 部署，更新现有 Worker。
5. 在 Cloudflare 的 Worker → Settings → Builds 查看状态与日志，成功后访问正式域名。

构建环境使用 Node.js 24，项目根目录为 `/`，依赖使用仓库中的 npm 锁文件。

构建命令：

```bash
npm run check && npm test && npm run test:runtime
```

部署命令：

```bash
npm run deploy -- --keep-vars
```

`test:runtime` 包含 Worker 打包及真实 workerd 运行时测试。只有前面各步骤成功，才会执行部署命令。任一构建或检查步骤失败时，既有成功部署保持在线；修复后再次推送即可重新触发。

## 分支、变量与凭据

- 生产分支为 `main`，监听全部路径；其他分支不会部署到生产，预览构建当前关闭。`wrangler.jsonc` 同时设置 `preview_urls=false`，关闭版本预览 URL。
- 构建缓存已开启，用于复用依赖与构建产物。
- 构建系统使用同一 Cloudflare 账户内已有的构建凭据，不在本仓库或 GitHub Secrets 中保存凭据值。
- 构建变量 `NODE_VERSION=24` 只用于构建环境；运行时 Secret 仍在 Worker 的 Variables & Secrets 中管理。
- `--keep-vars` 保留控制台中的运行时变量；已有 Secret 不因代码发布而删除。
- 域名配置在 `wrangler.jsonc`，后续自动部署会保留 `videosearch.webber.qzz.io`。

## 与 GitHub Actions 的关系

GitHub Actions 的 CI 继续执行检查。Cloudflare Workers Builds 自行完成生产构建与部署，不依赖 GitHub Actions 的 Cloudflare Token。仓库内 **Deploy Worker** 是手动备用流程，没有开启 push 自动发布，以免两个系统同时发布同一提交。

CI 成功不等于 Cloudflare 部署成功；以 Cloudflare Builds 的部署步骤和 Worker 当前版本为准。若构建因 GitHub App 授权或部署凭据权限失效而失败，在 Cloudflare 的 Builds 设置里修复连接/凭据后重试。

## 已完成的推送验证

2026-10-29，将说明更新提交 `c8c49545f74345e5f95789acc3a8fe677ce11881` 推送到 `main` 后，Cloudflare 收到 `push_event`，自动生成构建 `86cf0208-254d-4614-b917-82eeabd331fb`。该构建自动安装 Node.js 24 及锁定依赖，通过类型检查、40 项回归测试和 1 项 workerd 运行时测试，并成功执行部署；生成 Worker 版本 `3890ea0d-fd2f-4940-844a-6017604aa3fe`，原自定义域名保留。

这次构建由 GitHub 推送直接触发，没有手动调用构建或部署 API。
