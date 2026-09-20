#!/usr/bin/env bash
# data/images 配下のカメラ画像を、履歴を持たない専用ブランチ(既定: images)へ反映する。
#
# なぜ専用ブランチにするか:
#   画像をmainへコミットし続けると、保持期間を過ぎて削除しても過去コミットに画像の実体が残るため
#   .git が際限なく増える(2026-09-20実測: 約5週間でリポジトリ2.81GB、GitHubの上限は5GB)。
#   専用ブランチへ分け、コミットが一定数を超えたら履歴を畳む(orphanコミットへ作り直してforce-push)
#   ことで、常に「直近の保持期間ぶんの実体」だけを持つ状態に保てる。
#
# 使い方:
#   scripts/publish-images.sh <リモートURL> [画像ディレクトリ] [作業ディレクトリ] [ブランチ名]
# 環境変数:
#   SQUASH_AFTER_COMMITS … この数を超えたら履歴を畳む(既定72)
#   IMAGE_RETENTION_DAYS … ブランチ側に残す日数(既定2)。ファイル名の時刻で判定する
#   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL 等は呼び出し元の設定に従う
set -euo pipefail

REMOTE_URL="${1:?リモートURLを指定してください}"
SRC_DIR="${2:-data/images}"
WORK_DIR="${3:-.images-branch}"
BRANCH="${4:-images}"
SQUASH_AFTER_COMMITS="${SQUASH_AFTER_COMMITS:-72}"
IMAGE_RETENTION_DAYS="${IMAGE_RETENTION_DAYS:-2}"

if [ ! -d "$SRC_DIR" ]; then
  echo "publish-images: $SRC_DIR がないので何もしません"
  exit 0
fi

# 作業用の複製を用意する(既にあれば再利用。無ければ浅いクローン、ブランチが未作成なら新規作成)
if [ ! -d "$WORK_DIR/.git" ]; then
  rm -rf "$WORK_DIR"
  if git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE_URL" "$WORK_DIR" 2>/dev/null; then
    echo "publish-images: 既存の $BRANCH ブランチを取得しました"
  else
    echo "publish-images: $BRANCH ブランチが無いので新規作成します"
    mkdir -p "$WORK_DIR"
    git -C "$WORK_DIR" init --quiet -b "$BRANCH"
    git -C "$WORK_DIR" remote add origin "$REMOTE_URL"
  fi
fi

# 今回取得した画像を「追加」する(ブランチ側の既存画像は消さない)。
# 重要: GitHub Actionsの実行ごとに作業ディレクトリは作り直されるため、ローカルの data/images には
# 「その実行で取得した分」しか無い。ここで丸ごと同期してしまうと、前の実行までに貯めた画像が
# すべて消えてタイムラプスが成立しなくなる。そのため追加のみとし、古い分は下の保持期間で削除する。
# manifest.json はmain側に置く(ダッシュボードがmainから読むため)ので対象外。
if [ -d "$SRC_DIR" ]; then
  for entry in "$SRC_DIR"/*; do
    [ -d "$entry" ] || continue
    name="$(basename "$entry")"
    mkdir -p "$WORK_DIR/$name"
    cp -r "$entry"/. "$WORK_DIR/$name"/ 2>/dev/null || true
  done
fi

# 保持期間を過ぎた画像を削除する。ファイル名が "YYYYMMDDTHHMMSSZ.jpg"(UTC)なので、
# 文字列比較がそのまま時系列比較になる(cloneするとmtimeは当日になるため使えない)。
CUTOFF="$(date -u -d "-${IMAGE_RETENTION_DAYS} days" +%Y%m%dT%H%M%SZ 2>/dev/null || true)"
if [ -n "$CUTOFF" ]; then
  removed=0
  while IFS= read -r f; do
    b="$(basename "$f")"
    if [[ "$b" < "$CUTOFF" ]]; then rm -f "$f"; removed=$((removed + 1)); fi
  done < <(find "$WORK_DIR" -mindepth 2 -name '*.jpg' 2>/dev/null)
  [ "$removed" -gt 0 ] && echo "publish-images: 保持期間(${IMAGE_RETENTION_DAYS}日)を過ぎた画像を${removed}件削除しました"
  # 空になった拠点ディレクトリを片づける
  find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.git' -empty -exec rmdir {} + 2>/dev/null || true
fi

# コミット者の設定は複製先のリポジトリにも必要(mainリポジトリのローカル設定は引き継がれないため、
# これが無いと "fatal: empty ident name" でコミットに失敗する)
git -C "$WORK_DIR" config user.name "${GIT_USER_NAME:-github-actions[bot]}"
git -C "$WORK_DIR" config user.email "${GIT_USER_EMAIL:-github-actions[bot]@users.noreply.github.com}"

cd "$WORK_DIR"
git add -A
if git diff --cached --quiet; then
  echo "publish-images: 画像に変更はありません"
  exit 0
fi
git commit --quiet -m "画像更新: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

COMMITS="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
if [ "$COMMITS" -gt "$SQUASH_AFTER_COMMITS" ]; then
  # 履歴を畳む: いまの内容だけを持つ1コミットに作り直してforce-push
  echo "publish-images: コミットが${COMMITS}件になったので履歴を畳みます"
  git checkout --quiet --orphan __squashed
  git add -A
  git commit --quiet -m "画像スナップショット: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git branch -q -D "$BRANCH" 2>/dev/null || true
  git branch -q -m "$BRANCH"
  git push --quiet --force origin "$BRANCH"
else
  if ! git push --quiet origin "$BRANCH" 2>/dev/null; then
    # 他の実行とぶつかった場合などは、いまの内容で作り直して押し込む
    echo "publish-images: 通常のpushに失敗したため履歴を畳んで再送します"
    git checkout --quiet --orphan __squashed2
    git add -A
    git commit --quiet -m "画像スナップショット: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    git branch -q -D "$BRANCH" 2>/dev/null || true
    git branch -q -m "$BRANCH"
    git push --quiet --force origin "$BRANCH"
  fi
fi
echo "publish-images: $BRANCH ブランチへ反映しました"
