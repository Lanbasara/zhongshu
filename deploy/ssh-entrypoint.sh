#!/bin/sh
set -eu
exec /usr/local/libexec/zhongshu-release "${SSH_ORIGINAL_COMMAND:-}"
