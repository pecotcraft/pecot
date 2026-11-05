---
pecot-visual: patch
---

Slidev の lint が draw.io の XML からコメントを除く処理を、正規表現からループに替えた。閉じないコメントが続く XML でも、処理の時間が長さに比例して増えるだけになる。
