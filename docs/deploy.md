# DLX: התקנה בשרת (פיילוט)

זמן התקנה: בערך שעה. נבדק ב-17.10.2026: בניית התמונות, עליית כל השירותים, HTTPS, מיגרציות, גיבוי מוצפן, תרגול שחזור ובדיקת עשן (`scripts/smoke.mjs`).

## 1. מה צריך

| פריט | המלצה |
|---|---|
| שרת | VPS Linux עם 2 vCPU ו-4GB RAM, בישראל או באירופה (למשל AWS il-central-1, Azure Israel Central, Google me-west1, או ספק מקומי) |
| דומיין | תת-דומיין, למשל `pos.your-company.co.il`, עם רשומת A לכתובת השרת |
| תוכנה בשרת | Docker + Docker Compose |
| גיבוי חיצוני | דלי S3 / Blob / Drive, או כל אחסון מחוץ לשרת |

## 2. התקנה

```bash
git clone <repo> dlx && cd dlx/deploy
cp .env.example .env
# למלא את .env: הדומיין, וסיסמאות אקראיות (openssl rand -base64 32) לכל שדה
docker compose up -d --build
docker compose ps            # הכל Up, ו-api מסומן healthy
curl https://pos.your-company.co.il/health
node ../scripts/smoke.mjs https://pos.your-company.co.il   # בדיקת עשן: עסק בדיקה, מכירה, הדפסה
```

Caddy מנפיק תעודת HTTPS אוטומטית (Let's Encrypt). פורטים 80 ו-443 חייבים להיות פתוחים לאינטרנט.

## 3. אחרי ההתקנה

1. נכנסים לכתובת, לוחצים "עסק חדש", ופותחים את העסק של הלקוח (קוד עסק, ע.מ., סוג עוסק).
2. העסק נפתח **במצב פיילוט**: כל מסמך מודפס כ"פיילוט — לא מסמך רשמי".
3. ממשיכים לפי [pilot-playbook.md](pilot-playbook.md).

> עסק בדיקת העשן (`smoke-xxxxx`) נשאר במסד הנתונים. אפשר להשאיר אותו (הוא מבודד) או למחוק ידנית לפני העלייה לאוויר.

## 4. גיבוי ושחזור

- השירות `backup` מגבה כל 24 שעות ל-`deploy/backups`: `pg_dump` מוצפן ב-AES-256 עם `BACKUP_PASSPHRASE`, ונבדק מיד שהגיבוי ניתן לפענוח ולשחזור.
- **חובה להעתיק את הגיבויים גם מחוץ לשרת**, למשל עם cron:
  `rclone sync /srv/dlx/deploy/backups remote:dlx-backups`
- **ה-`BACKUP_PASSPHRASE` נשמרת במקום נפרד** (מנהל סיסמאות). בלעדיה אין שחזור.
- תרגול שחזור פעם בחודש, וגם לפני העלייה לאוויר:
  ```bash
  docker compose exec db sh   # או מכל מכונה עם psql
  PGPASSWORD=<owner> BACKUP_PASSPHRASE=<...> sh scripts/restore-drill.sh backups/<file>.dump.enc db 5432
  ```
  הסקריפט משחזר למסד נפרד (`dlx_restore_check`), מציג ספירות ובודק שאין חורים במספור המסמכים.

> לפיילוט, גיבוי יומי + העתקה החוצה מספיקים (RPO של 24 שעות). להשגת RPO של 15 דקות (`docs/operations.md`) עוברים ל-Postgres מנוהל עם PITR: מגדירים `DATABASE_URL` / `DATABASE_OWNER_URL` חיצוניים, ומוותרים על השירות `db`.

## 5. עדכון גרסה

```bash
cd dlx && git pull
cd deploy && docker compose up -d --build   # migrate רץ לפני api; מיגרציה שנכשלת — api לא עולה
```

לפני כל עדכון: גיבוי ידני (`docker compose run --rm backup` או המתנה לגיבוי הלילי). אחרי העדכון: בדיקת עשן.

## 6. ניטור והתראות

- `ERROR_WEBHOOK_URL` ב-`.env`: כל שגיאת שרת נשלחת ל-Slack / Teams.
- בדיקת זמינות חיצונית על `/health` (UptimeRobot או דומה), עם התראה לטלפון.
- פעם ביום: "חריגים" במסך הדוחות, ו"בדיקת שרשרת" ביומן הביקורת.

## 7. אבטחה

- בייצור השרת **לא מריץ** ספקי דמה (`PAYMENT_PROVIDER` ו-`ALLOCATION_PROVIDER` = `none`). אשראי עובר רק דרך "מסוף חיצוני", עם מספר אישור.
- כל עוד `DLX_SOFTWARE_REGISTRATION` ריק, אי אפשר לעבור למסמכים רשמיים.
- אסור לשמור את `.env` ב-git. הגישה לשרת רק ב-SSH עם מפתח.
- עדכוני אבטחה למערכת ההפעלה: `unattended-upgrades`.
