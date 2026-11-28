.. _iface-common-actions:

共通仕様
========

actions は、ワークフローの step が ``uses:`` で呼ぶ `JavaScript action <https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action>`__ です。``pecotcraft/pecot/actions/<処理>`` を、commit の SHA で固定して呼びます。``workflow_install`` が置く雛形は、SHA の後ろのコメントに版のタグ ``pecot-actions/v<版>`` を書きます。AI と無関係に動き、MCP のツールとしては呼べません。

入力
----

各 action のページの入力は、step の ``with:`` に渡します。どの action も、値を文字列として受けます。

使用例
------

各 action のページの使用例は、step の ``uses:`` と ``with:`` だけを示します。``uses:`` の ``<ref>`` には、雛形が固定する commit の SHA が入ります。

出力
----

action は、処理の結果を step のログに 1 行ずつ出します。失敗すると、``error:`` で始まる行を出し、step を失敗にします。警告は、``warning:`` で始まる行として出します。

後の step が読む値は、action の outputs に出します。outputs を持つ action のページに、その表があります。
