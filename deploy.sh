#!/bin/bash
# deploy.sh —— 一键把「GitHub 下载加速」Loon 插件发布到 GitHub，并输出导入地址
#
# 前置：gh CLI 已登录（gh auth status 正常）
# 用法：bash deploy.sh
#
# 关键设计：script-path 固定到不可变 commit SHA，而不是 main。
#   raw.githubusercontent.com / jsDelivr 对 main 分支有 CDN 缓存，
#   用 main 会出现「脚本改了但 Loon 还在跑旧版」的静默问题。
#   改完 JS 直接重跑本脚本即可，它会自动把旧 SHA 还原成占位符再重新固定。
set -euo pipefail

REPO="github-accel-loon"
PLUGIN="github-accel.plugin"
BRANCH="main"
DESC="Loon 插件：自动从 github.akams.cn 择优 GitHub 加速节点，改写 Releases / Archive / Raw / Codeload 下载链接"

# ---- 0. 环境检查 ----
command -v gh >/dev/null 2>&1 || { echo "✗ 未找到 gh CLI，请先安装： brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ gh 未登录，请先执行： gh auth login"; exit 1; }
gh auth setup-git >/dev/null 2>&1 || true

USER=$(gh api user --jq .login)
ID=$(gh api user --jq .id)
echo "[*] 当前账号：$USER"

[ -f "$PLUGIN" ] || { echo "✗ 当前目录找不到 $PLUGIN"; exit 1; }

# ---- 1. 把已固定的 SHA 还原成占位符（保证反复重跑结果正确）----
# 注意：不用 sed -i / perl -i —— 它们靠「临时文件 + rename」实现，
#       在部分环境（含本机 IDE 的文件代理）会被拦截；这里一律用「截断重写」。
if grep -q '__SHA__' "$PLUGIN"; then
  echo "[*] 插件中已是占位符 __SHA__"
else
  _restored=$(sed -E 's#(raw\.githubusercontent\.com/[^/]+/[^/]+/)[0-9a-f]{7,40}(/)#\1__SHA__\2#g' "$PLUGIN")
  printf '%s\n' "$_restored" > "$PLUGIN"
  echo "[*] 已把旧的固定 SHA 还原成 __SHA__"
fi

# ---- 2. 初始化仓库与身份 ----
if [ ! -d .git ]; then
  git init -q -b "$BRANCH" 2>/dev/null || { git init -q; git symbolic-ref HEAD "refs/heads/$BRANCH"; }
  echo "[*] 已初始化 git 仓库 (分支 ${BRANCH})"
fi
git config user.name "$USER"
git config user.email "${ID}+${USER}@users.noreply.github.com"

# ---- 3. 第一次提交：脚本本体（这次提交的 SHA 就是固定点）----
git add -A
if ! git diff --cached --quiet; then
  git commit -qm "scripts: GitHub 加速节点测速 + 下载链接改写"
else
  echo "[*] 脚本无变更"
fi
SHA=$(git rev-parse HEAD)
echo "[*] 固定脚本版本 SHA = $SHA"

# ---- 4. 用不可变 SHA 渲染插件 ----
_rendered=$(sed "s/__SHA__/$SHA/g" "$PLUGIN")
printf '%s\n' "$_rendered" > "$PLUGIN"
git add "$PLUGIN"
if ! git diff --cached --quiet; then
  git commit -qm "plugin: pin script-path -> $SHA"
else
  echo "[*] 插件无变更"
fi

# ---- 5. 建仓并推送 ----
if gh repo view "$USER/$REPO" >/dev/null 2>&1; then
  echo "[*] 仓库 $USER/$REPO 已存在"
else
  echo "[*] 创建公开仓库 $USER/$REPO ..."
  gh repo create "$REPO" --public --description "$DESC" 2>&1 | tail -3
fi

git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$USER/$REPO.git"
echo "[*] 推送 $BRANCH ..."
git push -u origin "$BRANCH" 2>&1 | tail -5

gh repo edit "$USER/$REPO" \
  --add-topic loon --add-topic loon-plugin --add-topic github-accelerator >/dev/null 2>&1 || true

PLUGIN_URL="https://raw.githubusercontent.com/$USER/$REPO/$BRANCH/$PLUGIN"
echo ""
echo "==================== 发布完成 ===================="
echo "仓库：      https://github.com/$USER/$REPO"
echo "Loon 导入： $PLUGIN_URL"
echo "脚本固定于： $SHA"
echo ""
echo "下一步：Loon → 配置 → 插件 → + → 粘贴上面的导入地址"
echo "        然后在「脚本」页手动运行一次「GitHub加速节点测速」"
echo "=================================================="
