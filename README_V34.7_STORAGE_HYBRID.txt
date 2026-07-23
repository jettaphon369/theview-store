TheView Stock Build v34.7 — Storage Hybrid Phase 1

สิ่งที่เปลี่ยน
- รูปสินค้าใหม่/รูปที่เปลี่ยนใหม่ อัปโหลดไป Firebase Cloud Storage
- Firestore เก็บ URL + photoPath แทน Base64 ก้อนใหญ่
- รูปสินค้าเก่าที่เป็น Base64 ยังแสดงได้ตามเดิม (ไม่ย้าย/ไม่ลบอัตโนมัติ)
- เมื่อเปลี่ยนรูปใหม่ ระบบพยายามลบไฟล์ Storage เก่าหลังอัปโหลดใหม่สำเร็จ
- จำกัดไฟล์รูปใน Storage Rules ต่ำกว่า 1 MB และเฉพาะ image/*
- สิทธิ์อัปโหลด/ลบรูป: admin, manager, captain หรือผู้มี canManageProducts

ไฟล์ที่ต้องอัป GitHub
- app.js
- index.html
- service-worker.js
- firebase-config.js
- firestore.rules
- storage.rules (ไฟล์ใหม่)

สำคัญ: ต้อง Publish Storage Rules ใน Firebase Console > Storage > Rules
และ Publish firestore.rules เพราะเพิ่ม field photoPath

ทดสอบ
1) เปิดเว็บ ตรวจ build v34.7
2) เปิดสินค้าที่มีรูป Base64 เก่า -> รูปเดิมต้องยังแสดง
3) เปลี่ยนรูปสินค้า 1 รายการ -> ต้องอัปโหลดสำเร็จและรูปใหม่แสดง
4) Refresh หน้า -> รูปใหม่ยังแสดง
5) Firestore product document ควรมี photo เป็น https://... และ photoPath เป็น product-images/...
