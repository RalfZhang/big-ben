#!/bin/sh
# 构建并重启容器。push 到 master 后 GitHub Actions 会 ssh 上来先 git pull 再跑它
# （git pull 写在 VPS 的 authorized_keys 里，见 deploy.md「更新」）。手动部署：git pull && ./deploy.sh
set -eu
cd "$(dirname "$0")"

docker compose build

# 整点前后几分钟不重启：旧容器停下要十来秒，新的起来还得先把各平台登一遍才挂上定时任务，
# 压在 :00 上那一轮报时就丢了（不补发）；:00 过后那一轮带着重试也可能跑上一两分钟
near_hour() {
  case $(TZ=Asia/Shanghai date +%M) in
    58|59|00|01|02) return 0 ;;
  esac
  return 1
}
if near_hour; then
  echo "整点附近，等过了 03 分再重启"
  while near_hour; do sleep 20; done
fi

docker compose up -d
# 每次构建都会把上一版镜像变成 <none>，不清就一直攒着
docker image prune -f

# 再盯 20 秒：新代码一启动就崩的话 restart 策略会反复拉起它，up -d 照样报成功。
# 这里不打容器日志 —— 仓库是公开的，Actions 日志谁都能看
before=$(docker inspect -f '{{.RestartCount}}' big-ben)
sleep 20
state=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' big-ben)
if [ "$state" != "running $before" ]; then
  echo "容器没跑稳（状态 重启次数：$state），上 VPS 看 docker compose logs big-ben" >&2
  exit 1
fi
