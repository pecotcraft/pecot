---
pecot-workflow: minor
---

計画の承認の後の案内を、w-active・w-quick を起動したセッションにだけ出すようにしました。
GitHub Copilot CLI では、この案内を出しません。`.pecot/state/.pecot-quick-mode` は作らなくなり、古いものが残っていても読みません。
