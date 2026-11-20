.. _iface-common-pecot-visual:

共通仕様
========

pecot-visual は、スライド・図・作業エビデンスを作成するためのツールを提供する `MCP <https://modelcontextprotocol.io/>`__ サーバです。 MCP プロトコルリビジョン `2026-07-28 <https://modelcontextprotocol.io/specification/2026-07-28>`__ と `2025-11-25 <https://modelcontextprotocol.io/specification/2025-11-25>`__ をサポートしています。`stdio <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>`__ サーバとして、マシン上でローカルプロセスとして実行されます。

使用例
------

各ツールのページの使用例は、`tools/call <https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools>`__ の要求の ``params`` のうち、``name`` と ``arguments`` だけを示します。2026-07-28 版の要求が必須とする ``_meta`` は省いています。

.. _iface-common-output-pecot-visual:

出力
----

ツールの実行に失敗した場合や、警告がある場合に、実行結果に含まれる項目です。

.. iface-common-output:: pecot-visual

ツールごとの項目とエラー名については、:doc:`ツール一覧 <pecot-visual-tools>` の各ツールのページを参照してください。

機能要件
--------

.. iface-defs:: pecot-visual common
