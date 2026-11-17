if [ -n "${FAKE_GH_FAIL:-}" ] && [[ "$*" == *"$FAKE_GH_FAIL"* ]]; then
    echo "HTTP 422: Reference does not exist" >&2
    exit 1
fi
[ "$1" = "api" ] || exit 0
shift
endpoint=""; method=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -X) method="$2"; shift 2 ;;
        -f|-F|-H) shift 2 ;;
        -*) shift ;;
        *) [ -z "$endpoint" ] && endpoint="$1"; shift ;;
    esac
done
[ -n "$method" ] && exit 0
f="$FAKE_GH_DIR/${endpoint//[^A-Za-z0-9]/_}"
[ -f "$f" ] || { echo "HTTP 404: Not Found ($endpoint)" >&2; exit 1; }
cat "$f"
