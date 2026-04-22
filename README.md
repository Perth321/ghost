# 👻 Ghost Bot

บอท Discord ผีหลอน — แกล้งคนในเซิร์ฟเวอร์ด้วยการเข้า-ออก voice channel เปิดเพลงน่ากลัว ๆ และส่งภาพผีตอนเที่ยงคืน/ตี 1

## พฤติกรรม

- ทุก 20 นาที: เข้าห้อง voice ที่มีคนอยู่ เปิดเพลงน่ากลัวสั้น ๆ แล้วออก
- ทุกเที่ยงคืน (00:00) และ ตี 1 (01:00): ส่งภาพผีในห้องแชต แล้วลบทิ้งหลัง 30 วินาที

## การติดตั้ง

```bash
pnpm install
export DISCORD_BOT_TOKEN=your_token
pnpm --filter @workspace/ghost-bot run start
```

## Permissions ที่บอทต้องมีบน Discord

- View Channels
- Send Messages
- Attach Files
- Manage Messages (เพื่อลบภาพที่ตัวเองส่ง)
- Connect, Speak (สำหรับ voice)

## Intents

ต้องเปิดที่ Discord Developer Portal:

- Server Members Intent
- (Voice States ใช้ได้โดยไม่ต้องเปิด privileged)
