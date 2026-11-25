# Pass display language across Docker without changing the locale used by tools.
case "${ACHBIT_DEV_LANGUAGE:-${LC_ALL:-${LC_MESSAGES:-${LANG:-C}}}}" in
  [zZ][hH]|[zZ][hH][_.@-]*) ACHBIT_DEV_LANGUAGE=zh-CN ;;
  *) ACHBIT_DEV_LANGUAGE=en-US ;;
esac
export ACHBIT_DEV_LANGUAGE

dev_printf() {
  local format="$1"
  if [ "$ACHBIT_DEV_LANGUAGE" = zh-CN ]; then format="$2"; fi
  shift 2
  printf "$format" "$@"
}
