if [ -n "${FAKE_GH_AUTH_FAIL:-}" ]; then
    echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2
    exit 1
fi
url=""; number=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -f|-F|-X|-H)
            case "$2" in number=*) number="${2#number=}" ;; esac
            shift 2; continue ;;
        -*|api) ;;
        *) url="$1" ;;
    esac
    shift
done
[ "$url" = "graphql" ] && url="graphql_$number"
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
