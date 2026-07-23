TheView Stock v34.10 — Large Export Guard

Changes:
- Report export queries only the selected day/month/date range instead of reading the full Logs collection.
- PDF generation is built in chunks to reduce Safari/mobile memory spikes.
- Large PDF warning thresholds: mobile >1,200 rows, desktop >2,500 rows.
- PDF hard guard at >5,000 rows; user is instructed to shorten the date range or use CSV.
- CSV large-export confirmation at >30,000 rows.
- Current-balance PDF uses the same chunked safety path.
- Preserves v34.9.1 Security Gate Hotfix, v34.8 product reads optimization, and Firebase Storage hybrid image flow.
