"""tests/core/test_main_entry.py - __main__.py エントリーポイントのテスト

SIGPIPEハンドリングとBrokenPipeErrorの処理をテスト。
"""

from __future__ import annotations

import signal
import sys
from unittest.mock import MagicMock, patch

import pytest

from cli.__main__ import main


class TestMainEntry:
    """__main__.main() のテスト"""

    def test_main_calls_app(self) -> None:
        """main()がapp()を呼び出すことを確認"""
        with patch("cli.__main__.app") as mock_app:
            main()
            mock_app.assert_called_once()

    @pytest.mark.skipif(
        sys.platform == "win32",
        reason="SIGPIPEはUnix系のみ",
    )
    def test_sigpipe_handler_set(self) -> None:
        """SIGPIPEハンドラがSIG_DFLに設定されることを確認"""
        original_handler = signal.getsignal(signal.SIGPIPE)
        try:
            with patch("cli.__main__.app"):
                main()
            # main()実行後、SIGPIPEはSIG_DFLになっているはず
            assert signal.getsignal(signal.SIGPIPE) == signal.SIG_DFL
        finally:
            # テスト後にハンドラを復元
            signal.signal(signal.SIGPIPE, original_handler)

    def test_broken_pipe_error_handled(self) -> None:
        """BrokenPipeErrorが適切にハンドリングされることを確認"""
        with (
            patch("cli.__main__.app", side_effect=BrokenPipeError),
            patch("cli.__main__.sys.stdout") as mock_stdout,
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        # exit code 0 で終了
        assert exc_info.value.code == 0
        # stdoutをクローズしようとする
        mock_stdout.close.assert_called_once()

    def test_broken_pipe_error_on_stdout_close(self) -> None:
        """stdout.close()でBrokenPipeErrorが発生しても正常終了"""
        mock_stdout = MagicMock()
        mock_stdout.close.side_effect = BrokenPipeError

        with (
            patch("cli.__main__.app", side_effect=BrokenPipeError),
            patch("cli.__main__.sys.stdout", mock_stdout),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        # それでもexit code 0 で終了
        assert exc_info.value.code == 0
