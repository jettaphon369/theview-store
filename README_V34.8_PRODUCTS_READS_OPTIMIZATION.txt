TheView Stock v34.8 — Products Reads Optimization

สิ่งที่เปลี่ยน
1) เพิ่ม IndexedDB cache สำหรับ Products บนอุปกรณ์
2) ครั้งแรก full sync Products 1 ครั้ง แล้วบันทึก cache
3) ครั้งถัดไปเปิดจาก cache และฟังเฉพาะสินค้าที่ updatedAt เปลี่ยนหลัง sync ล่าสุด
4) Full refresh อัตโนมัติอย่างน้อยทุก 24 ชั่วโมง เพื่อความถูกต้องและเก็บกวาด hard-delete จากอุปกรณ์อื่น
5) เพิ่ม updatedAt ให้ Archive / Unarchive / Trash / Restore เพื่อให้ incremental sync ตรวจพบทุกการเปลี่ยนแปลง
6) Hard delete จะลบสินค้าออกจาก local cache ทันทีบนอุปกรณ์ที่ทำรายการ
7) Firebase Storage Hybrid จาก v34.7 ยังคงทำงานเหมือนเดิม

ผลที่คาดหวัง
- อุปกรณ์ที่เคย sync แล้ว ไม่ต้องอ่าน Products ทั้ง collection ทุกครั้งที่เปิดเว็บ
- ลด Reads ซ้ำ โดยเฉพาะเมื่อจำนวนสินค้าเพิ่มมากขึ้น
- หน้า Dashboard / Search / Stock ยังใช้รายการสินค้าครบจาก cache จึงไม่ตัดฟังก์ชันด้วย limit แบบง่ายๆ

หมายเหตุ
- เปิดใช้งานครั้งแรกบนอุปกรณ์ใหม่ยังต้อง full sync 1 ครั้งตามปกติ
- ระบบบังคับ full refresh ทุก 24 ชั่วโมงเพื่อรักษาความถูกต้อง
