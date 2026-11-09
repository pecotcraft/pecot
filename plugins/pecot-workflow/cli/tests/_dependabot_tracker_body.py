"""tests/_dependabot_tracker_body.py - 前の形（2 列）の dependabot Tracker の本文

#179 の本文をそのまま写したもの。core と CLI のテストが共有する。
"""

from __future__ import annotations

_PULL = "https://github.com/pecotcraft/pecot/pull"

OLD_FORM_BODY = (
    "<!-- pecot-dependabot-pr: tracker -->\n\n"
    "<!-- pecot-dependabot-pr: list-begin -->\n"
    "| PR | 待っている理由 |\n"
    "|---|---|\n"
    f"| <!-- pecot-dependabot-pr: pr/120 --> [#120]({_PULL}/120)"
    " `build(repo): bump ajv from 6.15.0 to 8.20.0` | major |\n"
    f"| <!-- pecot-dependabot-pr: pr/166 --> [#166]({_PULL}/166)"
    " `build(repo): bump jsdom from 29.1.1 to 31.0.0` | major |\n"
    "<!-- pecot-dependabot-pr: list-end -->"
)
