.. _iface-common-pecot-workflow:

共通仕様
========

pecot-workflow は、Issue・PR・リリースの運用を管理するためのツールを提供します。各ツールは、``pecot`` コマンドと `MCP <https://modelcontextprotocol.io/>`__ ツールの両方で実行できます。

MCP サーバは、MCP プロトコルリビジョン `2026-07-28 <https://modelcontextprotocol.io/specification/2026-07-28>`__ と `2025-11-25 <https://modelcontextprotocol.io/specification/2025-11-25>`__ をサポートしています。`stdio <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>`__ サーバとして、マシン上でローカルプロセスとして実行されます。

.. _iface-common-output-pecot-workflow:

出力
----

MCP ツール
~~~~~~~~~~

ツールの実行に失敗した場合や、警告がある場合に、実行結果に含まれる項目です。

.. iface-common-output:: pecot-workflow

コマンド
~~~~~~~~

失敗すると、標準エラーに ``error:`` で始まる行を出力し、0 以外の終了コードで終了します。警告は、``warning:`` で始まる行として標準エラーに出力します。

ツールごとの項目とエラー名、終了コードについては、:doc:`ツール一覧 <pecot-workflow-tools>` の各ツールのページを参照してください。

機能要件
--------

.. iface-defs:: pecot-workflow common
