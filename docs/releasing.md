# 发布流程

每次发布都需要**新的版本号 + 与之匹配的新 tag**，二者缺一不可：

- `.github/workflows/publish.yml` 的 `Check tag matches package version` 要求触发 ref 必须是 tag，且名字严格等于 `v${package.json.version}`；
- npm 拒绝覆盖已存在的版本，同一个版本换个 tag 也发不出去。

## 一条命令

```sh
pnpm release prerelease        # 0.8.0-rc.1 -> 0.8.0-rc.2，发到 dist-tag next
pnpm release 0.8.0             # 正式版，发到 dist-tag latest
pnpm release patch --dry-run   # 只做检查并打印计划，不改任何东西
```

`scripts/release.mjs` 会依次：

1. **预检**：必须在 `main`、工作区干净、本地与 `origin/main` 一致、`origin` 指向本仓库、tag `vX` 本地/远程都不存在、npm 上没有该版本、`package.json` 的 `name`/`repository` 正确。
2. 把新版本写入 `package.json`。
3. 依次执行 `pnpm build`、`pnpm typecheck`、`pnpm test`；失败会恢复 `package.json` 并中止（不提交、不打 tag、不推送）。
4. 只暂存 `package.json` 与 `lib/`，提交 `chore: release vX`，打注解 tag `vX`。
5. 推送 `main` 与 tag；tag 触发 `publish.yml`，用 npm Trusted Publishing（OIDC + provenance）发布。

## 选项

| 选项 | 用途 |
| --- | --- |
| `--preid <id>` | `prerelease` 递增用的标识，默认 `rc` |
| `--dry-run` | 只检查、打印计划，不写文件 |
| `--yes` / `-y` | 跳过确认（非交互环境必须加） |
| `--no-push` | 本地提交 + 打 tag 后停下，便于人工复核 |
| `--skip-checks` | 跳过 build/typecheck/test（不建议） |
| `--skip-npm-check` | 跳过 npm registry 查询（离线时用） |

## 失败与中断

| 情况 | 结果与处理 |
| --- | --- |
| 预检失败 | 未做任何改动；按提示修复（切回 main、提交/清理、对齐 origin/main、换版本号）后重跑 |
| build/typecheck/test 失败 | `package.json` 已恢复，未提交/未打 tag/未推送；修好后重跑 |
| 已提交、已打 tag，但 push 失败 | 重跑会被「本地与 origin/main 不一致」拦下；手动 `git push origin main && git push origin vX` |
| 推送成功但工作流失败 | tag 与版本已被占用，**必须发新版本**（如 `v0.8.0-rc.3`），不能复用 tag 或版本 |

## 发布后核对

```sh
npm view @laufry/dsh-smooth-stream dist-tags --json
gh run list -R 0-CHENAI/dsh-smooth-stream -L 3
```

`next` 是指针，多个预发布版本会互相覆盖（`rc.2` 覆盖 `rc.1` 的 `next`，`rc.1` 仍可按精确版本安装）；`latest` 只有正式版才会移动。

## 手动等价流程（脚本不可用时）

```sh
# 1. 修改 package.json 的 version
pnpm build && pnpm typecheck && pnpm test
# 2. 提交 + 打新 tag + 推送
git add -A && git commit -m "chore: release vX"
git tag -a vX -m vX
git push origin main && git push origin vX
```
