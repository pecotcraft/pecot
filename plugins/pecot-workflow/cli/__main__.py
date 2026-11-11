"""python -m pecot エントリーポイント"""

import signal
import sys

from cli.commands.main import app


def main() -> None:
    """メインエントリーポイント

    SIGPIPEを適切にハンドリングし、パイプ切断時に
    エラーメッセージを出さずに静かに終了する。
    """
    # SIGPIPEをデフォルト動作（プロセス終了）に戻す
    # Pythonはデフォルトでこれを無視するため、BrokenPipeErrorが発生する
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    try:
        app()
    except BrokenPipeError:
        # パイプ切断時は静かに終了
        # stdoutを閉じてから終了（追加のエラーを防ぐ）
        try:
            # Not output: cleanup after the pipe closed.
            sys.stdout.close()  # noqa: TID251
        except BrokenPipeError:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
