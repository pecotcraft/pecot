// 開発版の publish を飛ばすかを標準出力へ書く（true / false）。argv[2] = 今の dist-tag next の版（無ければ空）、argv[3] = run_number。
// re-run は run_number を変えないので、next がこの run 以上の開発版なら古い run とみなして飛ばす。
const [next = '', runNumber = ''] = process.argv.slice(2)

if (!/^[1-9]\d*$/.test(runNumber)) {
  console.error(`ERROR: run_number は 1 以上の整数で渡してください: ${runNumber}`)
  process.exit(1)
}

const match = /-dev\.(\d+)$/.exec(next.trim())
process.stdout.write(`${match !== null && Number(match[1]) >= Number(runNumber)}\n`)
