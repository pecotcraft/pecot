.. _iface-common-pecot-workflow:

共通仕様
========

pecot-workflow は、Issue・PR・リリースの運用を管理するためのツールを提供する `MCP <https://modelcontextprotocol.io/>`__ サーバです。スキルとエージェントは、各ツールを MCP のツールとして呼びます。Actions だけが使う処理は、ツールでなく ``actions/`` の action です。

MCP サーバは、MCP プロトコルリビジョン `2026-07-28 <https://modelcontextprotocol.io/specification/2026-07-28>`__ と `2025-11-25 <https://modelcontextprotocol.io/specification/2025-11-25>`__ をサポートしています。`stdio <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>`__ サーバとして、マシン上でローカルプロセスとして実行されます。

引数
----

どのツールも、各ツールのページの引数に加えて、引数 ``repo`` を受けます。``owner/repo`` の形で、対象のリポジトリを渡します。省いたときの扱いは、各ツールのページの説明にあります。

使用例
------

各ツールのページの使用例は、`tools/call <https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools>`__ の要求の ``params`` のうち、``name`` と ``arguments`` だけを示します。2026-07-28 版の要求が必須とする ``_meta`` は省いています。

.. _iface-common-output-pecot-workflow:

出力
----

ツールの実行に失敗した場合や、警告がある場合に、実行結果に含まれる項目です。

.. iface-common-output:: pecot-workflow

ツールごとの項目とエラー名については、:doc:`ツール一覧 <pecot-workflow-tools>` の各ツールのページを参照してください。

機能要件
--------

.. iface-defs:: pecot-workflow common
