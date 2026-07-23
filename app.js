import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence, updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, addDoc, serverTimestamp, query, where, orderBy, limit, startAfter, getDocs, getDoc, writeBatch, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadString, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';

const APP_ENV='TEST';
const EXPECTED_FIREBASE_PROJECT='wjb-story';
if(firebaseConfig.projectId!==EXPECTED_FIREBASE_PROJECT){
  document.documentElement.innerHTML=`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Environment blocked</title></head><body style="font-family:system-ui;padding:24px;background:#fff7f7;color:#7f1d1d"><h2>⛔ บล็อกการเชื่อมต่อ Firebase ผิดระบบ</h2><p>เว็บนี้เป็น <b>${APP_ENV}</b> แต่ firebaseConfig ชี้ไป <code>${firebaseConfig.projectId||'-'}</code></p><p>ระบบหยุดก่อนอ่านหรือเขียนข้อมูลเพื่อป้องกันข้อมูล TEST/Production ปะปนกัน</p></body>`;
  throw new Error(`[TheView Stock] Firebase project mismatch: expected ${EXPECTED_FIREBASE_PROJECT}, got ${firebaseConfig.projectId}`);
}
const STORAGE_NAMESPACE=`theview:${EXPECTED_FIREBASE_PROJECT}`;
const storageKey=(name)=>`${STORAGE_NAMESPACE}:${name}`;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = getFirestore(app);
const storage = getStorage(app);
setPersistence(auth, browserLocalPersistence).catch(()=>{});

// ---------- ระบบ Username ภายในทีม ----------
const USERNAME_DOMAIN='theview.local';
const DEFAULT_PASSWORD='chartered';
function normalizeUsername(v=''){ return String(v).trim().toLowerCase().replace(/\s+/g,''); }
function usernameToEmail(v){ return `${normalizeUsername(v)}@${USERNAME_DOMAIN}`; }

const BUILD_VERSION='34.12.3-TEST';
window.__THEVIEW_BUILD__=BUILD_VERSION;
const $ = (id)=>document.getElementById(id);
window.$ = window.$ || $;

// ---------- Resilient product image loading ----------
function productImageMarkup(url='', alt='', extraClass=''){
  if(!url) return `<div class="stock-card-photo-placeholder">📦</div>`;
  const safeUrl=String(url).replace(/"/g,'&quot;');
  const safeAlt=escapeHtml(alt||'รูปสินค้า');
  return `<div class="image-loader-shell"><div class="image-loader-placeholder" aria-hidden="true"><span>📦</span></div><img class="resilient-product-img ${extraClass}" src="${safeUrl}" alt="${safeAlt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="window.productImageLoaded(this)" onerror="window.productImageFailed(this)"></div>`;
}
window.productImageLoaded=(img)=>{
  const shell=img?.closest?.('.image-loader-shell');
  if(!shell) return;
  shell.classList.add('is-loaded');
  shell.classList.remove('is-error','is-retrying');
};
window.productImageFailed=(img)=>{
  const shell=img?.closest?.('.image-loader-shell');
  if(!shell) return;
  const attempt=Number(img.dataset.retryAttempt||0);
  if(attempt<2 && navigator.onLine){
    img.dataset.retryAttempt=String(attempt+1);
    shell.classList.add('is-retrying');
    const base=(img.dataset.originalSrc||img.currentSrc||img.src||'').split('#')[0];
    img.dataset.originalSrc=base;
    setTimeout(()=>{ img.src=base+(base.includes('?')?'&':'?')+'retry='+Date.now(); }, 700*(attempt+1));
    return;
  }
  shell.classList.remove('is-retrying');
  shell.classList.add('is-error');
};

// ---------- Action safety / duplicate-submit guard ----------
const actionLocks=new Set();
function beginActionLock(key, buttonId, busyText='กำลังดำเนินการ...'){
  if(actionLocks.has(key)) return false;
  actionLocks.add(key);
  const btn=buttonId?document.getElementById(buttonId):null;
  if(btn){
    btn.dataset.originalText=btn.innerHTML;
    btn.disabled=true;
    btn.setAttribute('aria-busy','true');
    btn.innerHTML=`⏳ ${busyText}`;
  }
  return true;
}
function endActionLock(key, buttonId){
  actionLocks.delete(key);
  const btn=buttonId?document.getElementById(buttonId):null;
  if(btn){
    btn.disabled=false;
    btn.removeAttribute('aria-busy');
    if(btn.dataset.originalText){ btn.innerHTML=btn.dataset.originalText; delete btn.dataset.originalText; }
  }
}
function normalizeSkuKey(v=''){
  return String(v).trim().toUpperCase().replace(/\s+/g,'');
}
function skuRegistryDocRef(sku){
  const key=normalizeSkuKey(sku);
  const safe=encodeURIComponent(key).replace(/%/g,'_');
  return doc(fs,'theviewWorkspaces','main','skuRegistry',safe || '__EMPTY__');
}

// ---------- Product image storage (Hybrid: URL ใหม่ + Base64 เดิมยังรองรับ) ----------
function isStorageUrl(value=''){
  return /^https:\/\/(firebasestorage\.googleapis\.com|storage\.googleapis\.com)\//i.test(String(value||''));
}
async function uploadProductImage(productId, dataUrl, previousPath=''){
  if(!productId || !dataUrl) throw new Error('ข้อมูลรูปสินค้าไม่ครบ');
  const path=`product-images/${productId}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.jpg`;
  const ref=storageRef(storage,path);
  await uploadString(ref,dataUrl,'data_url',{contentType:'image/jpeg',cacheControl:'public,max-age=31536000,immutable'});
  const url=await getDownloadURL(ref);
  if(previousPath){
    deleteObject(storageRef(storage,previousPath)).catch(err=>console.warn('ลบรูปสินค้าเก่าไม่สำเร็จ',err));
  }
  return {url,path};
}

function hasDuplicateSkuLocal(sku, excludeId=''){
  const key=normalizeSkuKey(sku);
  if(!key) return false;
  return state.products.some(p=>p.id!==excludeId && normalizeSkuKey(p.sku||'')===key);
}

function setSkuFieldError(message=''){
  const input=$('ps'), box=$('skuInlineError');
  if(box){
    box.textContent=message;
    box.classList.toggle('hidden',!message);
  }
  if(input){
    input.setAttribute('aria-invalid',message?'true':'false');
    input.style.borderColor=message?'#dc2626':'';
    input.style.boxShadow=message?'0 0 0 3px rgba(220,38,38,.12)':'';
    if(message){
      try{ input.scrollIntoView({behavior:'smooth',block:'center'}); }catch(_){ }
      setTimeout(()=>input.focus({preventScroll:true}),80);
    }
  }
}
window.validateSkuField=(excludeId='')=>{
  const sku=($('ps')?.value||'').trim();
  const duplicate=!!sku && hasDuplicateSkuLocal(sku,excludeId);
  setSkuFieldError(duplicate?`รหัสสินค้า (SKU) "${sku}" ถูกใช้งานแล้ว กรุณาใช้รหัสอื่น`: '');
  return !duplicate;
};
function isSkuDuplicateError(err){
  return /SKU\s*ซ้ำ|รหัสสินค้า.*ซ้ำ|ใช้รหัสนี้แล้ว/i.test(String(err?.message||err||''));
}
function showSkuDuplicateError(sku,err){
  const msg=`ไม่สามารถบันทึกได้ — รหัสสินค้า (SKU) "${sku||'-'}" ถูกใช้งานแล้ว กรุณาใช้รหัสอื่น`;
  setSkuFieldError(msg);
  toast(msg);
  return msg;
}


// ตรวจสอบว่า HTML / CSS / JavaScript เป็นชุดเวอร์ชันเดียวกัน
(function verifyBuildConsistency(){
  const htmlBuild=document.documentElement.dataset.build||'';
  if(htmlBuild && htmlBuild!==BUILD_VERSION){
    console.warn(`[TheView Stock] build mismatch: HTML ${htmlBuild}, JS ${BUILD_VERSION}`);
    try{
      const key=storageKey('build-reload');
      if(sessionStorage.getItem(key)!==BUILD_VERSION){
        sessionStorage.setItem(key,BUILD_VERSION);
        const url=new URL(location.href);
        url.searchParams.set('v',BUILD_VERSION);
        location.replace(url.toString());
      }
    }catch(_){ }
  }
})();
const LAST_PAGE_KEY=storageKey('lastPage');
const LAST_SCROLL_KEY=storageKey('lastScroll');
const LAST_SCROLL_MAP_KEY=storageKey('scrollByPage');
const NEW_ITEM_DRAFT_KEY=storageKey('newItemDraft');
const UI_STATE_KEY=storageKey('uiState');
const PRODUCT_DETAIL_KEY=storageKey('productDetail');
const VALID_PAGES=new Set(['home','stock','scan','approval','report','history','profile','productDetail']);
const savedPage=localStorage.getItem(LAST_PAGE_KEY);
const state = { user:null, profile:null, members:[], page:VALID_PAGES.has(savedPage)?savedPage:'home', products:[], approvals:[], logs:[], auditLogs:[], selectedImage:null, imageMode:null, viewProductId:localStorage.getItem(PRODUCT_DETAIL_KEY)||null, productDetailTab:'general', tempMoveImage:null, tempProductImage:null, stockFilter:'all', stockSearch:'', stockSort:'name-asc', stockCategory:'all', balanceCategory:'all', reportMode:'day', reportFilter:'all', reportDate:'', reportMonth:'', reportStart:'', reportEnd:'', historySearch:'', historyFilter:'all', historyStart:toDateStr(new Date()), historyEnd:toDateStr(new Date()) };
try{
  const savedUi=JSON.parse(localStorage.getItem(UI_STATE_KEY)||'{}');
  ['stockFilter','stockSort','stockCategory','balanceCategory','reportMode','reportFilter','reportDate','reportMonth','reportStart','reportEnd','historySearch','historyFilter','historyStart','historyEnd','newItemType','productDetailTab'].forEach(k=>{ if(savedUi[k]!==undefined) state[k]=savedUi[k]; });
}catch(_){ }
function saveUiState(){
  const keys=['stockFilter','stockSort','stockCategory','balanceCategory','reportMode','reportFilter','reportDate','reportMonth','reportStart','reportEnd','historySearch','historyFilter','historyStart','historyEnd','newItemType','productDetailTab'];
  const data={}; keys.forEach(k=>data[k]=state[k]);
  localStorage.setItem(UI_STATE_KEY,JSON.stringify(data));
}

const view = $('view');
let newItemDraftPromptChecked=false;
let restoringNewItemDraft=false;

// ---------- ปุ่มแสดง/ซ่อนรหัสผ่าน ----------
function ensurePasswordEyeStyles(){
  if(document.getElementById('theviewPasswordEyeStyles')) return;
  const style=document.createElement('style');
  style.id='theviewPasswordEyeStyles';
  style.textContent=`
    .password-eye-wrap{position:relative;width:100%}
    .password-eye-wrap>input{width:100%;padding-right:58px!important;box-sizing:border-box}
    .password-eye-btn{
      position:absolute;right:10px;top:50%;transform:translateY(-50%);
      border:0!important;background:transparent!important;box-shadow:none!important;
      width:42px;height:42px;padding:0!important;margin:0!important;
      display:flex;align-items:center;justify-content:center;
      font-size:22px;line-height:1;cursor:pointer;z-index:5;color:#334155;
      -webkit-tap-highlight-color:transparent;
    }
    .password-eye-btn:focus{
      outline:2px solid #93c5fd;outline-offset:1px;border-radius:10px
    }
  `;
  document.head.appendChild(style);
}

window.togglePasswordVisibility=(inputId,button)=>{
  const input=document.getElementById(inputId);
  if(!input) return;
  const show=input.type==='password';
  input.type=show?'text':'password';
  if(button){
    button.textContent=show?'🙈':'👁️';
    button.setAttribute('aria-label',show?'ซ่อนรหัสผ่าน':'แสดงรหัสผ่าน');
    button.setAttribute('title',show?'ซ่อนรหัสผ่าน':'แสดงรหัสผ่าน');
  }
};

function attachPasswordEye(input){
  if(!input || input.dataset.passwordEyeReady==='1') return;
  if(!input.id) input.id=`password_${Math.random().toString(36).slice(2)}`;
  input.dataset.passwordEyeReady='1';

  const parent=input.parentElement;
  if(!parent) return;

  const wrap=document.createElement('div');
  wrap.className='password-eye-wrap';
  parent.insertBefore(wrap,input);
  wrap.appendChild(input);

  const btn=document.createElement('button');
  btn.type='button';
  btn.className='password-eye-btn';
  btn.textContent='👁️';
  btn.setAttribute('aria-label','แสดงรหัสผ่าน');
  btn.setAttribute('title','แสดงรหัสผ่าน');
  btn.addEventListener('click',()=>window.togglePasswordVisibility(input.id,btn));
  wrap.appendChild(btn);
}

function refreshPasswordEyes(root=document){
  ensurePasswordEyeStyles();
  const inputs=[];
  if(root instanceof HTMLInputElement && root.type==='password') inputs.push(root);
  if(root.querySelectorAll) inputs.push(...root.querySelectorAll('input[type="password"]'));
  inputs.forEach(attachPasswordEye);
}

ensurePasswordEyeStyles();
document.addEventListener('DOMContentLoaded',()=>refreshPasswordEyes());
const passwordEyeObserver=new MutationObserver(mutations=>{
  for(const mutation of mutations){
    for(const node of mutation.addedNodes){
      if(node.nodeType===1) refreshPasswordEyes(node);
    }
  }
});
passwordEyeObserver.observe(document.documentElement,{childList:true,subtree:true});
requestAnimationFrame(()=>refreshPasswordEyes());


function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1800); }
function userPath(name){ return collection(fs,'theviewWorkspaces','main',name); }
function productRef(id){ return doc(fs,'theviewWorkspaces','main','products',id); }
function approvalRef(id){ return doc(fs,'theviewWorkspaces','main','approvals',id); }
function logDocRef(id){ return doc(fs,'theviewWorkspaces','main','logs',id); }
function logRef(){ return collection(fs,'theviewWorkspaces','main','logs'); }
function auditRef(){ return collection(fs,'theviewWorkspaces','main','auditLogs'); }
function memberRef(uid=state.user?.uid){ return doc(fs,'members',uid); }
function role(){ return state.profile?.role || 'staff'; }
function isAdmin(){ return role()==='admin'; }
function isManagerRole(){ return role()==='manager' || isAdmin(); }
function isCaptain(){ return role()==='captain'; }
function hasPermission(name){ return state.profile?.permissions?.[name] === true; }
function canManageProducts(){ return isAdmin() || isManagerRole() || isCaptain() || hasPermission('canManageProducts'); }
function canAdjustStock(){ return isAdmin() || isManagerRole() || isCaptain() || hasPermission('canAdjustStock'); }
function canViewReports(){ return isAdmin() || isManagerRole() || isCaptain() || hasPermission('canViewReports'); }
function canApprove(){ return isAdmin() || isManagerRole() || isCaptain() || hasPermission('canApprove'); }
// คงชื่อ isManager ไว้เพื่อไม่ให้โค้ดเดิมเสีย: หมายถึงผู้ที่จัดการสินค้าได้
function isManager(){ return canManageProducts(); }
function canAssignApprovers(){ return isAdmin() || isManagerRole() || isCaptain(); }
function requireManager(){ if(!canManageProducts()){ toast('เฉพาะกัปตัน/ธุรการ ผู้จัดการ หรือแอดมินเท่านั้น'); return false; } return true; }
function requireApprover(){ if(!canApprove()){ toast('คุณไม่ได้รับสิทธิ์ตรวจสอบและอนุมัติ'); return false; } return true; }
function isOwnApproval(item){ return !!item && item.submittedByUid===state.user?.uid; }
function canEditPendingApproval(item){ return canApprove() || isOwnApproval(item); }
function requirePendingOwnerOrApprover(item){
  if(!canEditPendingApproval(item)){
    toast('คุณแก้ไขได้เฉพาะรายการของตัวเอง');
    return false;
  }
  return true;
}
function requireAdmin(){ if(!isAdmin()){ toast('เฉพาะ Admin เท่านั้น'); return false; } return true; }
function escapeHtml(s=''){ return String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function makeEventId(prefix='EVT'){
  const d=new Date();
  const stamp=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'),String(d.getHours()).padStart(2,'0'),String(d.getMinutes()).padStart(2,'0'),String(d.getSeconds()).padStart(2,'0')].join('');
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}
function actorSnapshot(){
  return {actorUid:state.user?.uid||'',actorName:state.profile?.displayName||state.profile?.username||'ไม่ทราบผู้ใช้',actorRole:role()};
}
function logPayload(action,detail,extra={}){
  return {action,detail,time:new Date().toLocaleString('th-TH'),createdAt:serverTimestamp(),...actorSnapshot(),...extra};
}
function auditPayload(action,detail,extra={}){
  return {action,detail,createdAt:serverTimestamp(),immutable:true,...actorSnapshot(),...extra};
}
async function addAudit(action,detail,extra={}){
  return addDoc(auditRef(),auditPayload(action,detail,extra));
}
async function addLog(action,detail,extra={}){
  const eventId=extra.eventId||makeEventId();
  const logDoc=doc(logRef()),auditDoc=doc(auditRef());
  const batch=writeBatch(fs);
  batch.set(logDoc,logPayload(action,detail,{...extra,eventId}));
  batch.set(auditDoc,auditPayload(action,detail,{...extra,eventId,logId:logDoc.id}));
  await batch.commit();
  return logDoc;
}

// ---------- สถานที่เบิก/รับ ----------
const STORE_LOCATION = 'Store FB';
const LOCATION_OPTIONS = ['TheView','Kiosk6','Kiosk15','InOut','DV','อื่นๆ'];
function locationFieldHtml(selectId, otherId){
  return `<select id="${selectId}" onchange="window.toggleLocationOther('${selectId}','${otherId}')">
    <option value="">เลือกสถานที่</option>
    ${LOCATION_OPTIONS.map(o=>`<option value="${o}">${o}</option>`).join('')}
  </select>
  <input id="${otherId}" placeholder="ระบุสถานที่" class="hidden">`;
}
window.toggleLocationOther=(selectId,otherId)=>{
  const sel=$(selectId), other=$(otherId);
  if(!sel||!other) return;
  if(sel.value==='อื่นๆ'){ other.classList.remove('hidden'); other.focus(); }
  else { other.classList.add('hidden'); other.value=''; }
};
function getLocationValue(selectId,otherId){
  const sel=$(selectId);
  if(!sel) return '';
  if(sel.value==='อื่นๆ') return ($(otherId).value||'').trim();
  return sel.value||'';
}

// ---------- แสดงผล badge ของ log แยกทิศทาง รับ/เบิก ให้ชัดเจน ----------
const MOVE_TYPE_LABEL = {in:'รับเข้า', out:'เบิกออก'};
function logPillInfo(l){
  let label = l.action, cls = '';
  if(l.action==='เบิกออก'){ cls='warn'; label='↑ เบิกออก'; }
  else if(l.action==='รับเข้า'){ cls='ok'; label='↓ รับเข้า'; }
  else if(l.action==='อนุมัติ'){
    cls = l.moveType==='out' ? 'warn' : (l.moveType==='in' ? 'ok' : 'ok');
    label = `✅ อนุมัติ${l.moveType?` • ${l.moveType==='out'?'↑ เบิกออก':'↓ รับเข้า'}`:''}`;
  } else if(l.action==='ปฏิเสธ'){
    cls = 'bad';
    label = `✕ ปฏิเสธ${l.moveType?` • ${l.moveType==='out'?'↑ เบิกออก':'↓ รับเข้า'}`:''}`;
  } else if(l.action==='ส่งตรวจ'){
    cls = '';
    label = `⏳ ส่งตรวจ${l.moveType?` • ${l.moveType==='out'?'↑ เบิกออก':'↓ รับเข้า'}`:''}`;
  } else if(isAdjustmentLog(l)){
    cls = '';
    label = '⚖️ ปรับยอดสินค้า';
  } else if(l.action==='ยกเลิก'){
    cls = 'bad';
    label = `↩ ยกเลิก${l.moveType?` • ${l.moveType==='out'?'↑ เบิกออก':'↓ รับเข้า'}`:''}`;
  }
  return { label, cls };
}

// ---------- รายงานยอดเบิกแยกตามสถานที่ (รายวัน/รายเดือน) ----------
function pad2(n){ return String(n).padStart(2,'0'); }
function toDateStr(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function toMonthStr(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`; }
function shiftDateStr(str,delta){ const [y,m,d]=str.split('-').map(Number); const dt=new Date(y,m-1,d); dt.setDate(dt.getDate()+delta); return toDateStr(dt); }
function shiftMonthStr(str,delta){ const [y,m]=str.split('-').map(Number); const dt=new Date(y,m-1,1); dt.setMonth(dt.getMonth()+delta); return toMonthStr(dt); }

// ---------- Date utilities (v32 Stable) ----------
// Parse YYYY-MM-DD as local time, not UTC. Returns null for invalid input.
function parseLocalDate(value){
  if(value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  const text=String(value||'').trim();
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if(!match) return null;
  const y=Number(match[1]), m=Number(match[2]), d=Number(match[3]);
  const date=new Date(y,m-1,d,0,0,0,0);
  if(date.getFullYear()!==y || date.getMonth()!==m-1 || date.getDate()!==d) return null;
  return date;
}
function isSameLocalDay(a,b){
  const da=a instanceof Date?a:parseLocalDate(a);
  const db=b instanceof Date?b:parseLocalDate(b);
  return !!da && !!db && da.getFullYear()===db.getFullYear() && da.getMonth()===db.getMonth() && da.getDate()===db.getDate();
}
function isDateInLocalRange(value,start,end){
  const date=value instanceof Date?value:parseLocalDate(value);
  const from=start instanceof Date?start:parseLocalDate(start);
  const to=end instanceof Date?end:parseLocalDate(end);
  if(!date||!from||!to) return false;
  const time=new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime();
  const min=Math.min(from.getTime(),to.getTime());
  const max=Math.max(from.getTime(),to.getTime());
  return time>=min && time<=max;
}
function getLogDate(l){
  if(l.createdAt && typeof l.createdAt.toDate==='function') return l.createdAt.toDate();
  if(l.createdAt && typeof l.createdAt.seconds==='number') return new Date(l.createdAt.seconds*1000);
  return null;
}
// Compatibility helper for report export and older cached code.
function normalizeLogDate(log){ return getLogDate(log); }

// นับเฉพาะ Log ที่ทำให้สต๊อกเปลี่ยนจริง
function isWithdrawLog(l){
  return l.action==='เบิกออก' || (l.action==='อนุมัติ' && l.moveType==='out');
}
function isReceiveLog(l){
  return l.action==='รับเข้า' || (l.action==='อนุมัติ' && l.moveType==='in');
}
function isStockMovementLog(l){ return isWithdrawLog(l) || isReceiveLog(l); }


// ---------- Realtime listeners: ยกเลิกของเดิมก่อนผูกใหม่เสมอ กันปัญหา listener ค้าง/ซ้อนข้ามบัญชี ----------
let unsubProducts=null, unsubApprovals=null, unsubLogs=null, unsubAudit=null;
let productsSnapshotReady=false;
const LOG_PAGE_SIZE=400;
const AUDIT_REALTIME_LIMIT=200;
let logsCursor=null;
let logsHasMore=true;
let logsLoadingMore=false;
let __lastLoadError=null;
function humanizeAppError(error){
  const code=String(error?.code||'').toLowerCase();
  const msg=String(error?.message||'').toLowerCase();
  const offline=(navigator.onLine===false)||code.includes('unavailable')||msg.includes('client is offline')||msg.includes('network');
  if(offline){
    return {
      icon:'📡',
      title:'ไม่มีการเชื่อมต่ออินเทอร์เน็ต',
      detail:'ไม่สามารถโหลดข้อมูลล่าสุดได้ในขณะนี้ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วกด “ลองใหม่”',
      kind:'offline'
    };
  }
  if(code.includes('permission-denied')){
    return {
      icon:'🔒',
      title:'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้',
      detail:'บัญชีของคุณไม่มีสิทธิ์สำหรับข้อมูลส่วนนี้ หรือสิทธิ์ยังไม่อัปเดต กรุณาติดต่อผู้ดูแลระบบ',
      kind:'permission'
    };
  }
  if(code.includes('unauthenticated')){
    return {
      icon:'🔐',
      title:'เซสชันหมดอายุ',
      detail:'กรุณาเข้าสู่ระบบใหม่เพื่อดำเนินการต่อ',
      kind:'auth'
    };
  }
  if(code.includes('deadline-exceeded')||code.includes('resource-exhausted')){
    return {
      icon:'⏳',
      title:'ระบบตอบสนองช้ากว่าปกติ',
      detail:'คำขอใช้เวลานานหรือมีการใช้งานจำนวนมาก กรุณารอสักครู่แล้วลองใหม่',
      kind:'retry'
    };
  }
  return {
    icon:'⚠️',
    title:title||'เกิดข้อผิดพลาด',
    detail:'ระบบไม่สามารถทำรายการนี้ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง หากยังเกิดซ้ำให้แจ้งผู้ดูแลระบบ',
    kind:'error'
  };
}
function retryLastLoad(){
  if(navigator.onLine===false){
    toast('ยังออฟไลน์อยู่ กรุณาเชื่อมต่ออินเทอร์เน็ตก่อน');
    updateNetworkStatusIndicator(false);
    return;
  }
  const btn=document.getElementById('appRetryButton');
  if(btn){ btn.disabled=true; btn.textContent='⏳ กำลังลองใหม่...'; }
  setTimeout(()=>{
    try{
      if(state?.user){
        bindRealtime();
        render();
      }else{
        location.reload();
      }
    }catch(_){ location.reload(); }
  },150);
}
window.retryLastLoad=retryLastLoad;
function showLoadError(title, error){
  console.error(title, error);
  __lastLoadError={title,error};
  const friendly=humanizeAppError(error);
  const code=error?.code||'';
  view.innerHTML = `<div class="card app-state-card app-state-error">
    <div class="app-state-icon">${friendly.icon}</div>
    <h2>${escapeHtml(friendly.title)}</h2>
    <p>${escapeHtml(friendly.detail)}</p>
    <p class="muted">${friendly.kind==='offline'?'ระบบจะลองเชื่อมต่ออีกครั้งเมื่ออินเทอร์เน็ตกลับมา':'หากยังไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'}</p>
    <button id="appRetryButton" class="btn primary full" onclick="retryLastLoad()">ลองใหม่</button>
    ${code?`<details class="app-error-detail"><summary>รายละเอียดสำหรับผู้ดูแลระบบ</summary><code>${escapeHtml(code)}</code></details>`:''}
  </div>`;
}
function emptyStateHtml(icon,title,detail=''){
  return `<div class="app-state-card app-state-empty"><div class="app-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3>${detail?`<p class="muted">${escapeHtml(detail)}</p>`:''}</div>`;
}
// ---------- Products cache + incremental realtime (v34.8) ----------
// เป้าหมาย: ลดการอ่าน Products ซ้ำทั้ง collection ทุกครั้งที่เปิดเว็บ
// - ครั้งแรกของอุปกรณ์: full sync 1 ครั้ง แล้วเก็บ snapshot ใน IndexedDB
// - ครั้งถัดไป: เปิดจาก cache ทันที และฟังเฉพาะเอกสารที่ updatedAt เปลี่ยนหลัง sync ล่าสุด
// - บังคับ full refresh อย่างน้อยทุก 24 ชม. เพื่อเก็บกวาดกรณี hard-delete จากอุปกรณ์อื่น
const PRODUCT_CACHE_DB='theview-stock-cache-v2-wjb-story';
const PRODUCT_CACHE_STORE='kv';
const PRODUCT_CACHE_KEY='products-wjb-story';
const PRODUCT_CACHE_TTL_MS=24*60*60*1000;
let productIncrementalUnsub=null;
let productsBindToken=0;
function openProductCacheDb(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)) return resolve(null);
    const req=indexedDB.open(PRODUCT_CACHE_DB,1);
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(PRODUCT_CACHE_STORE)) db.createObjectStore(PRODUCT_CACHE_STORE); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function readProductCache(){
  try{
    const db=await openProductCacheDb(); if(!db) return null;
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(PRODUCT_CACHE_STORE,'readonly');
      const req=tx.objectStore(PRODUCT_CACHE_STORE).get(PRODUCT_CACHE_KEY);
      req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error);
    });
  }catch(e){ console.warn('อ่าน Product cache ไม่สำเร็จ',e); return null; }
}
async function writeProductCache(products,lastFullSync=0,lastSyncAt=Date.now()){
  try{
    const db=await openProductCacheDb(); if(!db) return;
    const payload={products,lastFullSync,lastSyncAt,savedAt:Date.now()};
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(PRODUCT_CACHE_STORE,'readwrite');
      tx.objectStore(PRODUCT_CACHE_STORE).put(payload,PRODUCT_CACHE_KEY);
      tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
    });
  }catch(e){ console.warn('บันทึก Product cache ไม่สำเร็จ',e); }
}
function mergeProductDocs(incoming){
  const map=new Map(state.products.map(p=>[p.id,p]));
  for(const item of incoming) map.set(item.id,{...(map.get(item.id)||{}),...item});
  state.products=[...map.values()];
}
async function bindProductsOptimized(){
  const token=++productsBindToken;
  productsSnapshotReady=false;
  if(unsubProducts){ try{unsubProducts();}catch(_){} unsubProducts=null; }
  if(productIncrementalUnsub){ try{productIncrementalUnsub();}catch(_){} productIncrementalUnsub=null; }
  try{
    const cached=await readProductCache();
    if(token!==productsBindToken || !state.user) return;
    const now=Date.now();
    const cacheUsable=!!(cached && Array.isArray(cached.products) && cached.products.length);
    if(cacheUsable){
      state.products=cached.products;
      productsSnapshotReady=true;
      render();
    }
    const needsFullSync=!cacheUsable || !cached.lastFullSync || (now-cached.lastFullSync)>=PRODUCT_CACHE_TTL_MS;
    let effectiveLastFullSync=cached?.lastFullSync||0;
    let incrementalSince=(cached?.lastSyncAt||now)-60000; // overlap 60s กันพลาด serverTimestamp ระหว่าง sync
    if(needsFullSync){
      const syncStarted=Date.now()-60000;
      const snap=await getDocs(userPath('products'));
      if(token!==productsBindToken || !state.user) return;
      state.products=snap.docs.map(d=>({id:d.id,...d.data()}));
      productsSnapshotReady=true;
      effectiveLastFullSync=Date.now();
      await writeProductCache(state.products,effectiveLastFullSync,Date.now());
      incrementalSince=syncStarted;
      render();
    }
    // Listener นี้รับเฉพาะสินค้าที่มีการเปลี่ยนหลังจุด sync แทนการ onSnapshot ทั้ง collection
    const incrementalQuery=query(userPath('products'),where('updatedAt','>=',new Date(incrementalSince)));
    productIncrementalUnsub=onSnapshot(incrementalQuery,async snap=>{
      if(token!==productsBindToken) return;
      const changed=snap.docs.map(d=>({id:d.id,...d.data()}));
      if(changed.length) mergeProductDocs(changed);
      productsSnapshotReady=true;
      await writeProductCache(state.products,effectiveLastFullSync||Date.now(),Date.now());
      render();
    },err=>{
      productsSnapshotReady=true;
      // ถ้ามี cache อยู่ ให้แอปยังทำงานต่อได้และแจ้งเฉพาะ console; ถ้าไม่มีจึงแสดง Error state
      if(cacheUsable) console.warn('Product incremental sync ไม่สำเร็จ',err);
      else showLoadError('โหลดสินค้าไม่สำเร็จ',err);
    });
    unsubProducts=()=>{ if(productIncrementalUnsub){ try{productIncrementalUnsub();}catch(_){} productIncrementalUnsub=null; } };
  }catch(err){ productsSnapshotReady=true; showLoadError('โหลดสินค้าไม่สำเร็จ',err); }
}

function bindRealtime(){
  productsSnapshotReady=false;
  if(unsubProducts) unsubProducts();
  if(unsubApprovals) unsubApprovals();
  if(unsubLogs) unsubLogs();
  if(unsubAudit) unsubAudit();
  bindProductsOptimized();
  state.approvals=[];
  const approvalsSource=canApprove()
    ? userPath('approvals')
    : query(userPath('approvals'),where('submittedByUid','==',state.user.uid));
  unsubApprovals=onSnapshot(
    approvalsSource,
    snap=>{ state.approvals=snap.docs.map(d=>({id:d.id,...d.data()})); render(); },
    err=>showLoadError('โหลดรายการรออนุมัติไม่สำเร็จ',err)
  );
  unsubLogs = onSnapshot(query(userPath('logs'), orderBy('createdAt','desc'), limit(LOG_PAGE_SIZE)), snap=>{
    const live=snap.docs.map(d=>({id:d.id,...d.data()}));
    // เก็บข้อมูลเก่าที่ผู้ใช้กดโหลดเพิ่มไว้ และอัปเดตข้อมูลล่าสุดแบบ realtime เฉพาะชุดแรก
    const liveIds=new Set(live.map(x=>x.id));
    const older=state.logs.filter(x=>!liveIds.has(x.id));
    state.logs=[...live,...older].sort((a,b)=>(getLogDate(b)?.getTime()||0)-(getLogDate(a)?.getTime()||0));
    logsCursor=snap.docs[snap.docs.length-1]||logsCursor;
    logsHasMore=snap.docs.length===LOG_PAGE_SIZE;
    render();
  }, err=>showLoadError('โหลดประวัติไม่สำเร็จ',err));
  if(canManageProducts()){
    unsubAudit=onSnapshot(query(userPath('auditLogs'),orderBy('createdAt','desc'),limit(AUDIT_REALTIME_LIMIT)),snap=>{state.auditLogs=snap.docs.map(d=>({id:d.id,...d.data()}));},err=>console.warn('โหลด Audit Log ไม่สำเร็จ',err));
  }
}
function unbindRealtime(){
  productsBindToken++;
  if(unsubProducts){ unsubProducts(); unsubProducts=null; }
  if(productIncrementalUnsub){ try{productIncrementalUnsub();}catch(_){} productIncrementalUnsub=null; }
  if(unsubApprovals){ unsubApprovals(); unsubApprovals=null; }
  if(unsubLogs){ unsubLogs(); unsubLogs=null; }
  if(unsubAudit){ unsubAudit(); unsubAudit=null; }
  productsSnapshotReady=false; state.products=[]; state.approvals=[]; state.logs=[]; state.auditLogs=[]; logsCursor=null; logsHasMore=true; logsLoadingMore=false;
}
async function submitLogin(){
  const username=normalizeUsername($('username').value), password=$('password').value;
  if(!username||!password) return toast('กรอก Username และ Password');
  $('loginBtn').disabled=true;
  $('loginBtn').textContent='กำลังเข้าสู่ระบบ...';
  try{
    await signInWithEmailAndPassword(auth,usernameToEmail(username),password);
  }catch(e){
    const code=String(e?.code||'auth/unknown-error');
    console.error('[TheView Stock] Firebase login error', {
      code,
      message:e?.message,
      hostname:location.hostname,
      email:usernameToEmail(username)
    });
    const messages={
      'auth/invalid-credential':'Username หรือ Password ไม่ถูกต้อง',
      'auth/invalid-login-credentials':'Username หรือ Password ไม่ถูกต้อง',
      'auth/user-not-found':'ไม่พบบัญชีผู้ใช้นี้ใน Firebase Authentication',
      'auth/wrong-password':'Password ไม่ถูกต้อง',
      'auth/unauthorized-domain':'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase Authentication',
      'auth/network-request-failed':'เชื่อมต่อ Firebase ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตหรือการบล็อกเครือข่าย',
      'auth/too-many-requests':'มีการลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
      'auth/user-disabled':'บัญชีนี้ถูกปิดการใช้งาน',
      'auth/operation-not-allowed':'วิธีเข้าสู่ระบบ Email/Password ยังไม่ได้เปิดใช้งานใน Firebase'
    };
    const detail=messages[code]||'เกิดข้อผิดพลาดจาก Firebase Authentication';
    toast(`เข้าสู่ระบบไม่ได้: ${detail} (${code})`);
  }
  finally{ $('loginBtn').disabled=false; $('loginBtn').textContent='เข้าสู่ระบบ'; }
}
$('loginBtn').onclick=submitLogin;
$('username').addEventListener('keydown',e=>{ if(e.key==='Enter') $('password').focus(); });
$('password').addEventListener('keydown',e=>{ if(e.key==='Enter') submitLogin(); });
$('logoutBtn').onclick=()=>signOut(auth);
$('modalCloseBtn').onclick=hideModal;
$('firstPasswordBtn').onclick=()=>window.saveNewPassword(true);
$('passwordGateLogout').onclick=()=>signOut(auth);


// ---------- UI v27: เมนูล่าง 5 รายการ + เมนูแฮมเบอร์เกอร์ ----------
function ensureAppShellStyles(){
  if(document.getElementById('theviewAppShellStyles')) return;
  const style=document.createElement('style');
  style.id='theviewAppShellStyles';
  style.textContent=`
    .bottom-nav{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:2px}
    .bottom-nav button{min-width:0!important;padding:8px 2px!important;font-size:12px!important}
    .bottom-nav button>span:first-child{font-size:25px!important}
    .bottom-nav .nav-create{position:relative}
    .bottom-nav .nav-create>span:first-child{
      width:48px;height:48px;border-radius:16px;display:flex!important;
      align-items:center;justify-content:center;margin:-20px auto 3px!important;
      background:linear-gradient(145deg,#2563eb,#0ea5e9);color:#fff;
      box-shadow:0 8px 20px rgba(37,99,235,.32);font-size:32px!important;
      border:4px solid #fff;
    }
    .hero{position:relative}
    .header-menu-btn{
      width:54px;height:54px;border-radius:18px;border:1px solid rgba(255,255,255,.28);
      color:#fff;background:rgba(255,255,255,.10);font-size:28px;line-height:1;
      display:flex;align-items:center;justify-content:center;cursor:pointer;
      -webkit-tap-highlight-color:transparent;
    }
    .header-menu-panel{
      position:absolute;right:18px;top:78px;z-index:120;min-width:250px;
      max-height:min(72vh,620px);overflow-y:auto;-webkit-overflow-scrolling:touch;
      background:#fff;border:1px solid #dbe3ef;border-radius:18px;
      box-shadow:0 20px 50px rgba(15,23,42,.25);padding:8px;
    }
    .header-menu-group{padding:6px 6px 3px}
    .header-menu-group-title{
      padding:8px 10px 5px;font-size:12px;font-weight:800;letter-spacing:.03em;
      color:#64748b;text-transform:none;
    }
    .header-menu-group+.header-menu-group{border-top:1px solid #e5e7eb;margin-top:5px;padding-top:7px}
    .header-menu-panel button{
      width:100%;border:0;background:#fff;text-align:left;padding:14px 16px;
      border-radius:12px;font-size:17px;color:#0f172a;cursor:pointer;
    }
    .header-menu-panel button:hover,.header-menu-panel button:active{background:#eff6ff}
    .header-menu-panel .logout-item{color:#dc2626;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;margin-top:4px}
  `;
  document.head.appendChild(style);
}

function setupAppShell(){
  ensureAppShellStyles();

  const nav=document.querySelector('.bottom-nav');
  if(nav){
    nav.innerHTML=`
      <button data-page="home" class="active"><span>🏠</span><span class="nav-text">หน้าแรก</span></button>
      <button data-page="stock"><span>📦</span><span class="nav-text">สต๊อก</span></button>
      <button data-page="scan" class="nav-create"><span>＋</span><span class="nav-text">รายการใหม่</span></button>
      <button data-page="approval" class="nav-desktop-extra"><span>✅</span><span class="nav-text">รายการอนุมัติ</span></button>
      <button data-page="report" class="nav-desktop-extra"><span>📊</span><span class="nav-text">รายงาน</span></button>
      <button data-page="history"><span>📋</span><span class="nav-text">ประวัติ</span></button>
      <button data-page="profile"><span>👤</span><span class="nav-text">โปรไฟล์</span></button>
    `;
  }

  const oldLogout=$('logoutBtn');
  if(oldLogout) oldLogout.classList.add('hidden');

  const hero=document.querySelector('.hero');
  if(hero && !document.getElementById('headerMenuBtn')){
    const btn=document.createElement('button');
    btn.id='headerMenuBtn';
    btn.type='button';
    btn.className='header-menu-btn';
    btn.setAttribute('aria-label','เปิดเมนู');
    btn.textContent='☰';
    hero.appendChild(btn);

    const panel=document.createElement('div');
    panel.id='headerMenuPanel';
    panel.className='header-menu-panel hidden';
    panel.innerHTML=`
      <button type="button" id="headerProfileBtn">👤 โปรไฟล์ของฉัน</button>
      <button type="button" id="headerLogoutBtn" class="logout-item">🚪 ออกจากระบบ</button>
    `;
    hero.appendChild(panel);

    btn.addEventListener('click',e=>{
      e.stopPropagation();
      panel.classList.toggle('hidden');
    });
    $('headerProfileBtn').onclick=()=>{
      panel.classList.add('hidden');
      goToPage('profile');
    };
    $('headerLogoutBtn').onclick=()=>signOut(auth);
    document.addEventListener('click',e=>{
      if(!panel.contains(e.target) && e.target!==btn) panel.classList.add('hidden');
    });
  }
}
setupAppShell();
$('firstNewPass').addEventListener('keydown',e=>{ if(e.key==='Enter') $('firstConfirmPass').focus(); });
$('firstConfirmPass').addEventListener('keydown',e=>{ if(e.key==='Enter') window.saveNewPassword(true); });
function refreshHeaderMenu(){
  const panel=$('headerMenuPanel');
  if(!panel) return;
  panel.innerHTML=`
    <div class="header-menu-group">
      <div class="header-menu-group-title">บัญชีผู้ใช้</div>
      <button type="button" id="headerProfileBtn">👤 โปรไฟล์ของฉัน</button>
    </div>

    ${(canManageProducts()||canAdjustStock())?`<div class="header-menu-group">
      <div class="header-menu-group-title">จัดการสต๊อก</div>
      ${canAdjustStock()?`<button type="button" id="headerAdjustBtn">⚖️ ปรับยอดสต๊อก</button>`:''}
      ${canManageProducts()?`<button type="button" id="headerAuditBtn">🛡️ Audit Log</button>`:''}
    </div>`:''}

    <div class="header-menu-group">
      <div class="header-menu-group-title">รายงาน</div>
      <button type="button" id="headerReportBtn">📊 รายงานสต๊อก</button>
    </div>

    ${isAdmin()?`<div class="header-menu-group">
      <div class="header-menu-group-title">จัดการข้อมูลระบบ</div>
      <button type="button" id="headerBackupBtn">⬇️ สำรองข้อมูล</button>
      <button type="button" id="headerRestoreBtn">⬆️ กู้คืนข้อมูล</button>
    </div>`:''}

    <div class="header-menu-group">
      <button type="button" id="headerLogoutBtn" class="logout-item">🚪 ออกจากระบบ</button>
    </div>`;
  $('headerProfileBtn').onclick=()=>{ panel.classList.add('hidden'); goToPage('profile'); };
  if($('headerAdjustBtn')) $('headerAdjustBtn').onclick=()=>{ panel.classList.add('hidden'); goToPage('stock'); setTimeout(()=>window.openStockAdjustmentPicker(),0); };
  if($('headerAuditBtn')) $('headerAuditBtn').onclick=()=>{ panel.classList.add('hidden'); window.viewAuditLog(); };
  $('headerReportBtn').onclick=()=>{ panel.classList.add('hidden'); goToPage('report'); };
  if($('headerBackupBtn')) $('headerBackupBtn').onclick=()=>{ panel.classList.add('hidden'); window.exportBackup(); };
  if($('headerRestoreBtn')) $('headerRestoreBtn').onclick=()=>{ panel.classList.add('hidden'); window.chooseBackupFile(); };
  $('headerLogoutBtn').onclick=()=>signOut(auth);
}

function updateNavigationVisibility(){
  refreshHeaderMenu();
  const approvalBtn=document.querySelector('.bottom-nav button[data-page="approval"]');
  const reportBtn=document.querySelector('.bottom-nav button[data-page="report"]');
  // ทุกคนเปิดหน้ารายการของตนเองที่รอตรวจได้ ส่วนผู้มีสิทธิ์จะเห็นรายการที่ต้องอนุมัติ
  if(approvalBtn){
    approvalBtn.classList.remove('hidden');
    const label=approvalBtn.querySelector('.nav-text');
    if(label) label.textContent=canApprove()?'รายการอนุมัติ':'รายการรอตรวจ';
  }
  if(reportBtn) reportBtn.classList.toggle('hidden', !canViewReports());
  if(state.page==='report' && !canViewReports()) state.page='home';
}

function readScrollMap(){
  try{ return JSON.parse(localStorage.getItem(LAST_SCROLL_MAP_KEY)||'{}')||{}; }catch{return {};}
}

// ---------- v32.8: กู้ตำแหน่งเลื่อนแบบรอข้อมูล Realtime โหลดครบ ----------
// ก่อนหน้านี้ Safari พยายามเลื่อนไปตำแหน่งเดิมตั้งแต่รายการประวัติยังโหลดไม่ครบ
// ทำให้ตำแหน่งถูกบีบไว้ด้านบน และบางครั้ง scroll event เขียนค่า 0 ทับค่าที่บันทึกไว้
let scrollRestoreJob={active:false,page:null,target:0,attempts:0,timer:null};
function cancelScrollRestore(){
  if(scrollRestoreJob.timer) clearTimeout(scrollRestoreJob.timer);
  scrollRestoreJob={active:false,page:null,target:0,attempts:0,timer:null};
}
function saveCurrentPageScroll(){
  if(!state.page || scrollRestoreJob.active) return;
  const y=window.scrollY||document.documentElement.scrollTop||0;
  const map=readScrollMap();
  map[state.page]=y;
  localStorage.setItem(LAST_SCROLL_MAP_KEY,JSON.stringify(map));
  localStorage.setItem(LAST_SCROLL_KEY,String(y));
}
function runScrollRestoreAttempt(){
  if(!scrollRestoreJob.active || scrollRestoreJob.page!==state.page) return cancelScrollRestore();
  const target=Math.max(0,Number(scrollRestoreJob.target)||0);
  const docHeight=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);
  const maxScroll=Math.max(0,docHeight-window.innerHeight);
  const canReach=target<=maxScroll+8;
  const finalAttempt=scrollRestoreJob.attempts>=45;

  if(canReach || finalAttempt){
    const destination=Math.min(target,maxScroll);
    window.scrollTo({top:destination,behavior:'auto'});
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const current=window.scrollY||document.documentElement.scrollTop||0;
      if(Math.abs(current-destination)<=8 || finalAttempt){
        cancelScrollRestore();
      }else{
        scrollRestoreJob.attempts++;
        scrollRestoreJob.timer=setTimeout(runScrollRestoreAttempt,100);
      }
    }));
    return;
  }
  // รายการยังโหลดมาไม่ครบ รอ onSnapshot/render รอบถัดไปก่อน
  scrollRestoreJob.attempts++;
  scrollRestoreJob.timer=setTimeout(runScrollRestoreAttempt,100);
}
function restorePageScroll(page=state.page){
  const map=readScrollMap();
  const y=Number(map[page] ?? localStorage.getItem(LAST_SCROLL_KEY) ?? 0);
  cancelScrollRestore();
  if(!Number.isFinite(y)||y<=0) return;
  scrollRestoreJob={active:true,page,target:y,attempts:0,timer:null};
  requestAnimationFrame(()=>requestAnimationFrame(runScrollRestoreAttempt));
}
function continuePendingScrollRestore(){
  if(!scrollRestoreJob.active || scrollRestoreJob.page!==state.page) return;
  if(scrollRestoreJob.timer) clearTimeout(scrollRestoreJob.timer);
  scrollRestoreJob.timer=setTimeout(runScrollRestoreAttempt,20);
}
function goToPage(page, opts={}){
  if(page==='report' && !canViewReports()) return toast('คุณไม่มีสิทธิ์ดูรายงานทั้งหมด');
  const previousPage=state.page;
  saveCurrentPageScroll();
  state.page=VALID_PAGES.has(page)?page:'home';
  if(state.page!=='productDetail' && previousPage==='productDetail'){ state.viewProductId=null; localStorage.removeItem(PRODUCT_DETAIL_KEY); state.productDetailTab='general'; }
  localStorage.setItem(LAST_PAGE_KEY,state.page);
  if(opts.resetScroll===true){
    const map=readScrollMap(); map[state.page]=0; localStorage.setItem(LAST_SCROLL_MAP_KEY,JSON.stringify(map));
  }
  if(state.page==='stock'){
    const hasExplicitFilter=Object.prototype.hasOwnProperty.call(opts,'filter');
    if(hasExplicitFilter) state.stockFilter=opts.filter || 'all';
    else if(previousPage!=='stock') state.stockFilter='all';
    else state.stockFilter=state.stockFilter || 'all';
  }
  if(state.page==='history'){
    if(opts.historyFilter) state.historyFilter=opts.historyFilter;
    if(opts.historyPreset==='today'){
      const today=toDateStr(new Date()); state.historyStart=today; state.historyEnd=today;
    }
  }
  document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.toggle('active', x.dataset.page===state.page));
  render();
  if(opts.resetScroll===true) window.scrollTo({top:0,behavior:'auto'}); else restorePageScroll(state.page);
}
window.goToPage=goToPage;
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>goToPage(b.dataset.page));

const BOOT_RESTORE_TIMEOUT = 10000;
let bootTimeoutHandle=null;
function setBootMessage(message){
  const el=$('bootMessage');
  if(el) el.textContent=message;
}
function showBootScreen(message='กำลังโหลดข้อมูล...'){
  clearTimeout(bootTimeoutHandle);
  const boot=$('bootPage');
  const retry=$('bootRetryBtn');
  setBootMessage(message);
  if(retry) retry.classList.add('hidden');
  if(boot){
    boot.classList.remove('hidden','boot-fade-out');
    boot.style.pointerEvents='auto';
  }
  bootTimeoutHandle=setTimeout(()=>{
    setBootMessage('การโหลดใช้เวลานานกว่าปกติ');
    if(retry) retry.classList.remove('hidden');
  },BOOT_RESTORE_TIMEOUT);
}
function hideBootScreen(){
  clearTimeout(bootTimeoutHandle);
  const boot=$('bootPage');
  if(!boot) return;
  boot.classList.add('boot-fade-out');
  setTimeout(()=>boot.classList.add('hidden'),240);
}
function waitForScrollRestore(timeout=BOOT_RESTORE_TIMEOUT){
  const started=Date.now();
  return new Promise(resolve=>{
    const check=()=>{
      const targetMap=readScrollMap();
      const target=Number(targetMap[state.page] ?? localStorage.getItem(LAST_SCROLL_KEY) ?? 0);
      const current=window.scrollY||document.documentElement.scrollTop||0;
      const finished=!scrollRestoreJob.active && (target<=0 || Math.abs(current-Math.min(target,Math.max(0,document.documentElement.scrollHeight-window.innerHeight)))<=12);
      if(finished || Date.now()-started>=timeout) return resolve();
      setTimeout(check,80);
    };
    check();
  });
}
$('bootRetryBtn')?.addEventListener('click',()=>location.reload());

async function enterMainApp(){
  if(state.page==='productDetail' && !state.viewProductId){ state.page='stock'; localStorage.setItem(LAST_PAGE_KEY,'stock'); }
  normalizeMobilePageScrollV329();
  document.body.classList.remove('password-gate-active');
  document.body.classList.add('app-restoring');
  showBootScreen('กำลังโหลดข้อมูลและกลับไปยังหน้าล่าสุด...');
  $('loginPage').classList.add('hidden');
  $('passwordGate').classList.add('hidden');
  $('app').classList.remove('hidden');
  updateNavigationVisibility();
  document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.toggle('active', x.dataset.page===state.page));
  render();
  bindRealtime();
  restorePageScroll(state.page);
  await waitForScrollRestore();
  document.body.classList.remove('app-restoring');
  requestAnimationFrame(()=>requestAnimationFrame(()=>hideBootScreen()));
}

function showFirstPasswordGate(){
  document.body.classList.add('password-gate-active');
  $('bootPage').classList.add('hidden');
  $('loginPage').classList.add('hidden');
  $('app').classList.add('hidden');
  $('passwordGate').classList.remove('hidden');
  $('passwordGateUser').textContent = state.profile?.displayName
    ? `${state.profile.displayName} • ${state.profile.username || ''}`
    : (state.profile?.username || 'สมาชิก');
  $('firstNewPass').value='';
  $('firstConfirmPass').value='';
  setTimeout(()=>$('firstNewPass').focus(),100);
}

onAuthStateChanged(auth, async user=>{
  state.user=user; state.profile=null; state.members=[];
  $('loginPage').classList.add('hidden');
  $('passwordGate').classList.add('hidden');
  $('app').classList.add('hidden');
  document.body.classList.remove('password-gate-active');
  if(!user){
    unbindRealtime();
    $('bootPage').classList.add('hidden');
    $('loginPage').classList.remove('hidden');
    return;
  }

  try{
    const snap=await getDoc(memberRef(user.uid));
    if(!snap.exists()){
      $('bootPage').classList.add('hidden');
      $('app').classList.remove('hidden');
      view.innerHTML = `<div class="card"><h2>ยังไม่พบข้อมูลสมาชิก</h2><p>กรุณาสร้างเอกสาร <b>members/${escapeHtml(user.uid)}</b> ที่ระดับรากของ Firestore</p><button class="btn red full" onclick="window.logoutNow()">ออกจากระบบ</button></div>`;
      return;
    }
    state.profile={uid:user.uid,...snap.data()};
    if(state.profile.status!=='active'){
      toast('บัญชีนี้ถูกปิดใช้งาน');
      await signOut(auth);
      return;
    }

    // v34.9.1: รองรับบัญชีเก่าที่ไม่มี field gate และกู้สถานะ pending ค้าง
    // pending จะมีความหมายเฉพาะเมื่อ mustChangePassword=true เท่านั้น
    const mustChangePassword = state.profile.mustChangePassword === true;
    if(mustChangePassword){
      if(state.profile.passwordChangePending === true){
        try{
          await updateDoc(memberRef(user.uid),{ passwordChangePending:false });
          state.profile.passwordChangePending=false;
        }catch(recoverError){
          console.warn('กู้สถานะ passwordChangePending ไม่สำเร็จ', recoverError);
        }
      }
      showFirstPasswordGate();
      return;
    }

    await enterMainApp();
  }catch(error){
    $('bootPage').classList.add('hidden');
    $('app').classList.remove('hidden');
    showLoadError('เริ่มระบบไม่สำเร็จ',error);
  }
});
window.logoutNow=()=>signOut(auth);

// รูปถูกย่อขนาด + บีบอัดก่อนแปลงเป็น Base64 เพื่อไม่ให้ชนโควตาฟรีของ Firestore (ลิมิต 1MB/เอกสาร)
const MAX_IMG_DIMENSION = 640; // px ด้านยาวสุด
const IMG_QUALITY = 0.6; // คุณภาพ JPEG (0-1)
function compressImage(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > MAX_IMG_DIMENSION) {
          height = Math.round(height * (MAX_IMG_DIMENSION / width));
          width = MAX_IMG_DIMENSION;
        } else if (height > MAX_IMG_DIMENSION) {
          width = Math.round(width * (MAX_IMG_DIMENSION / height));
          height = MAX_IMG_DIMENSION;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMG_QUALITY));
      };
      img.onerror = reject;
      img.src = r.result;
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}


function ensureSearchStyles(){
  if(document.getElementById('theviewSearchStyles')) return;
  const style=document.createElement('style');
  style.id='theviewSearchStyles';
  style.textContent=`
    .scan-product-search-wrap{position:relative}
    .scan-product-results{position:absolute;z-index:60;left:0;right:0;top:calc(100% + 6px);max-height:310px;overflow:auto;background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 18px 45px rgba(15,23,42,.18);padding:6px}
    .scan-product-result{width:100%;display:flex;align-items:center;gap:10px;text-align:left;border:0;background:#fff;padding:10px;border-radius:12px;color:#0f172a}
    .scan-product-result:active,.scan-product-result:hover{background:#eff6ff}
    .scan-product-result img,.scan-product-result-icon{width:42px;height:42px;border-radius:10px;object-fit:cover;display:flex;align-items:center;justify-content:center;background:#e2e8f0;flex:0 0 auto}
    .scan-product-result-main{display:flex;flex-direction:column;min-width:0}
    .scan-product-result-main b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .scan-product-result-main small{color:#64748b;margin-top:2px}
    .scan-selected-product{margin:8px 0;padding:10px 12px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .scan-selected-product span{color:#2563eb;font-size:13px}.scan-selected-product small{color:#64748b}
  `;
  document.head.appendChild(style);
}
ensureSearchStyles();

function ensureStockCardStyles(){
  if(document.getElementById('theviewStockCardStyles')) return;
  const style=document.createElement('style');
  style.id='theviewStockCardStyles';
  style.textContent=`
    .stock-card-list{display:grid;gap:14px}
    .stock-card-modern{
      position:relative;
      display:grid;
      grid-template-columns:96px minmax(0,1fr) auto;
      gap:16px;
      align-items:center;
      min-height:150px;
      padding:18px 18px 18px 20px;
      background:#fff;
      border-radius:24px;
      border:1px solid #e7edf5;
      box-shadow:0 10px 28px rgba(15,23,42,.08);
      cursor:pointer;
      overflow:hidden;
      transition:transform .15s ease,box-shadow .15s ease;
      -webkit-tap-highlight-color:transparent;
    }
    .stock-card-modern:active{transform:scale(.985)}
    .stock-card-modern:hover{box-shadow:0 14px 34px rgba(15,23,42,.12)}
    .stock-card-modern::before{
      content:"";
      position:absolute;
      left:0;top:0;bottom:0;
      width:6px;
      background:var(--stock-accent,#22c55e);
    }
    .stock-card-photo{
      width:92px;height:112px;border-radius:18px;
      background:#f8fafc;
      display:flex;align-items:center;justify-content:center;
      overflow:hidden;
      flex:0 0 auto;
    }
    .stock-card-photo img{width:100%;height:100%;object-fit:contain}
    .stock-card-photo-placeholder{font-size:40px}
    .stock-card-main{min-width:0}
    .stock-card-name{
      margin:0 0 5px;
      font-size:21px;
      line-height:1.25;
      font-weight:800;
      color:#0f172a;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .stock-card-sku{
      color:#64748b;
      font-size:14px;
      margin-bottom:9px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .stock-card-label{color:#64748b;font-size:14px;margin-bottom:1px}
    .stock-card-qty{
      display:flex;align-items:baseline;gap:7px;
      color:#0f172a;
    }
    .stock-card-number{
      font-size:42px;
      line-height:1;
      font-weight:900;
      letter-spacing:-1px;
    }
    .stock-card-unit{font-size:18px;color:#475569;font-weight:700}
    .stock-card-side{
      align-self:stretch;
      min-width:118px;
      display:flex;
      align-items:center;
      justify-content:flex-end;
      gap:12px;
    }
    .stock-status-modern{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:12px 16px;
      border-radius:18px;
      font-size:16px;
      font-weight:800;
      white-space:nowrap;
    }
    .stock-status-modern::before{
      content:"";
      width:12px;height:12px;border-radius:999px;
      background:currentColor;
      box-shadow:0 0 0 4px rgba(255,255,255,.55);
    }
    .stock-status-ok{background:#dcfce7;color:#16a34a}
    .stock-status-low{background:#fef3c7;color:#d97706}
    .stock-status-out{background:#fee2e2;color:#ef4444}
    .stock-card-arrow{
      font-size:38px;
      line-height:1;
      color:#334155;
      font-weight:300;
      margin-left:2px;
    }
    @media (max-width:560px){
      .stock-card-modern{
        grid-template-columns:74px minmax(0,1fr) auto;
        gap:12px;
        min-height:126px;
        padding:15px 14px 15px 17px;
        border-radius:21px;
      }
      .stock-card-photo{width:70px;height:88px;border-radius:15px}
      .stock-card-name{font-size:18px}
      .stock-card-sku{font-size:12px;margin-bottom:6px}
      .stock-card-label{font-size:13px}
      .stock-card-number{font-size:34px}
      .stock-card-unit{font-size:15px}
      .stock-card-side{min-width:94px;gap:7px}
      .stock-status-modern{padding:9px 11px;font-size:14px;border-radius:15px}
      .stock-status-modern::before{width:10px;height:10px}
      .stock-card-arrow{font-size:30px}
    }
    @media (max-width:390px){
      .stock-card-modern{grid-template-columns:64px minmax(0,1fr) auto;gap:9px}
      .stock-card-photo{width:60px;height:78px}
      .stock-card-side{min-width:82px}
      .stock-status-modern{padding:8px 9px;font-size:13px}
      .stock-card-arrow{display:none}
    }
  `;
  document.head.appendChild(style);
}
ensureStockCardStyles();

function ensureProductDetailV276Styles(){
  if(document.getElementById('theviewProductDetailV276Styles')) return;
  const style=document.createElement('style');
  style.id='theviewProductDetailV276Styles';
  style.textContent=`
    .product-detail-shell{display:grid;gap:16px}
    .product-detail-card{background:#fff;border:1px solid #e2e8f0;border-radius:28px;padding:22px;box-shadow:0 12px 34px rgba(15,23,42,.08);overflow:hidden}
    .product-detail-top{display:grid;grid-template-columns:minmax(220px,310px) minmax(0,1fr);gap:24px;align-items:stretch}
    .product-detail-photo-wrap{background:#f8fafc;border-radius:24px;padding:18px;display:flex;flex-direction:column;gap:12px;min-height:300px}
    .product-detail-photo{width:100%;height:220px;object-fit:contain;border-radius:18px;background:#f8fafc}
    .product-detail-photo-placeholder{height:220px;border-radius:18px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:70px}
    .product-detail-change-photo{min-height:48px;border-radius:15px;background:#eef2ff;color:#1d4ed8;border:0;font-weight:900;font-size:16px}
    .product-detail-summary{display:flex;flex-direction:column;min-width:0}
    .product-detail-name{font-size:34px;line-height:1.18;margin:2px 0 8px;color:#0f172a}
    .product-detail-meta{font-size:17px;color:#64748b;line-height:1.7}
    .product-status-banner{margin-top:18px;border-radius:22px;padding:20px 22px;display:flex;align-items:center;gap:14px}
    .product-status-dot{width:18px;height:18px;border-radius:999px;flex:0 0 auto}
    .product-status-copy b{display:block;font-size:31px;line-height:1.1}
    .product-status-copy span{display:block;margin-top:7px;font-size:15px}
    .product-status-banner.ok{background:linear-gradient(135deg,#ecfdf5,#dcfce7);color:#15803d}
    .product-status-banner.warn{background:linear-gradient(135deg,#fffbeb,#fef3c7);color:#a16207}
    .product-status-banner.bad{background:linear-gradient(135deg,#fff1f2,#fee2e2);color:#dc2626}
    .product-status-banner.ok .product-status-dot{background:#22c55e}
    .product-status-banner.warn .product-status-dot{background:#facc15}
    .product-status-banner.bad .product-status-dot{background:#ef4444}
    .product-detail-stats{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
    .product-detail-stat{min-height:140px;border-radius:22px;padding:20px 22px;border:1px solid #e2e8f0;display:flex;flex-direction:column;justify-content:center}
    .product-detail-stat.stock{background:linear-gradient(135deg,#f0fdf4,#ecfdf5)}
    .product-detail-stat.min{background:linear-gradient(135deg,#fffbeb,#fefce8)}
    .product-detail-stat-label{font-size:16px;color:#475569;font-weight:800}
    .product-detail-stat-value{margin-top:8px;font-size:43px;font-weight:900;line-height:1;color:#0f172a}
    .product-detail-stat-value small{font-size:20px;color:#334155}
    .product-detail-info-list{margin-top:16px;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;background:#fff}
    .product-detail-info-row{min-height:58px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #e2e8f0}
    .product-detail-info-row:last-child{border-bottom:0}
    .product-detail-info-label{color:#64748b;font-weight:700}
    .product-detail-info-value{text-align:right;font-weight:800;color:#334155}
    .product-detail-edit-btn{width:100%;min-height:58px;margin-top:16px;border:1px solid #dbe3ef;border-radius:18px;background:#fff;color:#0f172a;font-weight:900;font-size:18px;display:flex;align-items:center;justify-content:space-between;padding:0 20px}
    .product-detail-tabs{margin-top:18px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;background:#fff}
    .product-detail-tab{min-height:54px;border:0;background:#fff;color:#64748b;font-weight:900;font-size:14px;border-bottom:3px solid transparent}
    .product-detail-tab.active{color:#2563eb;border-bottom-color:#2563eb;background:#f8fbff}
    .product-detail-panel{margin-top:14px}
    .product-history-item{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid #e2e8f0}
    .product-history-item:last-child{border-bottom:0}
    .product-history-main{flex:1;min-width:0}
    .product-history-time{font-size:12px;color:#64748b;white-space:nowrap}
    .product-empty{text-align:center;color:#64748b;padding:28px 14px}
    @media(max-width:620px){
      .product-detail-card{padding:16px;border-radius:23px}
      .product-detail-top{grid-template-columns:1fr;gap:16px}
      .product-detail-photo-wrap{min-height:auto;padding:14px}
      .product-detail-photo,.product-detail-photo-placeholder{height:190px}
      .product-detail-name{font-size:28px}
      .product-status-copy b{font-size:28px}
      .product-detail-stat{min-height:118px;padding:16px}
      .product-detail-stat-value{font-size:36px}
      .product-detail-tabs{grid-template-columns:1fr}
      .product-detail-tab{border-bottom:1px solid #e2e8f0}
      .product-detail-tab.active{border-bottom:3px solid #2563eb}
    }
  `;
  document.head.appendChild(style);
}
ensureProductDetailV276Styles();

function ensureTouchPolishV276(){
  if(document.getElementById('theviewTouchPolishV276')) return;
  const style=document.createElement('style');
  style.id='theviewTouchPolishV276';
  style.textContent=`
    html,body{width:100%;max-width:100%;overflow-x:hidden!important}
    html{background:#f4f7fb;overscroll-behavior:none}
    body{min-height:100dvh;overscroll-behavior:none;touch-action:pan-y}
    .app,.page,.hero,.card,.sheet{max-width:100%}
    button,[role="button"],a,summary,input,select,textarea{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    button,[role="button"],summary{min-height:44px}
    input,select,textarea{font-size:16px!important}
    .bottom-nav{z-index:100!important;transform:none!important;padding-bottom:calc(10px + env(safe-area-inset-bottom))!important}
    .bottom-nav button{min-width:54px;min-height:54px;padding:4px 6px}
    .page{padding-bottom:calc(118px + env(safe-area-inset-bottom))!important}
    .modal{overscroll-behavior:contain}
    .sheet{max-height:calc(92dvh - env(safe-area-inset-top));padding-bottom:calc(24px + env(safe-area-inset-bottom));overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
    .btn:active,.stock-card-modern:active,.product-detail-edit-btn:active,.product-detail-tab:active,.bottom-nav button:active{transform:none!important;opacity:.82}
  `;
  document.head.appendChild(style);
  document.addEventListener('gesturestart',event=>event.preventDefault(),{passive:false});
  document.addEventListener('gesturechange',event=>event.preventDefault(),{passive:false});
}
ensureTouchPolishV276();

// ---------- v28.6 Responsive PC + Mobile ----------
function ensureDesktopResponsiveV286Styles(){
  if(document.getElementById('theviewDesktopResponsiveV286')) return;
  const style=document.createElement('style');
  style.id='theviewDesktopResponsiveV286';
  style.textContent=`
    /* มือถือยังคงใช้เมนูล่าง 5 ปุ่มเหมือนเดิม */
    .nav-desktop-extra{display:none!important}
    .bottom-nav button .nav-text{display:block;font-size:12px!important;line-height:1.1}
    .stock-toolbar{display:grid;gap:10px}
    .stock-result-count{font-size:13px}

    @media (min-width:1024px){
      :root{--desktop-sidebar:272px}
      html{overflow-x:hidden!important;overflow-y:auto!important;background:#eef3f9;overscroll-behavior-y:auto!important}
      body{padding-bottom:0!important;min-height:100vh;overflow-x:hidden!important;overflow-y:visible!important;overscroll-behavior-y:auto!important;touch-action:auto!important}
      .app{max-width:none!important;width:100%!important;min-height:100vh;margin:0!important}

      .hero{
        position:fixed!important;inset:0 auto auto 0!important;
        width:var(--desktop-sidebar)!important;height:148px!important;
        min-height:148px!important;border-radius:0!important;
        padding:28px 24px!important;z-index:120!important;
        align-items:flex-start!important;
        box-shadow:10px 0 30px rgba(15,23,42,.08)
      }
      .hero>div{min-width:0;padding-right:34px}
      .hero h1{font-size:22px!important;line-height:1.15;white-space:nowrap}
      .hero p{font-size:13px!important;line-height:1.5;margin-top:10px!important;max-width:205px}
      .header-menu-btn{
        position:absolute!important;right:18px!important;top:22px!important;
        width:44px!important;height:44px!important;min-height:44px!important;
        border-radius:14px!important;font-size:23px!important;flex:0 0 auto
      }
      .header-menu-panel{left:18px!important;right:18px!important;top:92px!important;min-width:0!important}

      body .app .bottom-nav{
        position:fixed!important;left:0!important;right:auto!important;top:148px!important;bottom:0!important;
        width:var(--desktop-sidebar)!important;height:calc(100vh - 148px)!important;
        display:flex!important;flex-direction:column!important;justify-content:flex-start!important;
        align-items:stretch!important;gap:8px!important;
        padding:20px 16px 24px!important;background:#fff!important;
        border-top:0!important;border-right:1px solid #dbe3ef!important;
        overflow-y:auto!important;z-index:110!important;
        box-shadow:10px 16px 30px rgba(15,23,42,.05)
      }
      body .app .bottom-nav button{
        width:100%!important;min-width:0!important;min-height:56px!important;
        display:grid!important;grid-template-columns:38px minmax(0,1fr)!important;
        align-items:center!important;justify-items:start!important;gap:10px!important;
        padding:10px 14px!important;border-radius:15px!important;
        color:#475569!important;background:transparent!important;
        font-size:15px!important;text-align:left!important;transition:.16s ease
      }
      body .app .bottom-nav button:hover{background:#eff6ff!important;color:#1d4ed8!important}
      body .app .bottom-nav button.active{
        background:linear-gradient(135deg,#eaf2ff,#dbeafe)!important;
        color:#1d4ed8!important;box-shadow:inset 4px 0 0 #2563eb
      }
      body .app .bottom-nav button>span:first-child{
        display:grid!important;place-items:center!important;width:34px!important;height:34px!important;
        margin:0!important;font-size:23px!important;line-height:1!important
      }
      body .app .bottom-nav .nav-create span:first-child{
        width:34px!important;height:34px!important;margin:0!important;border:0!important;
        border-radius:11px!important;background:linear-gradient(145deg,#2563eb,#0ea5e9)!important;
        box-shadow:0 5px 12px rgba(37,99,235,.24)!important;font-size:25px!important;color:#fff!important
      }
      .bottom-nav .nav-text{display:block!important;font-size:15px!important;font-weight:850!important}
      .nav-desktop-extra{display:grid!important}
      .nav-desktop-extra.hidden{display:none!important}

      body .app .page{
        width:calc(100% - var(--desktop-sidebar))!important;
        max-width:none!important;margin-left:var(--desktop-sidebar)!important;
        padding:36px clamp(34px,4vw,68px) 64px!important;
        min-height:100vh!important;overflow:visible!important
      }
      .page>h1,.page>.between:first-child h1{font-size:32px;letter-spacing:-.4px}
      .card{border-radius:20px;box-shadow:0 8px 24px rgba(15,23,42,.055)}

      .home-dashboard-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:16px!important}
      .home-dashboard-grid .stat{min-height:126px;padding:20px}
      .home-dashboard-grid .stat b{font-size:34px;margin-top:9px}
      .home-priority-card{grid-template-columns:70px minmax(0,1fr) 28px;padding:22px 24px}
      .home-priority-icon{width:64px;height:64px;font-size:31px}
      .home-system-card{grid-template-columns:repeat(2,minmax(0,1fr));align-items:center}
      .home-system-card h2{grid-column:1/-1;margin-bottom:0}

      .stock-toolbar{
        grid-template-columns:minmax(300px,1fr) minmax(220px,320px)!important;
        gap:12px 16px!important;align-items:center!important;padding:20px!important
      }
      .stock-toolbar input,.stock-toolbar select{margin-top:0!important;height:52px}
      .stock-result-count{grid-column:1/-1!important;padding-left:2px;font-size:13px!important}
      .stock-card-list{
        display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;
        gap:16px!important;align-items:start!important
      }
      .stock-card-modern{min-height:158px;margin:0!important;padding:18px 18px 18px 22px!important}
      .stock-card-photo{width:88px!important;height:112px!important}
      .stock-card-name{font-size:20px!important}
      .stock-card-number{font-size:38px!important}

      .approval-info-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .approval-card{padding:24px!important}
      .approval-actions{max-width:680px}

      .new-item-form-card{max-width:980px;margin-left:auto!important;margin-right:auto!important}
      .new-item-tabs{max-width:620px;margin-left:auto;margin-right:auto}

      .profile-form-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:0 18px!important}
      .profile-action-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}

      .modal{align-items:center!important;padding:32px!important}
      .sheet{
        width:min(760px,calc(100vw - 64px))!important;max-width:760px!important;
        max-height:86vh!important;border-radius:24px!important;padding:24px!important;
        box-shadow:0 28px 70px rgba(15,23,42,.28)
      }
    }

    @media (min-width:1800px){
      :root{--desktop-sidebar:288px}
      .stock-card-list{grid-template-columns:repeat(3,minmax(0,1fr))!important}
      .stock-card-modern{grid-template-columns:82px minmax(0,1fr) auto!important;gap:14px!important}
      .stock-card-photo{width:78px!important;height:104px!important}
      .stock-card-number{font-size:35px!important}
      .stock-card-side{min-width:86px!important}
      .stock-card-arrow{display:none!important}
    }
  `;
  document.head.appendChild(style);
}
ensureDesktopResponsiveV286Styles();




// ---------- v33.0 Android/mobile page scrolling reliability ----------
function normalizeMobilePageScrollV329(){
  const html=document.documentElement;
  const body=document.body;
  if(!html || !body) return;

  // ปลดสถานะล็อกการเลื่อนที่อาจค้างหลังปิด modal / กลับจาก background
  const modal=$('modal');
  const modalVisible=modal && !modal.classList.contains('hidden');
  if(!modalVisible) body.classList.remove('modal-open');

  html.style.removeProperty('position');
  html.style.removeProperty('height');
  body.style.removeProperty('position');
  body.style.removeProperty('inset');
  body.style.removeProperty('height');
  body.style.removeProperty('top');
  body.style.removeProperty('overflow');
  body.style.removeProperty('touch-action');
}

window.addEventListener('pageshow',()=>requestAnimationFrame(normalizeMobilePageScrollV329));
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') requestAnimationFrame(normalizeMobilePageScrollV329);
});
window.addEventListener('orientationchange',()=>setTimeout(normalizeMobilePageScrollV329,120));

// ---------- v28.8 PC mouse-wheel scrolling anywhere ----------
function ensureDesktopWheelScrollV288(){
  if(window.__theviewDesktopWheelV288) return;
  window.__theviewDesktopWheelV288=true;

  const isDesktop=()=>window.matchMedia('(min-width:1024px)').matches;

  document.addEventListener('wheel',(event)=>{
    if(!isDesktop() || event.ctrlKey || event.metaKey) return;
    const target=event.target instanceof Element ? event.target : null;
    if(!target) return;

    // When a modal is open, wheel anywhere in that modal scrolls its sheet.
    const modal=target.closest('.modal');
    if(modal){
      const sheet=modal.querySelector('.sheet');
      if(sheet && sheet.scrollHeight>sheet.clientHeight){
        event.preventDefault();
        sheet.scrollTop += event.deltaY;
      }
      return;
    }

    // Search suggestion lists keep their own scrolling.
    const results=target.closest('.scan-product-results');
    if(results && results.scrollHeight>results.clientHeight){
      event.preventDefault();
      results.scrollTop += event.deltaY;
      return;
    }

    // On PC, wheel over header, sidebar, cards, buttons, inputs, or empty space
    // always moves the main page—not only when the pointer is over the scrollbar.
    event.preventDefault();
    window.scrollBy({top:event.deltaY,left:0,behavior:'auto'});
  },{passive:false,capture:true});
}
ensureDesktopWheelScrollV288();


function render(){
  if(!state.user) return;
  try {
    const renderer = ({home:renderHome,stock:renderStock,scan:renderScan,approval:renderApproval,report:renderReport,history:renderHistory,profile:renderProfile,trash:renderTrash,productDetail:()=>renderProductDetail(state.viewProductId)}[state.page]||renderHome);
    renderer();
    continuePendingScrollRestore();
  } catch(error) {
    showLoadError('แสดงหน้าไม่สำเร็จ', error);
  }
}
function renderHome(){
  const active=state.products.filter(p=>!p.archived && !p.trashed);
  const lowItems=active.filter(p=>Number(p.stock)<=Number(p.min));
  const low=lowItems.length;
  const pending=state.approvals.length;
  const todayStr=toDateStr(new Date());
  const validDate=l=>{ const d=getLogDate(l); return d instanceof Date && !Number.isNaN(d.getTime())?d:null; };
  const completedLogs=state.logs.filter(l=>l.action==='อนุมัติ');
  const todayLogs=state.logs.filter(l=>{ const d=validDate(l); return d && toDateStr(d)===todayStr; });
  const todayCompleted=completedLogs.filter(l=>{ const d=validDate(l); return d && toDateStr(d)===todayStr; });
  const todayIn=todayCompleted.filter(l=>l.moveType==='in');
  const todayOut=todayCompleted.filter(l=>l.moveType==='out');
  const sumQty=list=>list.reduce((sum,l)=>sum+(Number(l.qty)||0),0);
  const approvalTitle=canApprove()?'รายการรออนุมัติ':'รายการของฉันรออนุมัติ';
  const approvalDescription=canApprove()
    ? (pending?'มีรายการที่ต้องตรวจสอบและอนุมัติ':'ไม่มีรายการรออนุมัติ')
    : (pending?'แตะเพื่อตรวจสอบ แก้ไข หรือยกเลิกรายการของคุณ':'ไม่มีรายการของคุณที่รออนุมัติ');

  const days=[];
  for(let i=6;i>=0;i--){
    const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
    const key=toDateStr(d);
    const dayLogs=completedLogs.filter(l=>{const x=validDate(l);return x&&toDateStr(x)===key;});
    days.push({
      key,
      label:d.toLocaleDateString('th-TH',{weekday:'short'}).replace('.',''),
      inCount:dayLogs.filter(l=>l.moveType==='in').length,
      outCount:dayLogs.filter(l=>l.moveType==='out').length
    });
  }
  const maxDaily=Math.max(1,...days.map(x=>x.inCount+x.outCount));
  const chart=days.map(x=>{
    const inH=Math.max(x.inCount?10:2,Math.round((x.inCount/maxDaily)*100));
    const outH=Math.max(x.outCount?10:2,Math.round((x.outCount/maxDaily)*100));
    return `<div class="dash-chart-day" title="${escapeHtml(x.label)} รับเข้า ${x.inCount} เบิกออก ${x.outCount}">
      <div class="dash-chart-bars"><i class="dash-bar in" style="height:${inH}%"></i><i class="dash-bar out" style="height:${outH}%"></i></div>
      <span>${escapeHtml(x.label)}</span>
    </div>`;
  }).join('');

  const productUsage=new Map();
  completedLogs.filter(l=>l.moveType==='out').forEach(l=>{
    const key=l.productId||l.detail||'unknown';
    const current=productUsage.get(key)||{name:'ไม่ระบุสินค้า',qty:0,count:0,unit:l.unit||''};
    const p=state.products.find(x=>x.id===l.productId);
    current.name=p?.name||String(l.detail||'').replace(/^.*?\s/,'').trim()||'ไม่ระบุสินค้า';
    current.qty+=(Number(l.qty)||0); current.count+=1; current.unit=l.unit||p?.unit||current.unit;
    productUsage.set(key,current);
  });
  const topUsed=[...productUsage.values()].sort((a,b)=>b.qty-a.qty).slice(0,5);

  view.innerHTML=`<div class="dashboard-heading"><div><div class="dashboard-kicker">ภาพรวมคลังสินค้า</div><h1>หน้าแรก</h1></div><div class="dashboard-date">${new Date().toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric'})}</div></div>
    <div class="home-priority-card ${pending?'has-pending':'clear'}" onclick="window.goToPage('approval')" role="button" tabindex="0">
      <div class="home-priority-icon">${pending?'🔔':'✅'}</div>
      <div class="home-priority-copy"><span>${approvalTitle}</span><b>${pending}</b><small>${approvalDescription}</small></div>
      <div class="home-priority-arrow">›</div>
    </div>

    <div class="dashboard-stat-grid">
      <button class="dashboard-stat stat-in" onclick="window.goToPage('history',{historyPreset:'today',historyFilter:'in'})"><span class="dashboard-stat-icon">↓</span><div><small>รับเข้าวันนี้</small><b>${todayIn.length}</b><em>${sumQty(todayIn)} หน่วยรวม</em></div></button>
      <button class="dashboard-stat stat-out" onclick="window.goToPage('history',{historyPreset:'today',historyFilter:'out'})"><span class="dashboard-stat-icon">↑</span><div><small>เบิกออกวันนี้</small><b>${todayOut.length}</b><em>${sumQty(todayOut)} หน่วยรวม</em></div></button>
      <button class="dashboard-stat stat-products" onclick="window.goToPage('stock')"><span class="dashboard-stat-icon">📦</span><div><small>สินค้าทั้งหมด</small><b>${active.length}</b><em>พร้อมใช้งาน</em></div></button>
      <button class="dashboard-stat stat-low" onclick="window.goToPage('stock',{filter:'low'})"><span class="dashboard-stat-icon">⚠️</span><div><small>สินค้าใกล้หมด</small><b>${low}</b><em>${low?'ควรตรวจสอบ':'สถานะปกติ'}</em></div></button>
    </div>

    <div class="dashboard-grid-main">
      <section class="card dashboard-chart-card">
        <div class="dashboard-section-head"><div><small>การเคลื่อนไหว</small><h2>7 วันล่าสุด</h2></div><div class="dashboard-legend"><span><i class="in"></i>รับเข้า</span><span><i class="out"></i>เบิกออก</span></div></div>
        <div class="dash-chart">${chart}</div>
        <div class="dashboard-chart-footer"><span>วันนี้ทั้งหมด <b>${todayLogs.length}</b> เหตุการณ์</span><button onclick="window.goToPage('history')">ดูประวัติทั้งหมด ›</button></div>
      </section>

      <section class="card dashboard-side-card">
        <div class="dashboard-section-head"><div><small>การใช้งานสินค้า</small><h2>เบิกมากที่สุด</h2></div></div>
        <div class="dashboard-top-list">${topUsed.map((x,i)=>`<div class="dashboard-top-row"><span class="rank">${i+1}</span><div><b>${escapeHtml(x.name)}</b><small>${x.count} รายการ</small></div><strong>${x.qty} ${escapeHtml(x.unit||'')}</strong></div>`).join('')||'<div class="dashboard-empty">ยังไม่มีข้อมูลการเบิกสินค้า</div>'}</div>
      </section>
    </div>

    <section class="card dashboard-alert-card">
      <div class="dashboard-section-head"><div><small>ต้องดูแล</small><h2>สินค้าใกล้หมด</h2></div><button onclick="window.goToPage('stock',{filter:'low'})">ดูทั้งหมด ›</button></div>
      <div class="dashboard-low-list">${lowItems.slice(0,5).map(p=>`<button onclick="window.viewProduct('${p.id}')"><span>${p.photo?productImageMarkup(p.photo,p.name):'📦'}</span><div><b>${escapeHtml(p.name)}</b><small>จุดเตือน ${Number(p.min)||0} ${escapeHtml(p.unit||'')}</small></div><strong>${Number(p.stock)||0}</strong></button>`).join('')||'<div class="dashboard-empty ok">✅ ไม่มีสินค้าใกล้หมด</div>'}</div>
    </section>`;
}

function renderStock(){
  const filterLow = state.stockFilter === 'low';
  const all = state.products.filter(p=>!p.archived && !p.trashed);
  const queryText=(state.stockSearch||'').trim().toLowerCase();
  const categories=[...new Set(all.map(p=>String(p.category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'th'));
  if(state.stockCategory!=='all' && !categories.includes(state.stockCategory)) state.stockCategory='all';
  let list = filterLow ? all.filter(p=>Number(p.stock)<=Number(p.min)) : all;
  if(state.stockCategory!=='all') list=list.filter(p=>String(p.category||'').trim()===state.stockCategory);

  if(queryText){
    list=list.filter(p=>{
      const haystack=[p.name,p.sku,p.category,p.unit].map(v=>String(v||'').toLowerCase()).join(' ');
      return haystack.includes(queryText);
    });
  }

  const sortMode=state.stockSort==='low-first'?'stock-asc':(state.stockSort||'name-asc');
  if(state.stockSort==='low-first') state.stockSort='stock-asc';
  list=[...list].sort((a,b)=>{
    if(sortMode==='name-desc') return String(b.name||'').localeCompare(String(a.name||''),'th');
    if(sortMode==='stock-desc') return (Number(b.stock)||0)-(Number(a.stock)||0);
    if(sortMode==='stock-asc') return (Number(a.stock)||0)-(Number(b.stock)||0);
    return String(a.name||'').localeCompare(String(b.name||''),'th');
  });

  const rows = list.map(p=>{
    const stock=Number(p.stock)||0;
    const min=Number(p.min)||0;
    const isOut=stock<=0;
    const isLow=!isOut && stock<=min;
    const statusText=isOut?'หมด':(isLow?'ใกล้หมด':'ปกติ');
    const statusClass=isOut?'stock-status-out':(isLow?'stock-status-low':'stock-status-ok');
    const accent=isOut?'#ef4444':(isLow?'#f59e0b':'#22c55e');

    return `<article class="stock-card-modern"
      style="--stock-accent:${accent}"
      role="button"
      tabindex="0"
      aria-label="ดูรายละเอียด ${escapeHtml(p.name)}"
      onclick="window.viewProduct('${p.id}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.viewProduct('${p.id}')}">
      <div class="stock-card-photo">
        ${p.photo ? productImageMarkup(p.photo,p.name) : `<div class="stock-card-photo-placeholder">📦</div>`}
      </div>

      <div class="stock-card-main">
        <h3 class="stock-card-name">${escapeHtml(p.name)}</h3>
        <div class="stock-card-sku">รหัสสินค้า: ${escapeHtml(p.sku||'-')}</div>
        <div class="stock-card-label">คงเหลือ</div>
        <div class="stock-card-qty">
          <span class="stock-card-number">${stock}</span>
          <span class="stock-card-unit">${escapeHtml(p.unit||'หน่วย')}</span>
        </div>
      </div>

      <div class="stock-card-side">
        <span class="stock-status-modern ${statusClass}">${statusText}</span>
        <span class="stock-card-arrow">›</span>
      </div>
    </article>`;
  }).join('');

  const archivedCount = state.products.filter(p=>p.archived && !p.trashed).length;
  const emptyMsg = queryText
    ? '<div class="card"><p class="muted">ไม่พบสินค้าที่ค้นหา</p></div>'
    : (filterLow
      ? '<div class="card"><p class="muted">ไม่มีสินค้าใกล้หมด 🎉</p></div>'
      : '<div class="card"><p class="muted">ยังไม่มีสินค้า</p></div>');

  view.innerHTML = `<div class="between stock-page-head">
      <h1>Stock${filterLow?' • ใกล้หมด':''}</h1>
      ${(canManageProducts()||canAdjustStock())?`<div class="stock-head-actions">${canAdjustStock()?`<button class="btn light small" onclick="window.openStockAdjustmentPicker()">⚖️ ปรับยอด</button>`:''}${canManageProducts()?`<button class="btn primary small" onclick="window.addProduct()">+ เพิ่ม</button>`:''}</div>`:''}
    </div>

    <div class="card stock-toolbar">
      <input id="stockSearchInput" class="stock-search-field"
        value="${escapeHtml(state.stockSearch||'')}"
        placeholder="🔍 ค้นหาชื่อสินค้า, SKU หรือหมวดหมู่"
        oninput="window.setStockSearch(this.value)">
      <select id="stockCategorySelect" class="stock-sort-field" onchange="window.setStockCategory(this.value)">
        <option value="all" ${state.stockCategory==='all'?'selected':''}>ทุกหมวดหมู่</option>
        ${categories.map(c=>`<option value="${escapeHtml(c)}" ${state.stockCategory===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select id="stockSortSelect" class="stock-sort-field" onchange="window.setStockSort(this.value)">
        <option value="name-asc" ${sortMode==='name-asc'?'selected':''}>เรียงชื่อ A–Z</option>
        <option value="name-desc" ${sortMode==='name-desc'?'selected':''}>เรียงชื่อ Z–A</option>
        <option value="stock-desc" ${sortMode==='stock-desc'?'selected':''}>จำนวนมากไปน้อย</option>
        <option value="stock-asc" ${sortMode==='stock-asc'?'selected':''}>จำนวนน้อยไปมาก</option>
      </select>
      <div class="muted stock-result-count">แสดง ${list.length} จาก ${all.length} รายการ</div>
    </div>

    ${filterLow?`<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <span class="muted">กำลังแสดงเฉพาะสินค้าใกล้หมด</span>
      <button class="btn small" onclick="window.goToPage('stock',{filter:'all',resetScroll:true})">แสดงทั้งหมด</button>
    </div>`:''}

    <div class="stock-card-list">${rows||emptyMsg}</div>

    ${archivedCount?`<div class="card">
      <button class="btn light full" onclick="window.showArchived()">📦 ดูรายการที่ Archive แล้ว (${archivedCount})</button>
    </div>`:''}`;
}
function refreshStockSearchResults(){
  // อัปเดตเฉพาะรายการสินค้า ไม่สร้างช่องค้นหาใหม่
  // เพื่อไม่ให้คีย์บอร์ด iPhone ปิดหรือเคอร์เซอร์หลุดทุกครั้งที่พิมพ์
  const listBox=document.querySelector('.stock-card-list');
  const countBox=document.querySelector('.stock-result-count');
  if(!listBox || !countBox) return;

  const filterLow=state.stockFilter==='low';
  const all=state.products.filter(p=>!p.archived && !p.trashed);
  const queryText=(state.stockSearch||'').trim().toLowerCase();
  let list=filterLow ? all.filter(p=>Number(p.stock)<=Number(p.min)) : all;
  if(state.stockCategory!=='all') list=list.filter(p=>String(p.category||'').trim()===state.stockCategory);

  if(queryText){
    list=list.filter(p=>{
      const haystack=[p.name,p.sku,p.category,p.unit].map(v=>String(v||'').toLowerCase()).join(' ');
      return haystack.includes(queryText);
    });
  }

  const sortMode=state.stockSort==='low-first'?'stock-asc':(state.stockSort||'name-asc');
  if(state.stockSort==='low-first') state.stockSort='stock-asc';
  list=[...list].sort((a,b)=>{
    if(sortMode==='name-desc') return String(b.name||'').localeCompare(String(a.name||''),'th');
    if(sortMode==='stock-desc') return (Number(b.stock)||0)-(Number(a.stock)||0);
    if(sortMode==='stock-asc') return (Number(a.stock)||0)-(Number(b.stock)||0);
    return String(a.name||'').localeCompare(String(b.name||''),'th');
  });

  const rows=list.map(p=>{
    const stock=Number(p.stock)||0;
    const min=Number(p.min)||0;
    const isOut=stock<=0;
    const isLow=!isOut && stock<=min;
    const statusText=isOut?'หมด':(isLow?'ใกล้หมด':'ปกติ');
    const statusClass=isOut?'stock-status-out':(isLow?'stock-status-low':'stock-status-ok');
    const accent=isOut?'#ef4444':(isLow?'#f59e0b':'#22c55e');
    return `<article class="stock-card-modern" style="--stock-accent:${accent}" role="button" tabindex="0" aria-label="ดูรายละเอียด ${escapeHtml(p.name)}" onclick="window.viewProduct('${p.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.viewProduct('${p.id}')}">
      <div class="stock-card-photo">${p.photo?productImageMarkup(p.photo,p.name):`<div class="stock-card-photo-placeholder">📦</div>`}</div>
      <div class="stock-card-main"><h3 class="stock-card-name">${escapeHtml(p.name)}</h3><div class="stock-card-sku">รหัสสินค้า: ${escapeHtml(p.sku||'-')}</div><div class="stock-card-label">คงเหลือ</div><div class="stock-card-qty"><span class="stock-card-number">${stock}</span><span class="stock-card-unit">${escapeHtml(p.unit||'หน่วย')}</span></div></div>
      <div class="stock-card-side"><span class="stock-status-modern ${statusClass}">${statusText}</span><span class="stock-card-arrow">›</span></div>
    </article>`;
  }).join('');

  const emptyMsg=queryText
    ? '<div class="card"><p class="muted">ไม่พบสินค้าที่ค้นหา</p></div>'
    : (filterLow?'<div class="card"><p class="muted">ไม่มีสินค้าใกล้หมด 🎉</p></div>':'<div class="card"><p class="muted">ยังไม่มีสินค้า</p></div>');

  listBox.innerHTML=rows||emptyMsg;
  countBox.textContent=`แสดง ${list.length} จาก ${all.length} รายการ`;
}

window.setStockSearch=(value)=>{
  state.stockSearch=String(value||'');
  refreshStockSearchResults();
};
window.setStockSort=(value)=>{ state.stockSort=value||'name-asc'; saveUiState(); renderStock(); };
window.setStockCategory=(value)=>{ state.stockCategory=value||'all'; saveUiState(); renderStock(); };

// ป้องกันเมนู ⋮ ล้นออกนอกจอ (ทั้งขอบล่างและขอบขวา) โดยเฉพาะรายการสุดท้ายในลิสต์
function attachMenuPositioning(){
  document.querySelectorAll('.menu').forEach(menu=>{
    menu.addEventListener('toggle', ()=>{
      const items = menu.querySelector('.menu-items');
      if(!items) return;
      if(!menu.open){ items.style.position=''; items.style.top=''; items.style.left=''; items.style.bottom=''; return; }
      document.querySelectorAll('.menu[open]').forEach(m=>{ if(m!==menu) m.open=false; });
      const summary = menu.querySelector('summary');
      const rect = summary.getBoundingClientRect();
      items.style.position='fixed';
      items.style.right='auto';
      const menuHeight = items.offsetHeight;
      const menuWidth = items.offsetWidth;
      const BOTTOM_NAV_HEIGHT = 90;
      const spaceBelow = window.innerHeight - rect.bottom - BOTTOM_NAV_HEIGHT;
      if(spaceBelow < menuHeight){
        items.style.top = Math.max(8, rect.top - menuHeight - 6) + 'px';
      } else {
        items.style.top = (rect.bottom + 6) + 'px';
      }
      let left = rect.right - menuWidth;
      if(left < 8) left = 8;
      if(left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
      items.style.left = left + 'px';
    });
  });
}
document.addEventListener('click', (e)=>{
  document.querySelectorAll('.menu[open]').forEach(m=>{ if(!m.contains(e.target)) m.open=false; });
});

function renderArchived(){ const rows=state.products.filter(p=>p.archived && !p.trashed).map(p=>`<div class="product"><div><b>${escapeHtml(p.name)}</b><div class="muted">${escapeHtml(p.sku||'-')} • ${p.stock} ${escapeHtml(p.unit||'')}</div></div><div class="row"><button class="btn small green" onclick="window.unarchiveProduct('${p.id}')">↩️ กู้คืน</button></div></div>`).join(''); view.innerHTML=`<div class="between"><h1>รายการที่ Archive</h1><button class="btn small" onclick="window.backToStock()">← กลับ</button></div><div class="card">${rows||'<p class="muted">ไม่มีรายการที่ Archive</p>'}</div>`; }
window.showArchived=()=>renderArchived();
window.backToStock=()=>{ state.viewProductId=null; localStorage.removeItem(PRODUCT_DETAIL_KEY); state.productDetailTab='general'; saveUiState(); goToPage('stock'); };
window.unarchiveProduct=async(id)=>{ if(!requireManager()) return; const p=state.products.find(x=>x.id===id); await updateDoc(productRef(id),{archived:false,updatedAt:serverTimestamp()}); await addLog('กู้คืนสินค้า',p.name,{productId:id}); toast('กู้คืนแล้ว'); renderArchived(); };

// ---------- หน้ารายละเอียดสินค้า (รูป + ประวัติรับ/เบิก) ----------
window.viewProduct=(id)=>{
  if(!id) return;
  saveCurrentPageScroll();
  state.viewProductId=id;
  state.productDetailTab='general';
  localStorage.setItem(PRODUCT_DETAIL_KEY,id);
  saveUiState();
  state.page='productDetail';
  localStorage.setItem(LAST_PAGE_KEY,'productDetail');
  document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.remove('active'));
  renderProductDetail(id);
  restorePageScroll('productDetail');
};
function renderProductDetail(id){
  if(!id){
    state.page='stock'; localStorage.setItem(LAST_PAGE_KEY,'stock'); renderStock(); return;
  }
  const p=state.products.find(x=>x.id===id);
  if(!p){
    if(!productsSnapshotReady){
      view.innerHTML='<div class="card"><h2>กำลังโหลดรายละเอียดสินค้า...</h2><p class="muted">กำลังกลับไปยังสินค้าที่คุณเปิดไว้ก่อนรีเฟรช</p></div>';
      return;
    }
    state.viewProductId=null; localStorage.removeItem(PRODUCT_DETAIL_KEY); state.page='stock'; localStorage.setItem(LAST_PAGE_KEY,'stock'); renderStock(); return;
  }

  const history=state.logs.filter(l=>l.productId===id).sort((a,b)=>(getLogDate(b)?.getTime()||0)-(getLogDate(a)?.getTime()||0));
  const stock=Number(p.stock)||0;
  const min=Number(p.min)||0;
  const isOut=stock<=0;
  const isLow=!isOut&&stock<=min;
  const statusText=isOut?'หมด':(isLow?'ใกล้หมด':'ปกติ');
  const statusClass=isOut?'bad':(isLow?'warn':'ok');
  const statusDescription=isOut?'สินค้าไม่มีคงเหลือ ควรดำเนินการเติมสินค้า':(isLow?'เหลือน้อยกว่าหรือเท่ากับจุดเตือนที่ตั้งไว้':'จำนวนคงเหลือมากกว่าจุดเตือน');

  const latest=history[0];
  const latestActor=latest?.reviewerName||latest?.actorName||'-';
  const latestTime=latest?.time||'-';
  const latestNote=p.note||latest?.note||'-';

  const historyRows=history.map(l=>{
    const {label,cls}=logPillInfo(l);
    const changesHtml=Array.isArray(l.changes)&&l.changes.length?`<ul style="margin:6px 0 0;padding-left:18px">${l.changes.map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>`:'';
    return `<div class="product-history-item">
      ${l.photo?`<img src="${l.photo}" style="width:54px;height:54px;border-radius:12px;object-fit:cover;flex:0 0 auto">`:''}
      <div class="product-history-main">
        <span class="pill ${cls}">${escapeHtml(label)}</span>
        <div style="margin-top:6px">${l.qty?`<b>${l.qty} ${escapeHtml(l.unit||'')}</b> — `:''}${escapeHtml(l.detail||'')}</div>
        ${l.location?`<div class="muted" style="font-size:13px;margin-top:4px">📍 ${escapeHtml(l.location)}</div>`:''}
        ${changesHtml}
      </div>
      <div class="product-history-time">${escapeHtml(l.time||'')}</div>
    </div>`;
  }).join('');

  const movementRows=history.filter(l=>isStockMovementLog(l)).map(l=>{
    const incoming=isReceiveLog(l);
    return `<div class="product-history-item">
      <div style="width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:${incoming?'#dcfce7':'#fef3c7'};font-size:21px">${incoming?'↓':'↑'}</div>
      <div class="product-history-main">
        <b>${incoming?'รับเข้า':'เบิกออก'} ${Number(l.qty)||0} ${escapeHtml(l.unit||p.unit||'')}</b>
        <div class="muted" style="font-size:13px;margin-top:4px">${escapeHtml(l.detail||'')}</div>
        ${l.location?`<div class="muted" style="font-size:13px">📍 ${escapeHtml(l.location)}</div>`:''}
      </div>
      <div class="product-history-time">${escapeHtml(l.time||'')}</div>
    </div>`;
  }).join('');

  view.innerHTML=`<div class="between"><h1>รายละเอียดสินค้า</h1><button class="btn small" onclick="window.backToStock()">← กลับ</button></div>
  <div class="product-detail-shell">
    <section class="product-detail-card">
      <div class="product-detail-top">
        <div class="product-detail-photo-wrap">
          ${p.photo?productImageMarkup(p.photo,p.name,'product-detail-photo'):`<div class="product-detail-photo-placeholder">📦</div>`}
          <input id="prodPhotoInput" type="file" accept="image/*" class="hidden">
          ${canManageProducts()?`<button type="button" class="product-detail-change-photo" onclick="$('prodPhotoInput').click()">📷 ${p.photo?'เปลี่ยนรูปสินค้า':'เพิ่มรูปสินค้า'}</button>`:''}
        </div>

        <div class="product-detail-summary">
          <h2 class="product-detail-name">${escapeHtml(p.name)}</h2>
          <div class="product-detail-meta">รหัสสินค้า: ${escapeHtml(p.sku||'-')}<br>หมวดหมู่: ${escapeHtml(p.category||'ทั่วไป')}</div>

          <div class="product-status-banner ${statusClass}">
            <span class="product-status-dot"></span>
            <div class="product-status-copy"><b>${statusText}</b><span>${statusDescription}</span></div>
          </div>

          <div class="product-detail-stats">
            <div class="product-detail-stat stock">
              <div class="product-detail-stat-label">📦 คงเหลือ</div>
              <div class="product-detail-stat-value">${stock} <small>${escapeHtml(p.unit||'หน่วย')}</small></div>
            </div>
            <div class="product-detail-stat min">
              <div class="product-detail-stat-label">🔔 จุดเตือน</div>
              <div class="product-detail-stat-value">${min} <small>${escapeHtml(p.unit||'หน่วย')}</small></div>
            </div>
          </div>
        </div>
      </div>

      <div class="product-detail-info-list">
        <div class="product-detail-info-row"><span class="product-detail-info-label">📅 อัปเดตล่าสุด</span><span class="product-detail-info-value">${escapeHtml(latestTime)}</span></div>
        <div class="product-detail-info-row"><span class="product-detail-info-label">👤 ผู้บันทึกล่าสุด</span><span class="product-detail-info-value">${escapeHtml(latestActor)}</span></div>
        <div class="product-detail-info-row"><span class="product-detail-info-label">📝 หมายเหตุ</span><span class="product-detail-info-value">${escapeHtml(latestNote)}</span></div>
      </div>

      ${canAdjustStock()?`<button type="button" class="product-detail-edit-btn" onclick="window.adjustStock('${p.id}')"><span>⚖️ ปรับยอดสต๊อก</span><span>›</span></button>`:''}${canManageProducts()?`<button type="button" class="product-detail-edit-btn" onclick="window.editProduct('${p.id}')"><span>✏️ แก้ไขข้อมูลสินค้า</span><span>›</span></button>`:''}

      <div class="product-detail-tabs" role="tablist">
        <button type="button" class="product-detail-tab ${state.productDetailTab==='general'?'active':''}" data-product-tab="general" onclick="window.switchProductDetailTab('general')">ข้อมูลทั่วไป</button>
        <button type="button" class="product-detail-tab ${state.productDetailTab==='movement'?'active':''}" data-product-tab="movement" onclick="window.switchProductDetailTab('movement')">ประวัติการเคลื่อนไหว</button>
        <button type="button" class="product-detail-tab ${state.productDetailTab==='all'?'active':''}" data-product-tab="all" onclick="window.switchProductDetailTab('all')">ประวัติทั้งหมด</button>
      </div>

      <div id="productDetailPanel_general" class="product-detail-panel ${state.productDetailTab==='general'?'':'hidden'}">
        <div class="product-detail-info-list" style="margin-top:0">
          <div class="product-detail-info-row"><span class="product-detail-info-label">ชื่อสินค้า</span><span class="product-detail-info-value">${escapeHtml(p.name)}</span></div>
          <div class="product-detail-info-row"><span class="product-detail-info-label">SKU</span><span class="product-detail-info-value">${escapeHtml(p.sku||'-')}</span></div>
          <div class="product-detail-info-row"><span class="product-detail-info-label">หมวดหมู่</span><span class="product-detail-info-value">${escapeHtml(p.category||'ทั่วไป')}</span></div>
          <div class="product-detail-info-row"><span class="product-detail-info-label">หน่วยนับ</span><span class="product-detail-info-value">${escapeHtml(p.unit||'หน่วย')}</span></div>
        </div>
      </div>

      <div id="productDetailPanel_movement" class="product-detail-panel ${state.productDetailTab==='movement'?'':'hidden'}">${movementRows||'<div class="product-empty">ยังไม่มีประวัติรับเข้า–เบิกออก</div>'}</div>
      <div id="productDetailPanel_all" class="product-detail-panel ${state.productDetailTab==='all'?'':'hidden'}">${historyRows||'<div class="product-empty">ยังไม่มีประวัติสำหรับสินค้านี้</div>'}</div>
    </section>
  </div>`;

  if(canManageProducts()){
    const photoInput=$('prodPhotoInput');
    if(photoInput) photoInput.onchange=async e=>{
      const f=e.target.files[0];if(!f)return;
      try{
        toast('กำลังอัปโหลดรูปสินค้า...');
        const dataUrl=await compressImage(f);
        const uploaded=await uploadProductImage(id,dataUrl,p.photoPath||'');
        await updateDoc(productRef(id),{photo:uploaded.url,photoPath:uploaded.path,updatedAt:serverTimestamp()});
        await addLog('อัปเดตรูปสินค้า',p.name,{productId:id,changes:['เปลี่ยนรูปภาพสินค้าใหม่ (Cloud Storage)']});
        toast('บันทึกรูปแล้ว');
      }catch(error){
        console.error(error);
        toast('บันทึกรูปไม่สำเร็จ');
      }
    };
  }
}

window.switchProductDetailTab=(tab)=>{
  if(!['general','movement','all'].includes(tab)) tab='general';
  state.productDetailTab=tab; saveUiState();
  ['general','movement','all'].forEach(name=>{
    $(`productDetailPanel_${name}`)?.classList.toggle('hidden',name!==tab);
    document.querySelector(`[data-product-tab="${name}"]`)?.classList.toggle('active',name===tab);
  });
};

window.openStockAdjustmentPicker=()=>{
  if(!requireManager()) return;
  const products=state.products.filter(p=>!p.trashed&&!p.archived).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'th'));
  if(!products.length) return toast('ยังไม่มีสินค้าให้ปรับยอด');
  openModal('⚖️ เลือกสินค้าที่ต้องการปรับยอด',`
    <label class="field-label" for="adjustProductSelect">สินค้า</label>
    <select id="adjustProductSelect">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} • คงเหลือ ${Number(p.stock)||0} ${escapeHtml(p.unit||'หน่วย')}</option>`).join('')}</select>
    <p class="note">การปรับยอดจะแยกจากการแก้ไขข้อมูลสินค้า และบันทึก Audit Log ทุกครั้ง</p>
    <button class="btn primary full" onclick="window.confirmStockAdjustmentPicker()">ถัดไป</button>`);
};
window.confirmStockAdjustmentPicker=()=>{ const id=$('adjustProductSelect')?.value; if(id) window.adjustStock(id); };

window.addProduct=()=>{ if(!requireManager()) return; state.newProductImage=null; openModal('เพิ่มสินค้า',`
  <label class="field-label" for="pn">ชื่อสินค้า</label>
  <input id="pn" placeholder="เช่น ถุงใส่แก้วกาแฟคู่">

  <label class="field-label" for="ps">รหัสสินค้า (SKU)</label>
  <span class="field-hint">ไม่บังคับ เว้นว่างได้</span>
  <input id="ps" placeholder="ไม่บังคับ" oninput="window.validateSkuField('')" onblur="window.validateSkuField('')">
  <div id="skuInlineError" class="sku-inline-error hidden" role="alert"></div>

  <label class="field-label" for="pc">หมวดหมู่</label>
  <input id="pc" placeholder="เช่น บรรจุภัณฑ์">

  <label class="field-label" for="pu">หน่วยนับ</label>
  <span class="field-hint">เช่น แพ็ค, ชิ้น, กระป๋อง, ใบ</span>
  <input id="pu" placeholder="เช่น แพ็ค">

  <label class="field-label" for="pq">จำนวนคงเหลือเริ่มต้น</label>
  <input id="pq" type="number" placeholder="เช่น 10">

  <label class="field-label" for="pm">จุดเตือนสต๊อกต่ำ</label>
  <span class="field-hint">แจ้งเตือน "ใกล้หมด" เมื่อคงเหลือน้อยกว่าหรือเท่ากับจำนวนนี้</span>
  <input id="pm" type="number" placeholder="เช่น 5">

  <label class="field-label">รูปสินค้า</label>
  <span class="field-hint">เลือกรูปได้ตั้งแต่ตอนเพิ่มสินค้า ระบบจะบีบอัดและอัปโหลดเข้า Firebase Storage อัตโนมัติ</span>
  <input id="newProductImageInput" type="file" accept="image/*" style="display:none" onchange="window.selectNewProductImage(event)">
  <button type="button" class="btn secondary full" onclick="document.getElementById('newProductImageInput').click()">📷 เลือกรูปสินค้า</button>
  <div id="newProductImagePreviewWrap" class="hidden" style="margin-top:12px;text-align:center">
    <img id="newProductImagePreview" class="preview" alt="ตัวอย่างรูปสินค้า" style="max-height:220px;object-fit:contain">
    <button type="button" class="btn ghost full" style="margin-top:8px" onclick="window.clearNewProductImage()">ลบรูปที่เลือก</button>
  </div>

  <button id="saveNewProductBtn" class="btn primary full" onclick="window.saveNewProduct()">บันทึกสินค้า</button>
`); };

window.selectNewProductImage=async(event)=>{
  const input=event?.target;
  const file=input?.files?.[0];
  if(!file) return;
  try{
    state.newProductImage=await compressImage(file);
    const img=$('newProductImagePreview'),wrap=$('newProductImagePreviewWrap');
    if(img) img.src=state.newProductImage;
    wrap?.classList.remove('hidden');
    toast('เลือกรูปสินค้าแล้ว');
  }catch(e){ console.error(e); state.newProductImage=null; toast('เตรียมรูปสินค้าไม่สำเร็จ'); }
  finally{ if(input) input.value=''; }
};
window.clearNewProductImage=()=>{
  state.newProductImage=null;
  const img=$('newProductImagePreview'),wrap=$('newProductImagePreviewWrap');
  if(img) img.removeAttribute('src');
  wrap?.classList.add('hidden');
};

window.saveNewProduct=async()=>{
  const lockKey='saveNewProduct';
  if(!beginActionLock(lockKey,'saveNewProductBtn','กำลังบันทึก...')) return;
  const name=$('pn').value.trim(),sku=$('ps').value.trim();
  if(!name){ endActionLock(lockKey,'saveNewProductBtn'); return toast('กรอกชื่อสินค้า'); }
  if(sku&&hasDuplicateSkuLocal(sku)){ endActionLock(lockKey,'saveNewProductBtn'); showSkuDuplicateError(sku); return; }
  const productDoc=doc(userPath('products')),logDoc=doc(logRef()),auditDoc=doc(auditRef()),eventId=makeEventId('PRODUCT');
  const product={name,sku,skuKey:normalizeSkuKey(sku),category:$('pc').value,unit:$('pu').value||'ชิ้น',stock:Number($('pq').value)||0,min:Number($('pm').value)||0,archived:false,photo:'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()};
  try{
    await runTransaction(fs,async tx=>{
      let regRef=null,regSnap=null;
      if(sku){ regRef=skuRegistryDocRef(sku); regSnap=await tx.get(regRef); if(regSnap.exists()) throw new Error('SKU ซ้ำ — มีสินค้าอื่นใช้รหัสนี้แล้ว'); }
      tx.set(productDoc,product);
      if(regRef) tx.set(regRef,{sku:sku,skuKey:normalizeSkuKey(sku),productId:productDoc.id,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      tx.set(logDoc,logPayload('เพิ่มสินค้า',name,{productId:productDoc.id,eventId}));
      tx.set(auditDoc,auditPayload('เพิ่มสินค้า',name,{productId:productDoc.id,eventId,logId:logDoc.id}));
    });
    const pendingImage=state.newProductImage;
    if(pendingImage){
      try{
        const uploaded=await uploadProductImage(productDoc.id,pendingImage,'');
        await updateDoc(productDoc,{photo:uploaded.url,photoPath:uploaded.path,updatedAt:serverTimestamp()});
      }catch(imageErr){
        console.error('อัปโหลดรูปสินค้าใหม่ไม่สำเร็จ',imageErr);
        hideModal();
        state.newProductImage=null;
        toast('เพิ่มสินค้าแล้ว แต่รูปอัปโหลดไม่สำเร็จ สามารถเพิ่มรูปภายหลังได้');
        return;
      }
    }
    state.newProductImage=null;
    hideModal(); toast(pendingImage?'เพิ่มสินค้าและรูปเรียบร้อย':'เพิ่มสินค้าแล้ว');
  }catch(e){ console.error(e); if(isSkuDuplicateError(e)) showSkuDuplicateError(sku,e); else toast(e?.message||'เพิ่มสินค้าไม่สำเร็จ'); }
  finally{ endActionLock(lockKey,'saveNewProductBtn'); }
};
window.adjustStock=(id)=>{
  if(!canAdjustStock()) return toast('คุณไม่มีสิทธิ์ปรับยอดสต๊อก');
  const p=state.products.find(x=>x.id===id); if(!p) return;
  openModal('⚖️ ปรับยอดสต๊อก',`
    <div class="card" style="box-shadow:none;background:#f8fafc"><b>${escapeHtml(p.name)}</b><div class="muted">ยอดปัจจุบัน ${Number(p.stock)||0} ${escapeHtml(p.unit||'หน่วย')}</div></div>
    <label class="field-label" for="adjustNewStock">ยอดใหม่</label>
    <input id="adjustNewStock" type="number" min="0" step="1" value="${Number(p.stock)||0}">
    <label class="field-label" for="adjustReason">เหตุผลในการปรับยอด</label>
    <select id="adjustPreset" onchange="window.fillAdjustReason()">
      <option value="">เลือกเหตุผล</option><option>ตรวจนับสต๊อกจริง</option><option>สินค้าเสียหาย/ชำรุด</option><option>แก้ไขข้อมูลผิด</option><option>สูญหาย</option><option>อื่น ๆ</option>
    </select>
    <input id="adjustReason" placeholder="กรุณาระบุเหตุผล">
    <button class="btn primary full" onclick="window.saveStockAdjustment('${id}')">บันทึกการปรับยอด</button>`);
};
window.fillAdjustReason=()=>{ const v=$('adjustPreset')?.value||''; if(v && v!=='อื่น ๆ') $('adjustReason').value=v; };
window.saveStockAdjustment=async(id)=>{
  if(!canAdjustStock()) return toast('คุณไม่มีสิทธิ์ปรับยอดสต๊อก');
  const cached=state.products.find(x=>x.id===id); if(!cached) return;
  const newStock=Number($('adjustNewStock').value),reason=($('adjustReason').value||'').trim();
  if(!Number.isFinite(newStock)||newStock<0) return toast('ยอดใหม่ต้องเป็น 0 หรือมากกว่า');
  if(!reason) return toast('กรุณาระบุเหตุผล');
  try{
    await runTransaction(fs,async tx=>{
      const pRef=productRef(id),snap=await tx.get(pRef);
      if(!snap.exists()) throw new Error('ไม่พบสินค้า');
      const p=snap.data(),oldStock=Number(p.stock)||0;
      if(newStock===oldStock) throw new Error('ยอดใหม่เท่ากับยอดเดิม');
      const eventId=makeEventId('ADJ'),detail=p.name||cached.name||'สินค้า';
      const extra={productId:id,previousStock:oldStock,newStock,unit:p.unit||'หน่วย',reason,changes:[`จำนวนคงเหลือ: ${oldStock} → ${newStock}`],eventId};
      const logDoc=doc(logRef()),auditDoc=doc(auditRef());
      tx.update(pRef,{stock:newStock,updatedAt:serverTimestamp(),lastAdjustedAt:serverTimestamp(),lastAdjustedBy:state.user.uid,lastAdjustedReason:reason});
      tx.set(logDoc,logPayload('ปรับยอดสินค้า',detail,extra));
      tx.set(auditDoc,auditPayload('ปรับยอดสินค้า',detail,{...extra,logId:logDoc.id}));
    });
    hideModal(); toast('ปรับยอดและบันทึกประวัติแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'ปรับยอดไม่สำเร็จ'); }
};
window.editProduct=(id)=>{ if(!requireManager()) return; const p=state.products.find(x=>x.id===id); openModal('แก้ไขสินค้า',`
  <label class="field-label" for="pn">ชื่อสินค้า</label>
  <span class="field-hint">ชื่อที่จะแสดงในรายการ Stock เช่น ถุงใส่แก้วกาแฟคู่</span>
  <input id="pn" value="${escapeHtml(p.name)}" placeholder="เช่น ถุงใส่แก้วกาแฟคู่">

  <label class="field-label" for="ps">รหัสสินค้า (SKU)</label>
  <span class="field-hint">รหัสอ้างอิงภายใน ไม่บังคับ เว้นว่างได้</span>
  <input id="ps" value="${escapeHtml(p.sku||'')}" placeholder="ไม่บังคับ" oninput="window.validateSkuField('${id}')" onblur="window.validateSkuField('${id}')">
  <div id="skuInlineError" class="sku-inline-error hidden" role="alert"></div>

  <label class="field-label" for="pc">หมวดหมู่</label>
  <span class="field-hint">ใช้จัดกลุ่มสินค้า เช่น บรรจุภัณฑ์, วัตถุดิบ, อุปกรณ์</span>
  <input id="pc" value="${escapeHtml(p.category||'')}" placeholder="เช่น บรรจุภัณฑ์">

  <label class="field-label" for="pu">หน่วยนับ</label>
  <span class="field-hint">หน่วยที่ใช้นับสต๊อก เช่น แพ็ค, ชิ้น, กระป๋อง, ใบ</span>
  <input id="pu" value="${escapeHtml(p.unit||'')}" placeholder="เช่น แพ็ค">

  <label class="field-label" for="pm">จุดเตือนสต๊อกต่ำ</label>
  <span class="field-hint">ระบบจะแจ้งเตือน "ใกล้หมด" เมื่อคงเหลือน้อยกว่าหรือเท่ากับจำนวนนี้ ใส่ 0 หากไม่ต้องการเตือน</span>
  <input id="pm" type="number" value="${p.min||0}" placeholder="เช่น 5">

  <button id="saveEditProductBtn" class="btn primary full" onclick="window.saveEditProduct('${id}')">บันทึก</button>
  <button class="btn red full" onclick="window.deleteProduct('${id}')">🗑️ ลบสินค้า (ย้ายไปถังขยะ)</button>
`); };
window.saveEditProduct=async(id)=>{
  const lockKey=`saveEditProduct:${id}`;
  if(!beginActionLock(lockKey,'saveEditProductBtn','กำลังบันทึก...')) return;
  const p=state.products.find(x=>x.id===id);
  const sku=$('ps').value.trim();
  if(sku && hasDuplicateSkuLocal(sku,id)){ endActionLock(lockKey,'saveEditProductBtn'); showSkuDuplicateError(sku); return; }
  const name=$('pn').value.trim();
  const category=$('pc').value;
  const unit=$('pu').value;
  const min=Number($('pm').value)||0;
  const FIELD_LABELS={name:'ชื่อสินค้า',sku:'รหัสสินค้า (SKU)',category:'หมวดหมู่',unit:'หน่วยนับ',min:'จุดเตือนสต๊อกต่ำ'};
  const before={name:p.name||'',sku:p.sku||'',category:p.category||'',unit:p.unit||'',min:p.min||0};
  const after={name,sku,category,unit,min};
  const changes=[];
  for(const key of Object.keys(FIELD_LABELS)){
    const oldVal=before[key], newVal=after[key];
    if(String(oldVal)!==String(newVal)) changes.push(`${FIELD_LABELS[key]}: "${oldVal||'-'}" → "${newVal||'-'}"`);
  }
  if(!changes.length){ endActionLock(lockKey,'saveEditProductBtn'); return toast('ไม่มีการเปลี่ยนแปลงข้อมูล'); }
  const eventId=makeEventId('PRODUCT'),logDoc=doc(logRef()),auditDoc=doc(auditRef());
  try{
    await runTransaction(fs,async tx=>{
      const newKey=normalizeSkuKey(sku),oldKey=normalizeSkuKey(p.sku||'');
      let newRegRef=null,newRegSnap=null;
      if(newKey && newKey!==oldKey){ newRegRef=skuRegistryDocRef(sku); newRegSnap=await tx.get(newRegRef); if(newRegSnap.exists() && newRegSnap.data().productId!==id) throw new Error('SKU ซ้ำ — มีสินค้าอื่นใช้รหัสนี้แล้ว'); }
      tx.update(productRef(id),{name,sku,skuKey:newKey,category,unit,min,updatedAt:serverTimestamp()});
      if(oldKey && oldKey!==newKey) tx.delete(skuRegistryDocRef(p.sku||''));
      if(newRegRef) tx.set(newRegRef,{sku,skuKey:newKey,productId:id,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      tx.set(logDoc,logPayload('แก้ไขสินค้า',name,{productId:id,changes,eventId}));
      tx.set(auditDoc,auditPayload('แก้ไขสินค้า',name,{productId:id,changes,eventId,logId:logDoc.id}));
    });
    hideModal(); toast('แก้ไขสินค้าแล้ว');
  }catch(e){ console.error(e); if(isSkuDuplicateError(e)) showSkuDuplicateError(sku,e); else toast(e?.message||'แก้ไขสินค้าไม่สำเร็จ'); }
  finally{ endActionLock(lockKey,'saveEditProductBtn'); }
};window.deleteProduct=async(id)=>{ if(!requireManager()) return; if(state.approvals.some(a=>a.productId===id)) return toast('มีรายการรอตรวจ ลบไม่ได้'); if(!confirm('ย้ายสินค้านี้ไปถังขยะ? (กู้คืนได้ทีหลังในหน้าโปรไฟล์)'))return; const p=state.products.find(x=>x.id===id); await updateDoc(productRef(id),{trashed:true,trashedAt:serverTimestamp(),updatedAt:serverTimestamp()}); await addLog('ย้ายไปถังขยะ',p.name,{productId:id}); toast('ย้ายไปถังขยะแล้ว กู้คืนได้ในโปรไฟล์'); hideModal(); };
window.archiveProduct=async(id)=>{ if(!requireManager()) return; if(state.approvals.some(a=>a.productId===id)) return toast('มีรายการรอตรวจ Archive ไม่ได้'); const p=state.products.find(x=>x.id===id); await updateDoc(productRef(id),{archived:true,updatedAt:serverTimestamp()}); await addLog('Archive',p.name,{productId:id}); };

window.stockMove=(id,type)=>{ const p=state.products.find(x=>x.id===id); state.tempMoveImage=null; const locationHtml=type==='in'
  ? `<div class="card" style="margin:8px 0;box-shadow:none;border:1px solid #bbf7d0;background:#f0fdf4"><div class="muted">สถานที่รับเข้า</div><b style="font-size:20px;color:#15803d">📍 ${STORE_LOCATION}</b></div>`
  : locationFieldHtml('moveLoc','moveLocOther');
  openModal(type==='in'?'รับเข้า':'เบิกออก',`<p><b>${escapeHtml(p.name)}</b></p><input id="qty" type="number" placeholder="จำนวน">${locationHtml}<textarea id="reason" placeholder="เหตุผล/หมายเหตุ"></textarea><input id="movePhotoInput" type="file" accept="image/*" class="hidden"><button class="btn light full" onclick="movePhotoInput.click()">📷 แนบรูป (ไม่บังคับ)</button><div id="movePhotoPreview"></div><button class="btn primary full" onclick="window.applyStock('${id}','${type}')">ยืนยัน</button>`);
  $('movePhotoInput').onchange = async (e)=>{ const f=e.target.files[0]; if(!f) return; state.tempMoveImage = await compressImage(f); $('movePhotoPreview').innerHTML = `<img class="preview" src="${state.tempMoveImage}" style="max-height:160px">`; };
};
window.applyStock=async(id,type)=>{
  const q=Number($('qty').value)||0;
  if(q<=0) return toast('จำนวนไม่ถูกต้อง');
  const reason=($('reason').value||'').trim();
  const location=type==='in'?STORE_LOCATION:getLocationValue('moveLoc','moveLocOther');
  if(type==='out'&&!location){ endActionLock(lockKey,'sendApprovalBtn'); return toast('กรุณาเลือกสถานที่เบิก'); }
  try{
    await runTransaction(fs,async tx=>{
      const ref=productRef(id),snap=await tx.get(ref);
      if(!snap.exists()) throw new Error('ไม่พบสินค้า');
      const p=snap.data(),current=Number(p.stock)||0;
      if(type==='out'&&q>current) throw new Error('เบิกเกินสต๊อก');
      const newStock=type==='in'?current+q:current-q;
      const eventId=makeEventId(type==='in'?'IN':'OUT');
      const action=type==='in'?'รับเข้า':'เบิกออก';
      const detail=`${p.name||''} ${q} ${p.unit||''}${reason?' • '+reason:''}`;
      const extra={productId:id,qty:q,unit:p.unit||'',photo:state.tempMoveImage||'',location,moveType:type,previousStock:current,newStock,eventId};
      const logDoc=doc(logRef()),auditDoc=doc(auditRef());
      tx.update(ref,{stock:newStock,updatedAt:serverTimestamp()});
      tx.set(logDoc,logPayload(action,detail,extra));
      tx.set(auditDoc,auditPayload(action,detail,{...extra,logId:logDoc.id}));
    });
    state.tempMoveImage=null; hideModal(); toast('บันทึกสต๊อกและประวัติแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'บันทึกสต๊อกไม่สำเร็จ'); }
};

function getActiveProductsForSearch(){
  return state.products
    .filter(p=>!p.archived && !p.trashed)
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'th'));
}
function scanProductSearchText(p){
  return [p.name,p.sku,p.category,p.unit]
    .map(v=>String(v||'').toLowerCase())
    .join(' ');
}
function renderScanProductResults(queryText=''){
  const box=$('scanProductResults');
  if(!box) return;
  const q=String(queryText||'').trim().toLowerCase();
  const products=getActiveProductsForSearch();
  const matches=(q ? products.filter(p=>scanProductSearchText(p).includes(q)) : products).slice(0,12);
  if(!matches.length){
    box.innerHTML='<div class="muted" style="padding:12px">ไม่พบสินค้าใน Stock</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML=matches.map(p=>`<button type="button" class="scan-product-result" onclick="window.selectScanProduct('${p.id}')">
    ${p.photo?`<img src="${p.photo}" alt="">`:`<span class="scan-product-result-icon">📦</span>`}
    <span class="scan-product-result-main">
      <b>${escapeHtml(p.name)}</b>
      <small>${escapeHtml(p.sku||'-')} • คงเหลือ ${Number(p.stock)||0} ${escapeHtml(p.unit||'')}</small>
    </span>
  </button>`).join('');
  box.classList.remove('hidden');
}
window.searchScanProducts=(value)=>{
  const hidden=$('scanProduct');
  if(hidden) hidden.value='';
  const selected=$('scanProductSelected');
  if(selected) selected.innerHTML='';
  renderScanProductResults(value);
};
window.openScanProductResults=()=>{
  renderScanProductResults($('scanProductSearch')?.value||'');
};
window.selectScanProduct=(id)=>{
  const p=state.products.find(x=>x.id===id);
  if(!p) return;
  $('scanProduct').value=id;
  $('scanProductSearch').value=p.name||'';
  $('scanProductResults').classList.add('hidden');
  $('scanProductSelected').innerHTML=`<div class="scan-selected-product"><span>✅ เลือกแล้ว</span><b>${escapeHtml(p.name)}</b><small>คงเหลือ ${Number(p.stock)||0} ${escapeHtml(p.unit||'')}</small></div>`;
  const unitLabel=$('newItemUnitLabel');
  if(unitLabel) unitLabel.textContent=p.unit||'หน่วย';
  saveNewItemDraft();
  $('scanQty')?.focus();
};

function getNewItemDraftFromForm(){
  const productId=$('scanProduct')?.value||'';
  const productSearch=$('scanProductSearch')?.value||'';
  const qty=$('scanQty')?.value||'';
  const note=$('scanNote')?.value||'';
  const type=state.newItemType||$('scanType')?.value||'out';
  const location=type==='in'?STORE_LOCATION:getLocationValue('scanLoc','scanLocOther');
  const hasData=Boolean(productId||productSearch.trim()||qty||note.trim()||state.selectedImage||(type==='out'&&location));
  return {hasData,productId,productSearch,qty,note,type,location,image:state.selectedImage||'',savedAt:Date.now()};
}
function saveNewItemDraft(){
  if(restoringNewItemDraft) return;
  const draft=getNewItemDraftFromForm();
  if(draft.hasData) localStorage.setItem(NEW_ITEM_DRAFT_KEY,JSON.stringify(draft));
  else localStorage.removeItem(NEW_ITEM_DRAFT_KEY);
}
function readNewItemDraft(){
  try{ return JSON.parse(localStorage.getItem(NEW_ITEM_DRAFT_KEY)||'null'); }catch{return null;}
}
function clearNewItemDraft(){ localStorage.removeItem(NEW_ITEM_DRAFT_KEY); }
function applyNewItemDraft(draft){
  if(!draft) return;
  restoringNewItemDraft=true;
  state.newItemType=draft.type==='in'?'in':'out';
  state.selectedImage=draft.image||null;
  renderScan();
  const p=state.products.find(x=>x.id===draft.productId);
  if(p){
    const hidden=$('scanProduct'); if(hidden) hidden.value=p.id;
    const search=$('scanProductSearch'); if(search) search.value=p.name||draft.productSearch||'';
    const selected=$('scanProductSelected'); if(selected) selected.innerHTML=`<div class="scan-selected-product"><span>✅ เลือกแล้ว</span><b>${escapeHtml(p.name)}</b><small>คงเหลือ ${Number(p.stock)||0} ${escapeHtml(p.unit||'')}</small></div>`;
    const unitLabel=$('newItemUnitLabel'); if(unitLabel) unitLabel.textContent=p.unit||'หน่วย';
  }else if($('scanProductSearch')) $('scanProductSearch').value=draft.productSearch||'';
  if($('scanQty')) $('scanQty').value=draft.qty||'';
  if($('scanNote')) $('scanNote').value=draft.note||'';
  if(draft.type==='out' && draft.location && $('scanLoc')){
    const options=[...$('scanLoc').options].map(o=>o.value);
    if(options.includes(draft.location)) $('scanLoc').value=draft.location;
    else { $('scanLoc').value='อื่นๆ'; window.toggleLocationOther('scanLoc','scanLocOther'); if($('scanLocOther')) $('scanLocOther').value=draft.location; }
  }
  restoringNewItemDraft=false;
  toast('กู้คืนข้อมูลที่ยังไม่บันทึกแล้ว');
}
function maybePromptNewItemDraft(){
  if(newItemDraftPromptChecked) return;
  newItemDraftPromptChecked=true;
  const draft=readNewItemDraft();
  if(!draft?.hasData) return;
  setTimeout(()=>{
    const continueDraft=window.confirm('พบข้อมูลเบิก/รับสินค้าที่ยังไม่ได้บันทึก\nต้องการกลับไปทำรายการต่อหรือไม่?');
    if(continueDraft) applyNewItemDraft(draft); else clearNewItemDraft();
  },120);
}
function bindNewItemDraftListeners(){
  ['scanProductSearch','scanQty','scanNote','scanLoc','scanLocOther'].forEach(id=>{
    const el=$(id); if(!el) return;
    el.addEventListener('input',saveNewItemDraft);
    el.addEventListener('change',saveNewItemDraft);
  });
}

function renderScan(){
  const currentType=state.newItemType||'out';
  const isOut=currentType==='out';

  view.innerHTML=`<div class="between">
      <h1>เบิก/รับสินค้า</h1>
      <button class="btn small" onclick="window.goToPage('home')">← กลับ</button>
    </div>

    <div class="new-item-tabs" role="tablist">
      <button type="button" class="new-item-tab ${isOut?'active out':'out'}" onclick="window.setNewItemType('out')">↑ เบิกสินค้า</button>
      <button type="button" class="new-item-tab ${!isOut?'active in':'in'}" onclick="window.setNewItemType('in')">↓ รับสินค้า</button>
    </div>

    <section class="card new-item-form-card">
      <div class="new-item-section-title">${isOut?'สินค้าที่ต้องการเบิก':'สินค้าที่ต้องการรับเข้า'}</div>

      <div class="scan-product-search-wrap">
        <input id="scanProductSearch"
          class="new-item-input"
          placeholder="🔍 ค้นหาสินค้า หรือพิมพ์ชื่อ / SKU"
          autocomplete="off"
          onfocus="window.openScanProductResults()"
          oninput="window.searchScanProducts(this.value)">
        <input id="scanProduct" type="hidden" value="">
        <div id="scanProductResults" class="scan-product-results hidden"></div>
        <div id="scanProductSelected"></div>
      </div>

      <label class="new-item-label" for="scanQty">จำนวน</label>
      <div class="new-item-qty-wrap">
        <input id="scanQty" class="new-item-input" type="number" min="1" inputmode="numeric" placeholder="ระบุจำนวน">
        <span id="newItemUnitLabel" class="new-item-unit">หน่วย</span>
      </div>

      <div id="scanLocationSection">
        ${isOut?`
          <label class="new-item-label">สถานที่เบิก</label>
          <div id="scanLocationWrap">${locationFieldHtml('scanLoc','scanLocOther')}</div>
        `:`
          <label class="new-item-label">สถานที่รับเข้า</label>
          <div class="new-item-fixed-location">📍 ${STORE_LOCATION}</div>
          <div id="scanLocationWrap" class="hidden"></div>
        `}
      </div>

      <label class="new-item-label" for="scanNote">หมายเหตุ <span class="muted">(ถ้ามี)</span></label>
      <textarea id="scanNote" class="new-item-input new-item-note" placeholder="ระบุหมายเหตุเพิ่มเติม (ถ้ามี)"></textarea>

      <details class="new-item-attachment">
        <summary>📷 แนบรูปหลักฐาน <span class="muted">(ไม่บังคับ)</span></summary>
        <div class="new-item-attachment-body">
          <p class="muted" style="margin-top:0">ใช้สำหรับแนบรูปสินค้าหรือเอกสารประกอบรายการ</p>
          <div class="grid">
            <button type="button" class="btn primary" onclick="cameraInput.click()">📷 ถ่ายรูป</button>
            <button type="button" class="btn" onclick="photoInput.click()">🖼️ เลือกจากคลังรูป</button>
          </div>
          ${state.selectedImage?`<img class="preview" src="${state.selectedImage}" alt="รูปหลักฐานที่แนบ">`:''}
        </div>
      </details>

      <button id="sendApprovalBtn" type="button" class="new-item-submit ${isOut?'out':'in'}" onclick="window.sendApproval()">
        ${isOut?'✈ ส่งคำขอเบิกสินค้า':'✓ ส่งคำขอรับสินค้า'}
      </button>
    </section>

    <div class="new-item-info">
      ℹ️ คำขอของคุณจะถูกส่งเพื่อรอการอนุมัติ และสามารถแก้ไขหรือยกเลิกได้ก่อนอนุมัติ
    </div>`;

  // Keep type in a hidden field for existing sendApproval logic.
  const hiddenType=document.createElement('select');
  hiddenType.id='scanType';
  hiddenType.className='hidden';
  hiddenType.innerHTML=`<option value="out">เบิกออก</option><option value="in">รับเข้า</option>`;
  hiddenType.value=currentType;
  view.appendChild(hiddenType);
  bindNewItemDraftListeners();
  maybePromptNewItemDraft();
}

window.setNewItemType=(type)=>{
  saveNewItemDraft();
  state.newItemType=type==='in'?'in':'out';
  saveUiState();
  renderScan();
  const draft=readNewItemDraft(); if(draft) applyNewItemDraft({...draft,type:state.newItemType});
};

window.updateScanLocation=()=>{ const wrap=$('scanLocationWrap'), type=$('scanType')?.value; if(!wrap) return; wrap.innerHTML=type==='in' ? `<div class="card" style="margin:8px 0;box-shadow:none;border:1px solid #bbf7d0;background:#f0fdf4"><div class="muted">สถานที่รับเข้าอัตโนมัติ</div><b style="font-size:20px;color:#15803d">📍 ${STORE_LOCATION}</b></div>` : locationFieldHtml('scanLoc','scanLocOther'); };
['cameraInput','photoInput'].forEach(id=>$(id).onchange=async e=>{ const f=e.target.files[0]; if(!f) return; const existing=getNewItemDraftFromForm(); state.selectedImage = await compressImage(f); e.target.value=''; localStorage.setItem(NEW_ITEM_DRAFT_KEY,JSON.stringify({...existing,image:state.selectedImage,hasData:true,savedAt:Date.now()})); renderScan(); applyNewItemDraft(readNewItemDraft()); toast('เลือกรูปแล้ว (บีบอัดอัตโนมัติ)'); });
// ส่งตรวจ: เก็บ logId ไว้ในตัว approval เพื่อไปอัปเดตสถานะ log เดิมตอนอนุมัติ/ปฏิเสธ แทนการสร้าง log ใหม่ซ้ำซ้อน
window.sendApproval=async()=>{
  const lockKey='sendApproval';
  if(!beginActionLock(lockKey,'sendApprovalBtn','กำลังส่งคำขอ...')) return;
  const productId=$('scanProduct')?.value||'';
  const qty=Number($('scanQty')?.value)||0;
  const type=state.newItemType||$('scanType')?.value||'out';
  const location=type==='in'?STORE_LOCATION:getLocationValue('scanLoc','scanLocOther');
  const note=($('scanNote')?.value||'').trim();
  if(!productId){ endActionLock(lockKey,'sendApprovalBtn'); return toast('เลือกสินค้าก่อน'); }
  if(qty<=0){ endActionLock(lockKey,'sendApprovalBtn'); return toast('กรอกจำนวน'); }
  if(type==='out'&&!location) return toast('กรุณาเลือกสถานที่เบิก');
  const p=state.products.find(x=>x.id===productId);
  if(!p){ endActionLock(lockKey,'sendApprovalBtn'); return toast('ไม่พบสินค้า'); }
  if(type==='out'&&qty>Number(p.stock)){ endActionLock(lockKey,'sendApprovalBtn'); return toast('เบิกเกินสต๊อก'); }
  const eventId=makeEventId('REQ');
  const detail=`${type==='out'?'เบิก':'รับ'} ${p.name} ${qty} ${p.unit}${note?` • ${note}`:''}`;
  const logDoc=doc(logRef()),approvalDoc=doc(userPath('approvals')),auditDoc=doc(auditRef());
  const batch=writeBatch(fs);
  const common={productId,qty,unit:p.unit,photo:state.selectedImage||'',location,moveType:type,note,eventId};
  batch.set(logDoc,logPayload('ส่งตรวจ',detail,{...common,status:'pending',approvalId:approvalDoc.id}));
  batch.set(approvalDoc,{productId,name:p.name,qty,unit:p.unit,type,location,note,img:state.selectedImage||'',confidence:state.selectedImage?60:0,status:'pending',logId:logDoc.id,eventId,submittedByUid:state.user?.uid||'',submittedByName:state.profile?.displayName||state.profile?.username||'',submittedByPhoto:state.profile?.photoURL||'',createdAt:serverTimestamp()});
  batch.set(auditDoc,auditPayload('ส่งตรวจ',detail,{...common,approvalId:approvalDoc.id,logId:logDoc.id,eventId}));
  try{
    await batch.commit();
    state.selectedImage=null; clearNewItemDraft(); renderScan(); toast('ส่งคำขอรออนุมัติแล้ว');
  }catch(e){ console.error(e); toast('ส่งรายการไม่สำเร็จ และไม่มีข้อมูลบางส่วนถูกบันทึก'); }
  finally{ endActionLock(lockKey,'sendApprovalBtn'); }
};
function renderApproval(){
  const canReview=canApprove();
  const heading=canReview?'รายการรออนุมัติ':'รายการของฉัน';
  const note=canReview
    ? 'คุณสามารถตรวจสอบ แก้ไข อนุมัติ หรือปฏิเสธรายการได้'
    : 'คุณสามารถตรวจสอบ แก้ไข หรือยกเลิกรายการของตัวเองได้ แต่ไม่มีสิทธิ์อนุมัติ';

  view.innerHTML=`<div class="between">
      <h1>${heading}</h1>
      <button class="btn small" onclick="window.goToPage('home')">← กลับ</button>
    </div>
    <div class="card note">${note}</div>
    ${state.approvals.map(a=>{
      const own=isOwnApproval(a);
      return `<div class="card approval-card">
        <div class="approval-head">
          <div class="approval-title-wrap">
            <h2 class="approval-title">${escapeHtml(a.name)}</h2>
            <span class="pill ${a.type==='out'?'warn':'ok'} approval-type">${a.type==='out'?'↑ เบิกออก':'↓ รับเข้า'}</span>
          </div>
          ${canReview?'':`<span class="pill warn approval-status">รออนุมัติ</span>`}
        </div>

        ${canReview?`<div class="approval-sender-card">
          <div class="approval-sender-avatar">${a.submittedByPhoto?`<img src="${a.submittedByPhoto}" alt="ผู้ส่ง">`:'👤'}</div>
          <div class="approval-sender-copy">
            <span>ผู้ส่งรายการ</span>
            <b>${escapeHtml(a.submittedByName||'-')}</b>
          </div>
          <div class="approval-sender-status">
            <span>⏳ รออนุมัติ</span>
          </div>
        </div>`:''}

        <div class="approval-info-grid">
          <div class="approval-info approval-qty">
            <div class="approval-icon approval-icon-blue">📦</div>
            <div>
              <div class="approval-label">จำนวน</div>
              <div class="approval-value">${Number(a.qty)||0} <span>${escapeHtml(a.unit||'')}</span></div>
            </div>
          </div>
          <div class="approval-info approval-location">
            <div class="approval-icon approval-icon-green">📍</div>
            <div>
              <div class="approval-label">${a.type==='out'?'สถานที่เบิก':'สถานที่รับ'}</div>
              <div class="approval-location-value">${escapeHtml(a.location||(a.type==='in'?STORE_LOCATION:'ไม่ระบุสถานที่'))}</div>
            </div>
          </div>
        </div>

        ${a.img?`<img class="preview" src="${a.img}">`:''}

        ${canReview?`<div class="approval-actions">
          <button class="btn green" onclick="window.confirmApprove('${a.id}')">✓ อนุมัติ</button>
          <button class="btn" onclick="window.editApproval('${a.id}')">✎ แก้ไข</button>
          <button class="btn red" onclick="window.confirmReject('${a.id}')">✕ ปฏิเสธ</button>
        </div>`:(own?`<div class="approval-actions own-approval-actions">
          <button type="button" class="own-action-btn own-action-edit" onclick="window.editApproval('${a.id}')">
            <span class="own-action-icon">✎</span><span class="own-action-label">แก้ไขรายการ</span>
          </button>
          <button type="button" class="own-action-btn own-action-cancel" onclick="window.confirmCancelApproval('${a.id}')">
            <span class="own-action-icon">🗑</span><span class="own-action-label">ยกเลิกรายการ</span>
          </button>
        </div>`:'')}
      </div>`;
    }).join('')||'<div class="card" style="text-align:center"><p style="font-size:40px;margin:0 0 6px">✅</p><p class="muted" style="margin:0">ไม่มีรายการรออนุมัติ</p></div>'}`;
}
function approvalDetailHtml(a, opts={}){
  const p = state.products.find(x=>x.id===a.productId);
  let stockLine = '';
  if(opts.showStockPreview && p){
    const current = Number(p.stock)||0;
    const after = a.type==='out' ? current-Number(a.qty) : current+Number(a.qty);
    const short = a.type==='out' && after<0;
    stockLine = `<p class="muted" style="font-size:13px;margin:8px 0 0;padding-top:8px;border-top:1px solid var(--line)">
      คงเหลือตอนนี้ <b>${current} ${escapeHtml(p.unit||'')}</b> → หลังอนุมัติเหลือ <b style="color:${short?'#dc2626':'#0f172a'}">${after} ${escapeHtml(p.unit||'')}</b>${short?' ⚠️ ไม่พอ':''}
    </p>`;
  }
  return `<div class="card" style="margin:0 0 12px;box-shadow:none;border:1px solid #e5e7eb">
    <h2 style="margin-top:0">${escapeHtml(a.name)}</h2>
    <p class="muted"><span class="pill ${a.type==='out'?'warn':'ok'}">${a.type==='out'?'↑ เบิกออก':'↓ รับเข้า'}</span> ${a.qty} ${escapeHtml(a.unit||'')}</p>
    ${a.location?`<p class="muted" style="font-size:13px;margin:2px 0 0">📍 ${escapeHtml(a.location)}</p>`:''}
    ${a.img?`<img class="preview" src="${a.img}">`:''}
    ${stockLine}
  </div>`;
}
window.confirmApprove=(id)=>{ if(!requireApprover()) return; const a=state.approvals.find(x=>x.id===id); if(!a) return toast('ไม่พบรายการ'); openModal('ยืนยันอนุมัติ', `${approvalDetailHtml(a,{showStockPreview:true})}<button id="confirmApproveBtn" class="btn green full" onclick="window.approve('${id}')">✅ ยืนยันอนุมัติ</button>`); };
window.confirmReject=(id)=>{ if(!requireApprover()) return; const a=state.approvals.find(x=>x.id===id); if(!a) return toast('ไม่พบรายการ'); openModal('ยืนยันปฏิเสธ', `${approvalDetailHtml(a)}<button id="confirmRejectBtn" class="btn red full" onclick="window.reject('${id}')">✖️ ยืนยันปฏิเสธ</button>`); };
window.approve=async(id)=>{
  if(!requireApprover()) return;
  const lockKey=`approve:${id}`;
  if(!beginActionLock(lockKey,'confirmApproveBtn','กำลังอนุมัติ...')) return;
  const cached=state.approvals.find(x=>x.id===id);
  if(!cached){ endActionLock(lockKey,'confirmApproveBtn'); return toast('ไม่พบรายการ'); }
  try{
    await runTransaction(fs,async tx=>{
      const pRef=productRef(cached.productId),aRef=approvalRef(id);
      const [pSnap,aSnap]=await Promise.all([tx.get(pRef),tx.get(aRef)]);
      if(!pSnap.exists()) throw new Error('ไม่พบสินค้า');
      if(!aSnap.exists()) throw new Error('รายการนี้ถูกดำเนินการแล้ว');
      const a={id,...aSnap.data()},p=pSnap.data(),current=Number(p.stock)||0,qty=Number(a.qty)||0;
      if(a.type==='out'&&qty>current) throw new Error('เบิกเกินสต๊อก');
      const newStock=a.type==='out'?current-qty:current+qty;
      const reviewerUid=state.user?.uid||'',reviewerName=state.profile?.displayName||state.profile?.username||'ไม่ทราบผู้ใช้';
      const eventId=a.eventId||makeEventId('APR');
      const detail=`${a.type==='out'?'เบิก':'รับ'} ${a.name} ${a.qty} ${a.unit}`;
      const finalFields={action:'อนุมัติ',detail,time:new Date().toLocaleString('th-TH'),updatedAt:serverTimestamp(),location:a.type==='in'?STORE_LOCATION:(a.location||''),reviewerUid,reviewerName,submittedByUid:a.submittedByUid||'',submittedByName:a.submittedByName||'',productId:a.productId,qty:a.qty,unit:a.unit,moveType:a.type,photo:a.img||'',eventId,status:'approved',previousStock:current,newStock};
      // Firestore requires every transaction read to happen before the first write.
      // Resolve the legacy/history log first, then perform all writes atomically.
      let logId=a.logId||'';
      let lRef=null,lSnap=null;
      if(logId){ lRef=logDocRef(logId); lSnap=await tx.get(lRef); }
      tx.update(pRef,{stock:newStock,updatedAt:serverTimestamp()});
      if(logId && lSnap?.exists()) tx.update(lRef,finalFields);
      else { const fallback=doc(logRef()); logId=fallback.id; tx.set(fallback,logPayload('อนุมัติ',detail,finalFields)); }
      const auditDoc=doc(auditRef());
      tx.set(auditDoc,auditPayload('อนุมัติ',detail,{...finalFields,approvalId:id,logId,eventId}));
      tx.delete(aRef);
    });
    hideModal(); toast('อนุมัติแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'อนุมัติไม่สำเร็จ'); }
  finally{ endActionLock(lockKey,'confirmApproveBtn'); }
};
window.reject=async(id)=>{
  if(!requireApprover()) return;
  const lockKey=`reject:${id}`;
  if(!beginActionLock(lockKey,'confirmRejectBtn','กำลังปฏิเสธ...')) return;
  const cached=state.approvals.find(x=>x.id===id);
  if(!cached){ endActionLock(lockKey,'confirmRejectBtn'); return toast('ไม่พบรายการ'); }
  try{
    await runTransaction(fs,async tx=>{
      const aRef=approvalRef(id),aSnap=await tx.get(aRef);
      if(!aSnap.exists()) throw new Error('รายการนี้ถูกดำเนินการแล้ว');
      const a={id,...aSnap.data()};
      const reviewerUid=state.user?.uid||'',reviewerName=state.profile?.displayName||state.profile?.username||'ไม่ทราบผู้ใช้';
      const eventId=a.eventId||makeEventId('REJ');
      const detail=`${a.type==='out'?'เบิก':'รับ'} ${a.name} ${a.qty} ${a.unit}`;
      const finalFields={action:'ปฏิเสธ',detail,time:new Date().toLocaleString('th-TH'),updatedAt:serverTimestamp(),location:a.type==='in'?STORE_LOCATION:(a.location||''),reviewerUid,reviewerName,submittedByUid:a.submittedByUid||'',submittedByName:a.submittedByName||'',productId:a.productId,qty:a.qty,unit:a.unit,moveType:a.type,photo:a.img||'',eventId,status:'rejected'};
      let logId=a.logId||'';
      let lRef=null,lSnap=null;
      if(logId){ lRef=logDocRef(logId); lSnap=await tx.get(lRef); }
      if(logId && lSnap?.exists()) tx.update(lRef,finalFields);
      else { const fallback=doc(logRef()); logId=fallback.id; tx.set(fallback,logPayload('ปฏิเสธ',detail,finalFields)); }
      const auditDoc=doc(auditRef());
      tx.set(auditDoc,auditPayload('ปฏิเสธ',detail,{...finalFields,approvalId:id,logId,eventId}));
      tx.delete(aRef);
    });
    hideModal(); toast('ปฏิเสธรายการแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'ปฏิเสธรายการไม่สำเร็จ'); }
  finally{ endActionLock(lockKey,'confirmRejectBtn'); }
};
window.editApproval=(id)=>{
  const a=state.approvals.find(x=>x.id===id);
  if(!a) return toast('ไม่พบรายการ');
  if(!requirePendingOwnerOrApprover(a)) return;
  openModal('แก้ไขรายการรออนุมัติ',`<input id="aq" type="number" min="1" value="${a.qty}">
    <select id="at" onchange="window.updateApprovalLocation()">
      <option value="out" ${a.type==='out'?'selected':''}>เบิกออก</option>
      <option value="in" ${a.type==='in'?'selected':''}>รับเข้า</option>
    </select>
    <div id="approvalLocationWrap"></div>
    <button class="btn primary full" onclick="window.saveApproval('${id}')">บันทึกการแก้ไข</button>`);
  window.updateApprovalLocation();
  const sel=$('aLoc');
  if(a.type==='out'&&sel&&a.location){
    if(LOCATION_OPTIONS.includes(a.location)){sel.value=a.location;}
    else{sel.value='อื่นๆ';$('aLocOther').classList.remove('hidden');$('aLocOther').value=a.location;}
  }
};
window.confirmCancelApproval=(id)=>{
  const a=state.approvals.find(x=>x.id===id);
  if(!a) return toast('ไม่พบรายการ');
  if(!isOwnApproval(a)) return toast('ยกเลิกได้เฉพาะรายการของตัวเอง');
  openModal('ยืนยันยกเลิกรายการ',`${approvalDetailHtml(a)}
    <div class="card note" style="margin:0 0 12px">เมื่อยกเลิกแล้ว รายการจะถูกนำออกจากคิวอนุมัติ แต่ยังมีประวัติว่าเคยยกเลิก</div>
    <button class="btn red full" onclick="window.cancelApproval('${id}')">ยืนยันยกเลิกรายการ</button>`);
};

window.cancelApproval=async(id)=>{
  const cached=state.approvals.find(x=>x.id===id);
  if(!cached) return toast('ไม่พบรายการ');
  if(!isOwnApproval(cached)) return toast('ยกเลิกได้เฉพาะรายการของตัวเอง');
  try{
    await runTransaction(fs,async tx=>{
      const aRef=approvalRef(id),aSnap=await tx.get(aRef);
      if(!aSnap.exists()) throw new Error('รายการนี้ถูกดำเนินการแล้ว');
      const a={id,...aSnap.data()};
      if(a.submittedByUid!==state.user?.uid) throw new Error('ยกเลิกได้เฉพาะรายการของตัวเอง');
      const eventId=a.eventId||makeEventId('CAN');
      const detail=`ยกเลิก${a.type==='out'?'เบิก':'รับ'} ${a.name} ${a.qty} ${a.unit}`;
      const finalFields={action:'ยกเลิก',detail,time:new Date().toLocaleString('th-TH'),updatedAt:serverTimestamp(),cancelledAt:serverTimestamp(),productId:a.productId,qty:a.qty,unit:a.unit,moveType:a.type,location:a.location||'',submittedByUid:a.submittedByUid||'',submittedByName:a.submittedByName||'',eventId,status:'cancelled'};
      let logId=a.logId||'';
      let lRef=null,lSnap=null;
      if(logId){ lRef=logDocRef(logId); lSnap=await tx.get(lRef); }
      if(logId && lSnap?.exists()) tx.update(lRef,finalFields);
      else { const fallback=doc(logRef()); logId=fallback.id; tx.set(fallback,logPayload('ยกเลิก',detail,finalFields)); }
      const auditDoc=doc(auditRef());
      tx.set(auditDoc,auditPayload('ยกเลิก',detail,{...finalFields,approvalId:id,logId,eventId}));
      tx.delete(aRef);
    });
    hideModal(); toast('ยกเลิกรายการแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'ยกเลิกรายการไม่สำเร็จ'); }
};
window.updateApprovalLocation=()=>{ const wrap=$('approvalLocationWrap'), type=$('at')?.value; if(!wrap) return; wrap.innerHTML=type==='in' ? `<div class="card" style="margin:8px 0;box-shadow:none;border:1px solid #bbf7d0;background:#f0fdf4"><div class="muted">สถานที่รับเข้าอัตโนมัติ</div><b style="font-size:20px;color:#15803d">📍 ${STORE_LOCATION}</b></div>` : locationFieldHtml('aLoc','aLocOther'); };
window.saveApproval=async(id)=>{
  const cached=state.approvals.find(x=>x.id===id);
  if(!cached) return toast('ไม่พบรายการ');
  if(!requirePendingOwnerOrApprover(cached)) return;
  const qty=Number($('aq').value)||0;
  if(qty<=0) return toast('จำนวนไม่ถูกต้อง');
  const type=$('at').value;
  const location=type==='in'?STORE_LOCATION:getLocationValue('aLoc','aLocOther');
  if(type==='out'&&!location) return toast('กรุณาเลือกสถานที่เบิก');
  const p=state.products.find(x=>x.id===cached.productId);
  if(type==='out'&&p&&qty>Number(p.stock)) return toast('เบิกเกินสต๊อก');
  try{
    await runTransaction(fs,async tx=>{
      const aRef=approvalRef(id),aSnap=await tx.get(aRef);
      if(!aSnap.exists()) throw new Error('รายการนี้ถูกดำเนินการแล้ว');
      const a={id,...aSnap.data()};
      if(!canApprove()&&a.submittedByUid!==state.user?.uid) throw new Error('คุณแก้ไขได้เฉพาะรายการของตัวเอง');
      const eventId=a.eventId||makeEventId('EDITREQ');
      const editorName=state.profile?.displayName||state.profile?.username||'ไม่ทราบผู้ใช้';
      const detail=`${type==='out'?'เบิก':'รับ'} ${a.name} ${qty} ${a.unit}`;
      let logId=a.logId||'';
      const logFields={action:'ส่งตรวจ',detail,qty,unit:a.unit,location,moveType:type,time:new Date().toLocaleString('th-TH'),updatedAt:serverTimestamp(),eventId,status:'pending'};
      let lRef=null,lSnap=null;
      if(logId){ lRef=logDocRef(logId); lSnap=await tx.get(lRef); }
      tx.update(aRef,{qty,type,location,eventId,updatedAt:serverTimestamp(),updatedByUid:state.user.uid,updatedByName:editorName});
      if(logId && lSnap?.exists()) tx.update(lRef,logFields);
      else { const fallback=doc(logRef()); logId=fallback.id; tx.set(fallback,logPayload('แก้ไขรายการรออนุมัติ',detail,{...logFields,productId:a.productId})); tx.update(aRef,{logId}); }
      const auditDoc=doc(auditRef());
      tx.set(auditDoc,auditPayload('แก้ไขรายการรออนุมัติ',detail,{approvalId:id,logId,eventId,productId:a.productId,qty,unit:a.unit,moveType:type,location}));
    });
    hideModal(); toast('แก้ไขรายการแล้ว');
  }catch(e){ console.error(e); toast(e?.message||'แก้ไขรายการไม่สำเร็จ'); }
};
function renderTrash(){
  if(!canManageProducts()){
    state.page='profile';
    toast('คุณไม่มีสิทธิ์เข้าถึงถังขยะ');
    renderProfile();
    return;
  }
  const items = state.products.filter(p=>p.trashed).sort((a,b)=>{
    const ta=a.trashedAt?.seconds||0, tb=b.trashedAt?.seconds||0; return tb-ta;
  });
  const rows = items.map(p=>`<div class="product"><div><b>${escapeHtml(p.name)}</b><div class="muted">${escapeHtml(p.sku||'-')} • ${p.stock} ${escapeHtml(p.unit||'')}</div></div><div class="row"><button class="btn small green" onclick="window.restoreProduct('${p.id}')">↩️ กู้คืน</button><button class="btn small red" onclick="window.purgeProduct('${p.id}')">🗑️ ลบถาวรจริง</button></div></div>`).join('');
  view.innerHTML = `<div class="between"><h1>🗑️ ถังขยะ</h1><button class="btn small" onclick="window.backToProfile()">← กลับ</button></div><div class="card"><p class="muted" style="margin-top:0">สินค้าที่ลบจะเก็บไว้ที่นี่จนกว่าจะกู้คืนหรือลบถาวรจริงด้วยตัวเอง</p>${rows||'<p class="muted">ถังขยะว่างเปล่า</p>'}</div>`;
}
window.viewTrash=()=>{
  if(!canManageProducts()) return toast('คุณไม่มีสิทธิ์เข้าถึงถังขยะ');
  state.page='trash';
  renderTrash();
  window.scrollTo({top:0,behavior:'auto'});
};
window.backToProfile=()=>{ state.page='profile'; renderProfile(); };
window.restoreProduct=async(id)=>{ if(!requireManager()) return; const p=state.products.find(x=>x.id===id); await updateDoc(productRef(id),{trashed:false,trashedAt:null,updatedAt:serverTimestamp()}); await addLog('กู้คืนจากถังขยะ',p.name,{productId:id}); toast('กู้คืนแล้ว'); renderTrash(); };
window.purgeProduct=async(id)=>{ if(!requireManager()) return; const p=state.products.find(x=>x.id===id); const typed=prompt(`ลบ "${p.name}" ถาวร จะกู้คืนไม่ได้อีกเลย\n\nพิมพ์คำว่า "ลบถาวร" เพื่อยืนยัน`); if(typed===null) return; if(typed.trim()!=='ลบถาวร'){ toast('ยกเลิก: ข้อความไม่ตรง'); return; } await deleteDoc(productRef(id)); state.products=state.products.filter(x=>x.id!==id); await writeProductCache(state.products,0,Date.now()); await addLog('ลบถาวรจริง',p.name); toast('ลบถาวรแล้ว'); renderTrash(); };

function getReportPeriodLogs(){
  const movementLogs = state.logs
    .filter(isStockMovementLog)
    .map(l=>({ ...l, _d:getLogDate(l), _type:isReceiveLog(l)?'in':'out' }))
    .filter(l=>l._d);

  if(state.reportMode==='month'){
    const [y,m] = state.reportMonth.split('-').map(Number);
    return movementLogs.filter(l=> l._d.getFullYear()===y && (l._d.getMonth()+1)===m);
  }
  if(state.reportMode==='range'){
    const start = parseLocalDate(state.reportStart || toDateStr(new Date()));
    const end = parseLocalDate(state.reportEnd || state.reportStart || toDateStr(new Date()));
    if(!start || !end) return [];
    const from = start <= end ? start : end;
    const to = start <= end ? end : start;
    to.setHours(23,59,59,999);
    return movementLogs.filter(l=>l._d>=from && l._d<=to);
  }
  const [y,m,d] = state.reportDate.split('-').map(Number);
  return movementLogs.filter(l=> l._d.getFullYear()===y && (l._d.getMonth()+1)===m && l._d.getDate()===d);
}

function renderReport(){
  if(!state.reportDate) state.reportDate = toDateStr(new Date());
  if(!state.reportMonth) state.reportMonth = toMonthStr(new Date());
  if(!state.reportFilter) state.reportFilter = 'all';
  if(!state.reportStart) state.reportStart = toDateStr(new Date());
  if(!state.reportEnd) state.reportEnd = toDateStr(new Date());

  const periodLogs = getReportPeriodLogs();
  let periodLabel;
  if(state.reportMode==='month'){
    const [y,m] = state.reportMonth.split('-').map(Number);
    periodLabel = `เดือน ${pad2(m)}/${y}`;
  } else if(state.reportMode==='range') {
    const start=parseLocalDate(state.reportStart), end=parseLocalDate(state.reportEnd);
    const a=start&&end&&start>end?end:start, b=start&&end&&start>end?start:end;
    periodLabel = a&&b ? `ช่วงวันที่ ${a.toLocaleDateString('th-TH')} – ${b.toLocaleDateString('th-TH')}` : 'ช่วงวันที่ที่เลือก';
  } else {
    const [y,m,d] = state.reportDate.split('-').map(Number);
    periodLabel = `วันที่ ${pad2(d)}/${pad2(m)}/${y}`;
  }

  const filtered = state.reportFilter==='all' ? periodLogs : periodLogs.filter(l=>l._type===state.reportFilter);
  const receiveLogs = filtered.filter(l=>l._type==='in');
  const withdrawLogs = filtered.filter(l=>l._type==='out');

  function summarize(logs){
    const products={}, units={};
    for(const l of logs){
      const product=state.products.find(p=>p.id===l.productId);
      const name=product?.name || l.detail || 'ไม่ทราบสินค้า';
      const unit=l.unit || product?.unit || '';
      const key=(l.productId||name)+'|'+unit;
      if(!products[key]) products[key]={name,unit,qty:0,tx:0};
      const qty=Number(l.qty)||0;
      products[key].qty+=qty; products[key].tx+=1;
      units[unit]=(units[unit]||0)+qty;
    }
    return {products:Object.values(products).sort((a,b)=>b.qty-a.qty),units,tx:logs.length};
  }
  function unitText(units){ return Object.entries(units).map(([u,q])=>`${q} ${escapeHtml(u||'หน่วย')}`).join(' • ') || '0'; }
  function productRows(items){ return items.map(p=>`<div class="between" style="padding:8px 0;border-bottom:1px solid var(--line)"><span>${escapeHtml(p.name)}</span><b>${p.qty} ${escapeHtml(p.unit||'หน่วย')}</b></div>`).join(''); }

  const receiveSummary=summarize(receiveLogs);
  const receiveCard = receiveLogs.length ? `<div class="card" style="border:1px solid #bbf7d0;cursor:pointer" onclick="window.openReportDetails('in','${STORE_LOCATION}')">
    <div class="between"><div><div class="muted">รับเข้าสินค้า</div><h2 style="margin:2px 0;color:#15803d">📥 ${STORE_LOCATION}</h2></div><button class="pill ok" style="border:0;cursor:pointer" onclick="event.stopPropagation();window.openReportDetails('in','${STORE_LOCATION}')">${receiveSummary.tx} รายการ ›</button></div>
    <div style="margin-top:8px">${productRows(receiveSummary.products)}</div>
    <div class="between" style="margin-top:10px;padding-top:8px;border-top:2px solid #bbf7d0"><span class="muted">รวมรับเข้า</span><b>${receiveSummary.products.length} รายการ</b></div>
    <div class="muted" style="margin-top:8px;font-size:13px">แตะเพื่อดูวันที่และจำนวนแต่ละรายการ</div>
  </div>` : (state.reportFilter==='out'?'':`<div class="card" style="text-align:center"><p class="muted" style="margin:0">ไม่มีรายการรับเข้าในช่วงเวลานี้</p></div>`);

  const byLoc={};
  for(const l of withdrawLogs){
    const loc=(l.location||'').trim()||'ไม่ระบุสถานที่';
    if(!byLoc[loc]) byLoc[loc]=[];
    byLoc[loc].push(l);
  }
  const locNames=Object.keys(byLoc).sort((a,b)=>{
    const ia=LOCATION_OPTIONS.indexOf(a), ib=LOCATION_OPTIONS.indexOf(b);
    if(ia===-1&&ib===-1) return a.localeCompare(b); if(ia===-1) return 1; if(ib===-1) return -1; return ia-ib;
  });
  const withdrawCards=locNames.map(loc=>{
    const sm=summarize(byLoc[loc]);
    const safeLoc=encodeURIComponent(loc);
    return `<div class="card" style="border:1px solid #fde68a;cursor:pointer" onclick="window.openReportDetails('out',decodeURIComponent('${safeLoc}'))"><div class="between"><div><div class="muted">เบิกออกไปยัง</div><h2 style="margin:2px 0;color:#b45309">📍 ${escapeHtml(loc)}</h2></div><button class="pill warn" style="border:0;cursor:pointer" onclick="event.stopPropagation();window.openReportDetails('out',decodeURIComponent('${safeLoc}'))">${sm.tx} รายการ ›</button></div><div style="margin-top:8px">${productRows(sm.products)}</div><div class="between" style="margin-top:10px;padding-top:8px;border-top:2px solid #fde68a"><span class="muted">รวมเบิกออก</span><b>${sm.products.length} รายการ</b></div><div class="muted" style="margin-top:8px;font-size:13px">แตะเพื่อดูวันที่และจำนวนแต่ละรายการ</div></div>`;
  }).join('') || (state.reportFilter==='in'?'':`<div class="card" style="text-align:center"><p class="muted" style="margin:0">ไม่มีรายการเบิกออกในช่วงเวลานี้</p></div>`);

  const allSummary=summarize(filtered), inSummary=summarize(receiveLogs), outSummary=summarize(withdrawLogs);
  const controls=state.reportMode==='month'
    ? `<div class="row" style="align-items:center;gap:8px"><button class="btn small" onclick="window.reportShiftMonth(-1)">◀</button><input type="month" value="${state.reportMonth}" onchange="window.reportSetMonth(this.value)" style="flex:1"><button class="btn small" onclick="window.reportShiftMonth(1)">▶</button></div>`
    : state.reportMode==='range'
      ? `<div class="report-range-grid"><label><span>ตั้งแต่วันที่</span><input type="date" value="${state.reportStart}" onchange="window.reportSetRangeStart(this.value)"></label><label><span>ถึงวันที่</span><input type="date" value="${state.reportEnd}" onchange="window.reportSetRangeEnd(this.value)"></label></div><div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn small light" onclick="window.reportQuickRange(7)">7 วันล่าสุด</button><button class="btn small light" onclick="window.reportQuickRange(15)">15 วันล่าสุด</button><button class="btn small light" onclick="window.reportQuickRange(30)">30 วันล่าสุด</button></div>`
      : `<div class="row" style="align-items:center;gap:8px"><button class="btn small" onclick="window.reportShiftDay(-1)">◀</button><input type="date" value="${state.reportDate}" onchange="window.reportSetDate(this.value)" style="flex:1"><button class="btn small" onclick="window.reportShiftDay(1)">▶</button></div>`;

  // เมื่ออยู่หน้ารับเข้า ให้เหลือเฉพาะ ทั้งหมด/รับเข้า
  // เมื่ออยู่หน้าเบิกออก ให้เหลือเฉพาะ ทั้งหมด/เบิกออก
  // หน้า "ทั้งหมด" แสดงทางเลือกครบเพื่อให้เลือกเข้าแต่ละหน้าได้
  const filterButtons = state.reportFilter==='in'
    ? `<button class="btn small light" onclick="window.setReportFilter('all')">ทั้งหมด</button><button class="btn small green" onclick="window.setReportFilter('in')">รับเข้า</button>`
    : state.reportFilter==='out'
      ? `<button class="btn small light" onclick="window.setReportFilter('all')">ทั้งหมด</button><button class="btn small yellow" onclick="window.setReportFilter('out')">เบิกออก</button>`
      : `<button class="btn small primary" onclick="window.setReportFilter('all')">ทั้งหมด</button><button class="btn small light" onclick="window.setReportFilter('in')">รับเข้า</button><button class="btn small light" onclick="window.setReportFilter('out')">เบิกออก</button>`;

  view.innerHTML=`<h1>📊 รายงานสต๊อก</h1>
  <div class="card"><div class="row" style="gap:8px;margin-bottom:10px"><button class="btn small ${state.reportMode==='day'?'primary':'light'}" onclick="window.setReportMode('day')">รายวัน</button><button class="btn small ${state.reportMode==='month'?'primary':'light'}" onclick="window.setReportMode('month')">รายเดือน</button><button class="btn small ${state.reportMode==='range'?'primary':'light'}" onclick="window.setReportMode('range')">ช่วงวันที่</button></div>${controls}<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">${filterButtons}</div></div>
  <div class="card report-export-card"><div><b>ส่งออกรายงานการเคลื่อนไหว</b><div class="muted" style="font-size:13px">ใช้ช่วงเวลาและตัวกรองรับเข้า/เบิกออกที่เลือกอยู่</div></div><div class="row report-export-actions"><button class="btn small green" onclick="window.exportReportCSV()">📗 Excel/CSV</button><button class="btn small primary" onclick="window.printReportPDF()">📄 PDF / พิมพ์</button></div></div>
  ${renderStockBalanceExportCard()}
  <div class="card"><h2 style="margin:0">สรุป ${escapeHtml(periodLabel)}</h2><div class="grid" style="margin-top:12px"><div class="stat"><span>ทั้งหมด</span><b>${allSummary.tx}</b><small>${unitText(allSummary.units)}</small></div>${state.reportFilter!=='out'?`<div class="stat"><span>รับเข้า</span><b style="color:#16a34a">${inSummary.tx}</b><small>${unitText(inSummary.units)}</small></div>`:''}${state.reportFilter!=='in'?`<div class="stat"><span>เบิกออก</span><b style="color:#b45309">${outSummary.tx}</b><small>${unitText(outSummary.units)}</small></div>`:''}</div></div>
  ${receiveCard}${withdrawCards}`;
}


function getActiveProducts(){
  return state.products.filter(p=>!p.archived && !p.trashed);
}
function getStockCategories(){
  return [...new Set(getActiveProducts().map(p=>String(p.category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'th'));
}
function getStockBalanceRows(){
  const category=state.balanceCategory||'all';
  return getActiveProducts()
    .filter(p=>category==='all' || String(p.category||'').trim()===category)
    .map(p=>{
      const stock=Number(p.stock)||0, min=Number(p.min)||0;
      return {
        name:p.name||'', category:String(p.category||'').trim()||'ไม่ระบุ', sku:p.sku||'-',
        stock, unit:p.unit||'หน่วย', min,
        status:stock<=0?'หมด':(stock<=min?'ใกล้หมด':'ปกติ')
      };
    })
    .sort((a,b)=>a.category.localeCompare(b.category,'th')||a.name.localeCompare(b.name,'th'));
}
function renderStockBalanceExportCard(){
  const categories=getStockCategories();
  if(state.balanceCategory!=='all' && !categories.includes(state.balanceCategory)) state.balanceCategory='all';
  const rows=getStockBalanceRows();
  const low=rows.filter(r=>r.status==='ใกล้หมด').length;
  const out=rows.filter(r=>r.status==='หมด').length;
  const ok=rows.length-low-out;
  return `<div class="card report-export-card" style="align-items:stretch;flex-direction:column;gap:12px">
    <div><b>📦 รายงานยอดคงเหลือปัจจุบัน</b><div class="muted" style="font-size:13px">สรุปยอดสินค้าที่เหลืออยู่จริง ณ เวลาที่ส่งออก ไม่อิงช่วงวันที่</div></div>
    <select class="stock-sort-field" onchange="window.setBalanceCategory(this.value)">
      <option value="all" ${state.balanceCategory==='all'?'selected':''}>ทุกหมวดหมู่</option>
      ${categories.map(c=>`<option value="${escapeHtml(c)}" ${state.balanceCategory===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}
    </select>
    <div class="muted" style="font-size:13px">ทั้งหมด ${rows.length} • ปกติ ${ok} • ใกล้หมด ${low} • หมด ${out}</div>
    <div class="row report-export-actions"><button class="btn small green" onclick="window.exportStockBalanceCSV()">📗 Excel/CSV คงเหลือ</button><button class="btn small primary" onclick="window.printStockBalancePDF()">📄 PDF คงเหลือ</button></div>
  </div>`;
}
window.setBalanceCategory=(value)=>{ state.balanceCategory=value||'all'; saveUiState(); renderReport(); };
window.exportStockBalanceCSV=()=>{
  const rows=getStockBalanceRows();
  if(!rows.length){ alert('ไม่มีสินค้าในหมวดหมู่ที่เลือก'); return; }
  const low=rows.filter(r=>r.status==='ใกล้หมด').length, out=rows.filter(r=>r.status==='หมด').length, ok=rows.length-low-out;
  const categoryLabel=state.balanceCategory==='all'?'ทุกหมวดหมู่':state.balanceCategory;
  const createdAt=new Date().toLocaleString('th-TH');
  const headers=['สินค้า','หมวดหมู่','SKU','คงเหลือ','หน่วย','จุดเตือน','สถานะ'];
  const lines=[
    [csvCell('TheView Stock — ยอดคงเหลือปัจจุบัน')].join(','),
    [csvCell(`หมวดหมู่: ${categoryLabel} • สร้างเมื่อ ${createdAt}`)].join(','),
    [csvCell(`สินค้าทั้งหมด ${rows.length}`),csvCell(`ปกติ ${ok}`),csvCell(`ใกล้หมด ${low}`),csvCell(`หมด ${out}`)].join(','),
    '',
    headers.map(csvCell).join(','),
    ...rows.map(r=>[r.name,r.category,r.sku,r.stock,r.unit,r.min,r.status].map(csvCell).join(','))
  ];
  const category=state.balanceCategory==='all'?'All':state.balanceCategory.replace(/[\\/:*?"<>|]+/g,'_');
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`TheViewStock_Current_Balance_${category}_${toDateStr(new Date())}.csv`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.printStockBalancePDF=async()=>{
  const w=window.open('','_blank');
  if(!w){ alert('กรุณาอนุญาต Pop-up เพื่อสร้าง PDF'); return; }
  const rows=getStockBalanceRows();
  if(!rows.length){ w.close(); alert('ไม่มีสินค้าในหมวดหมู่ที่เลือก'); return; }
  if(!confirmLargeExport('pdf',rows.length)){ w.close(); return; }
  const low=rows.filter(r=>r.status==='ใกล้หมด').length, out=rows.filter(r=>r.status==='หมด').length, ok=rows.length-low-out;
  const category=state.balanceCategory==='all'?'ทุกหมวดหมู่':state.balanceCategory;
  w.document.open();
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>TheViewStock_Current_Balance</title><style>body{font-family:Arial,'Noto Sans Thai',sans-serif;padding:24px;color:#111827}h1{margin:0 0 6px}.meta{color:#64748b;margin-bottom:18px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.box{border:1px solid #cbd5e1;border-radius:10px;padding:9px 14px}.progress{margin:10px 0;color:#475569;font-size:13px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #cbd5e1;padding:6px;text-align:left}th{background:#eff6ff}@media print{body{padding:0}.no-print{display:none}}</style></head><body><button id="printBtn" class="no-print" disabled onclick="window.print()" style="float:right;padding:10px 16px">กำลังเตรียมเอกสาร...</button><h1>TheView Stock — ยอดคงเหลือปัจจุบัน</h1><div class="meta">หมวดหมู่: ${escapeHtml(category)} • สร้างเมื่อ ${new Date().toLocaleString('th-TH')}</div><div class="summary"><div class="box">สินค้าทั้งหมด <b>${rows.length}</b></div><div class="box">ปกติ <b>${ok}</b></div><div class="box">ใกล้หมด <b>${low}</b></div><div class="box">หมด <b>${out}</b></div></div><div id="buildProgress" class="progress no-print">กำลังเตรียมเอกสาร...</div><table><thead><tr><th>#</th><th>สินค้า</th><th>หมวดหมู่</th><th>SKU</th><th>คงเหลือ</th><th>หน่วย</th><th>จุดเตือน</th><th>สถานะ</th></tr></thead><tbody id="reportRows"></tbody></table></body></html>`);
  w.document.close();
  await writeRowsToPrintWindow(w,rows,(r,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.sku)}</td><td style="text-align:right;font-weight:700">${r.stock}</td><td>${escapeHtml(r.unit)}</td><td style="text-align:right">${r.min}</td><td>${escapeHtml(r.status)}</td></tr>`);
};
function getReportDateBounds(){
  let start,end;
  if(state.reportMode==='month'){
    const [y,m]=(state.reportMonth||toMonthStr(new Date())).split('-').map(Number);
    start=new Date(y,m-1,1,0,0,0,0);
    end=new Date(y,m,0,23,59,59,999);
  }else if(state.reportMode==='range'){
    const a=parseLocalDate(state.reportStart||toDateStr(new Date()));
    const b=parseLocalDate(state.reportEnd||state.reportStart||toDateStr(new Date()));
    if(!a||!b) return null;
    const lo=a<=b?a:b, hi=a<=b?b:a;
    start=new Date(lo.getFullYear(),lo.getMonth(),lo.getDate(),0,0,0,0);
    end=new Date(hi.getFullYear(),hi.getMonth(),hi.getDate(),23,59,59,999);
  }else{
    const d=parseLocalDate(state.reportDate||toDateStr(new Date()));
    if(!d) return null;
    start=new Date(d.getFullYear(),d.getMonth(),d.getDate(),0,0,0,0);
    end=new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59,999);
  }
  return {start,end};
}
async function getReportSourceLogs(){
  const bounds=getReportDateBounds();
  if(!bounds) return [];
  const snap=await getDocs(query(userPath('logs'),where('createdAt','>=',bounds.start),where('createdAt','<=',bounds.end),orderBy('createdAt','desc')));
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}
function confirmLargeExport(kind,count){
  const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||'');
  if(kind==='pdf' && count>5000){
    alert(`รายงานมี ${count.toLocaleString('th-TH')} รายการ ซึ่งมากเกินไปสำหรับ PDF ครั้งเดียว

กรุณาเลือกช่วงวันที่สั้นลง หรือใช้ Excel/CSV เพื่อป้องกัน Safari/มือถือค้าง`);
    return false;
  }
  if(kind==='pdf' && count>(mobile?1200:2500)){
    return confirm(`รายงานมี ${count.toLocaleString('th-TH')} รายการ
การสร้าง PDF อาจใช้เวลาหรือหน่วยความจำสูงบนอุปกรณ์นี้

ต้องการดำเนินการต่อหรือไม่?`);
  }
  if(kind==='csv' && count>30000){
    return confirm(`รายงานมี ${count.toLocaleString('th-TH')} รายการ
ไฟล์อาจมีขนาดใหญ่และใช้เวลาสร้างสักครู่

ต้องการดำเนินการต่อหรือไม่?`);
  }
  return true;
}
async function writeRowsToPrintWindow(w,rows,rowHtml,chunkSize=250){
  const tbody=w.document.getElementById('reportRows');
  const progress=w.document.getElementById('buildProgress');
  if(!tbody) return;
  for(let i=0;i<rows.length;i+=chunkSize){
    tbody.insertAdjacentHTML('beforeend',rows.slice(i,i+chunkSize).map((r,j)=>rowHtml(r,i+j)).join(''));
    if(progress) progress.textContent=`เตรียมเอกสาร ${Math.min(i+chunkSize,rows.length).toLocaleString('th-TH')} / ${rows.length.toLocaleString('th-TH')} รายการ`;
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(progress) progress.textContent=`พร้อมพิมพ์ ${rows.length.toLocaleString('th-TH')} รายการ`;
  const btn=w.document.getElementById('printBtn');
  if(btn){ btn.disabled=false; btn.textContent='พิมพ์ / บันทึกเป็น PDF'; }
}
function buildCurrentReportRows(sourceLogs=state.logs){
  const original=state.logs;
  if(sourceLogs!==state.logs) state.logs=sourceLogs;
  try{ return getCurrentReportRows(); }
  finally{ state.logs=original; }
}

function getCurrentReportRows(){
  const logs=getReportPeriodLogs();
  const filtered=state.reportFilter==='all'?logs:logs.filter(l=>l._type===state.reportFilter);
  return filtered.map(l=>{
    const product=state.products.find(p=>p.id===l.productId);
    const dt=getLogDate(l);
    return {
      date:dt?dt.toLocaleDateString('th-TH'):'',
      time:dt?dt.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'',
      type:l._type==='in'?'รับเข้า':'เบิกออก',
      product:product?.name||l.productName||l.detail||'ไม่ทราบสินค้า',
      qty:Number(l.qty)||0,
      unit:l.unit||product?.unit||'',
      location:l.location||'',
      user:l.submittedByName||l.userName||l.displayName||l.byName||l.createdByName||l.actorName||'',
      reviewer:l.reviewerName||'',
      status:l.status==='approved'?'อนุมัติ':l.status==='rejected'?'ปฏิเสธ':l.status==='pending'?'รออนุมัติ':'—'
    };
  }).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
}
function reportFileBase(){
  const period=state.reportMode==='month'
    ? (state.reportMonth||toMonthStr(new Date()))
    : state.reportMode==='range'
      ? `${state.reportStart||toDateStr(new Date())}_to_${state.reportEnd||state.reportStart||toDateStr(new Date())}`
      : (state.reportDate||toDateStr(new Date()));
  const type=state.reportFilter==='in'?'receive':state.reportFilter==='out'?'withdraw':'all';
  return `TheViewStock_Report_${period}_${type}`;
}
function csvCell(v){
  const t=String(v??'').replace(/"/g,'""');
  return `"${t}"`;
}
window.exportReportCSV=async()=>{
  let rows=[];
  try{ rows=buildCurrentReportRows(await getReportSourceLogs()); }catch(e){ console.error(e); alert('โหลดข้อมูลรายงานไม่สำเร็จ'); return; }
  if(!rows.length){ alert('ไม่มีข้อมูลในช่วงเวลาที่เลือก'); return; }
  if(!confirmLargeExport('csv',rows.length)) return;
  const period=state.reportMode==='month'
    ? `เดือน ${state.reportMonth}`
    : state.reportMode==='range'
      ? `ช่วงวันที่ ${state.reportStart} ถึง ${state.reportEnd}`
      : `วันที่ ${state.reportDate}`;
  const totalIn=rows.filter(r=>r.type==='รับเข้า').length;
  const totalOut=rows.filter(r=>r.type==='เบิกออก').length;
  const createdAt=new Date().toLocaleString('th-TH');
  const headers=['วันที่','เวลา','ประเภท','สินค้า','จำนวน','หน่วย','สถานที่','ผู้ทำรายการ','ผู้อนุมัติ/ผู้ปฏิเสธ','ผลการอนุมัติ'];
  const lines=[
    [csvCell('TheView Stock')].join(','),
    [csvCell(`รายงานสต๊อก ${period} • สร้างเมื่อ ${createdAt}`)].join(','),
    [csvCell(`ทั้งหมด ${rows.length} รายการ`),csvCell(`รับเข้า ${totalIn}`),csvCell(`เบิกออก ${totalOut}`)].join(','),
    '',
    headers.map(csvCell).join(','),
    ...rows.map(r=>[r.date,r.time,r.type,r.product,r.qty,r.unit,r.location,r.user,r.reviewer,r.status].map(csvCell).join(','))
  ];
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=reportFileBase()+'.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.printReportPDF=async()=>{
  // Fast local pre-check prevents Safari from opening a blank tab when the current report already has no rows.
  // We still re-query Firestore below when local rows exist, so exported data remains authoritative.
  const localRows=getCurrentReportRows();
  if(!localRows.length){ alert('ไม่มีข้อมูลในช่วงเวลาที่เลือก'); return; }

  const w=window.open('','_blank');
  if(!w){ alert('กรุณาอนุญาต Pop-up เพื่อสร้าง PDF'); return; }
  w.document.write('<p style="font-family:sans-serif;padding:24px">กำลังโหลดข้อมูลรายงาน...</p>');
  let rows=[];
  try{ rows=buildCurrentReportRows(await getReportSourceLogs()); }catch(e){ console.error(e); try{w.close();}catch(_){} alert('โหลดข้อมูลรายงานไม่สำเร็จ'); return; }
  if(!rows.length){ try{w.close();}catch(_){} alert('ไม่มีข้อมูลในช่วงเวลาที่เลือก'); return; }
  if(!confirmLargeExport('pdf',rows.length)){ w.close(); return; }
  const period=state.reportMode==='month'?`เดือน ${state.reportMonth}`:state.reportMode==='range'?`ช่วงวันที่ ${state.reportStart} ถึง ${state.reportEnd}`:`วันที่ ${state.reportDate}`;
  const totalIn=rows.filter(r=>r.type==='รับเข้า').length, totalOut=rows.filter(r=>r.type==='เบิกออก').length;
  w.document.open();
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${reportFileBase()}</title><style>body{font-family:Arial,'Noto Sans Thai',sans-serif;padding:24px;color:#111827}h1{margin:0 0 6px}.meta{color:#64748b;margin-bottom:18px}.summary{display:flex;gap:12px;margin:14px 0;flex-wrap:wrap}.box{border:1px solid #cbd5e1;border-radius:10px;padding:10px 16px}.progress{margin:10px 0;color:#475569;font-size:13px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left}th{background:#eff6ff}@media print{body{padding:0}.no-print{display:none}}</style></head><body><button id="printBtn" class="no-print" disabled onclick="window.print()" style="float:right;padding:10px 16px">กำลังเตรียมเอกสาร...</button><h1>TheView Stock</h1><div class="meta">รายงานสต๊อก ${escapeHtml(period)} • สร้างเมื่อ ${new Date().toLocaleString('th-TH')}</div><div class="summary"><div class="box">ทั้งหมด <b>${rows.length}</b> รายการ</div><div class="box">รับเข้า <b>${totalIn}</b></div><div class="box">เบิกออก <b>${totalOut}</b></div></div><div id="buildProgress" class="progress no-print">กำลังเตรียมเอกสาร...</div><table><thead><tr><th>วันที่</th><th>เวลา</th><th>ประเภท</th><th>สินค้า</th><th>จำนวน</th><th>หน่วย</th><th>สถานที่</th><th>ผู้ทำรายการ</th><th>ผู้อนุมัติ/ผู้ปฏิเสธ</th><th>ผลการอนุมัติ</th></tr></thead><tbody id="reportRows"></tbody></table></body></html>`);
  w.document.close();
  await writeRowsToPrintWindow(w,rows,r=>`<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.time)}</td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.product)}</td><td style="text-align:right">${r.qty}</td><td>${escapeHtml(r.unit)}</td><td>${escapeHtml(r.location)}</td><td>${escapeHtml(r.user)}</td><td>${escapeHtml(r.reviewer)}</td><td>${escapeHtml(r.status)}</td></tr>`);
};

window.setReportMode=(mode)=>{ state.reportMode=mode; renderReport(); };
window.setReportFilter=(filter)=>{ state.reportFilter=filter; renderReport(); };
window.reportShiftDay=(delta)=>{ state.reportDate=shiftDateStr(state.reportDate||toDateStr(new Date()),delta); renderReport(); };
window.reportShiftMonth=(delta)=>{ state.reportMonth=shiftMonthStr(state.reportMonth||toMonthStr(new Date()),delta); renderReport(); };
window.reportSetDate=(val)=>{ if(val){ state.reportDate=val; renderReport(); } };
window.reportSetMonth=(val)=>{ if(val){ state.reportMonth=val; renderReport(); } };
window.reportSetRangeStart=(val)=>{ if(val){ state.reportStart=val; if(state.reportEnd && val>state.reportEnd) state.reportEnd=val; renderReport(); } };
window.reportSetRangeEnd=(val)=>{ if(val){ state.reportEnd=val; if(state.reportStart && val<state.reportStart) state.reportStart=val; renderReport(); } };
window.reportQuickRange=(days)=>{ const end=new Date(); const start=new Date(); start.setDate(end.getDate()-Math.max(1,Number(days)||1)+1); state.reportStart=toDateStr(start); state.reportEnd=toDateStr(end); state.reportMode='range'; renderReport(); };

window.openReportDetails=(type,location)=>{
  const logs=getReportPeriodLogs()
    .filter(l=>l._type===type)
    .filter(l=> type==='in' || ((l.location||'').trim()||'ไม่ระบุสถานที่')===location)
    .sort((a,b)=>b._d-a._d);

  const grouped={};
  for(const l of logs){
    const product=state.products.find(p=>p.id===l.productId);
    const name=product?.name || l.detail || 'ไม่ทราบสินค้า';
    const unit=l.unit || product?.unit || 'หน่วย';
    const key=(l.productId||name)+'|'+unit;
    if(!grouped[key]) grouped[key]={name,unit,total:0,rows:[]};
    const qty=Number(l.qty)||0;
    grouped[key].total+=qty;
    grouped[key].rows.push({
      date:l._d,
      qty,
      actorName:l.actorName||l.submittedByName||'-',
      reviewerName:l.reviewerName||'-'
    });
  }

  const thaiDate=(d)=>d.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
  const thaiTime=(d)=>d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});
  const personLabel=type==='in'?'ผู้รับเข้า':'ผู้เบิก';
  const groups=Object.values(grouped).map(g=>`<div class="card report-detail-product-card" style="box-shadow:none;border:1px solid var(--line);margin:10px 0">
    <div class="between"><b style="font-size:20px">${escapeHtml(g.name)}</b><b>${g.total} ${escapeHtml(g.unit)}</b></div>
    ${g.rows.map(r=>`<div class="report-detail-row">
      <div class="report-detail-row-main">
        <b>${thaiDate(r.date)} • ${thaiTime(r.date)}</b>
        <div class="report-detail-person">👤 ${personLabel}: ${escapeHtml(r.actorName||'-')}</div>
        ${r.reviewerName&&r.reviewerName!=='-'?`<div class="report-detail-reviewer">✅ ผู้อนุมัติ: ${escapeHtml(r.reviewerName)}</div>`:''}
      </div>
      <b class="report-detail-qty">${r.qty} ${escapeHtml(g.unit)}</b>
    </div>`).join('')}
    <div class="between" style="padding-top:10px"><span class="muted">รวมสินค้า</span><b>${g.total} ${escapeHtml(g.unit)}</b></div>
  </div>`).join('');
  const title=type==='in' ? `รายละเอียดรับเข้า — ${STORE_LOCATION}` : `รายละเอียดเบิกออก — ${location}`;
  const period=state.reportMode==='month' ? state.reportMonth : state.reportDate;
  openModal(title,`<p class="muted">ช่วงเวลา: ${escapeHtml(period)} • ${logs.length} รายการ</p>${groups||'<p class="muted">ไม่พบรายละเอียด</p>'}<button class="btn full" onclick="hideModal()">ปิด</button>`);
};


function isAdjustmentLog(log){
  const action=String(log?.action||'').trim();
  return action==='ปรับยอดสินค้า' || action==='ปรับยอดสต๊อก' || action==='ปรับยอด';
}

function historyTypeKey(log){
  if(log.action==='อนุมัติ') return 'approve';
  if(log.action==='ปฏิเสธ') return 'reject';
  if(log.action==='ส่งตรวจ') return 'pending';
  if(isAdjustmentLog(log)) return 'adjust';
  if(isReceiveLog(log)) return 'in';
  if(isWithdrawLog(log)) return 'out';
  return 'other';
}

// รายการหนึ่งอาจอยู่ได้มากกว่า 1 หมวด เช่น "อนุมัติ • รับเข้า"
// จึงต้องตรวจทั้งประเภทการเคลื่อนไหวและสถานะการอนุมัติ แทนการบังคับให้มีหมวดเดียว
function historyMatchesFilter(log, filter){
  if(filter==='all') return true;
  if(filter==='in') return isReceiveLog(log);
  if(filter==='out') return isWithdrawLog(log);
  if(filter==='approve') return log.action==='อนุมัติ';
  if(filter==='reject') return log.action==='ปฏิเสธ';
  if(filter==='pending') return log.action==='ส่งตรวจ';
  if(filter==='adjust') return isAdjustmentLog(log);
  return historyTypeKey(log)===filter;
}

window.loadMoreHistory=async()=>{
  if(logsLoadingMore || !logsHasMore) return;
  logsLoadingMore=true;
  try{
    const qMore=logsCursor
      ? query(userPath('logs'),orderBy('createdAt','desc'),startAfter(logsCursor),limit(LOG_PAGE_SIZE))
      : query(userPath('logs'),orderBy('createdAt','desc'),limit(LOG_PAGE_SIZE));
    const snap=await getDocs(qMore);
    const existing=new Set(state.logs.map(x=>x.id));
    const more=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>!existing.has(x.id));
    state.logs=[...state.logs,...more].sort((a,b)=>(getLogDate(b)?.getTime()||0)-(getLogDate(a)?.getTime()||0));
    logsCursor=snap.docs[snap.docs.length-1]||logsCursor;
    logsHasMore=snap.docs.length===LOG_PAGE_SIZE;
    renderHistory();
    toast(more.length?`โหลดเพิ่ม ${more.length} รายการแล้ว`:'ไม่มีประวัติเก่ากว่านี้แล้ว');
  }catch(e){ console.error(e); toast('โหลดประวัติเพิ่มไม่สำเร็จ'); }
  finally{ logsLoadingMore=false; }
};

function renderHistory(){
  const q=(state.historySearch||'').trim().toLowerCase();
  const filter=state.historyFilter||'all';
  const startDate=state.historyStart||toDateStr(new Date());
  const endDate=state.historyEnd||startDate;
  const startAt=new Date(`${startDate}T00:00:00`);
  const endAt=new Date(`${endDate}T23:59:59.999`);

  let logs=[...state.logs].filter(l=>{
    const d=getLogDate(l);
    return d && d>=startAt && d<=endAt;
  });
  if(filter!=='all') logs=logs.filter(l=>historyMatchesFilter(l,filter));
  if(q){
    logs=logs.filter(l=>[
      l.action,l.detail,l.actorName,l.reviewerName,l.location,l.unit,l.qty,Array.isArray(l.changes)?l.changes.join(' '):''
    ].map(v=>String(v||'').toLowerCase()).join(' ').includes(q));
  }

  const grouped={};
  logs.forEach(l=>{
    const d=getLogDate(l);
    const key=d?toDateStr(d):'unknown';
    (grouped[key] ||= []).push(l);
  });
  Object.values(grouped).forEach(items=>items.sort((a,b)=>(getLogDate(b)?.getTime()||0)-(getLogDate(a)?.getTime()||0)));
  const dateKeys=Object.keys(grouped).sort((a,b)=>b.localeCompare(a));
  const thaiFullDate=(key)=>{
    if(key==='unknown') return 'ไม่ทราบวันที่';
    const [y,m,d]=key.split('-').map(Number);
    return new Date(y,m-1,d).toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  };
  const thaiShortDate=(key)=>{
    const [y,m,d]=key.split('-').map(Number);
    return new Date(y,m-1,d).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
  };
  const renderLog=(l)=>{
    const {label,cls}=logPillInfo(l);
    const requester=l.submittedByName || l.actorName || 'ไม่ทราบผู้ใช้';
    const reviewer=l.reviewerName || '';
    const isAdjust=isAdjustmentLog(l);
    const qty=isAdjust && l.previousStock!==undefined && l.newStock!==undefined
      ? `<strong class="history-qty">${Number(l.previousStock)||0} → ${Number(l.newStock)||0} ${escapeHtml(l.unit||'')}</strong>`
      : (l.qty ? `<strong class="history-qty">${Number(l.qty)||0} ${escapeHtml(l.unit||'')}</strong>` : '');
    const reason=isAdjust && l.reason ? `<div class="history-adjust-reason">เหตุผล: ${escapeHtml(l.reason)}</div>` : '';
    const changesHtml=!isAdjust && Array.isArray(l.changes) && l.changes.length
      ? `<div class="history-change-list">${l.changes.map(change=>`<div>• ${escapeHtml(change)}</div>`).join('')}</div>`
      : '';
    const location=l.location ? `<span>📍 ${escapeHtml(l.location)}</span>` : '';
    const d=getLogDate(l);
    const timeText=d?d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}):(l.time||'');
    return `<article class="history-entry">
      <div class="history-entry-top">
        <span class="pill ${cls}">${escapeHtml(label)}</span>
        <time>${escapeHtml(timeText)}</time>
      </div>
      <div class="history-entry-title">${escapeHtml(l.detail||'-')}</div>
      ${qty}
      ${reason}
      ${changesHtml}
      <div class="history-entry-meta">
        ${location}
        <span>👤 ${l.moveType==='in'?'ผู้รับเข้า':l.moveType==='out'?'ผู้เบิก':'ผู้ดำเนินการ'}: ${escapeHtml(requester)}</span>
        ${(l.action==='อนุมัติ'&&reviewer)?`<span>✅ ผู้อนุมัติ: ${escapeHtml(reviewer)}</span>`:''}
        ${(l.action==='ปฏิเสธ'&&reviewer)?`<span>⛔ ผู้ปฏิเสธ: ${escapeHtml(reviewer)}</span>`:''}
      </div>
    </article>`;
  };
  const rows=dateKeys.map(key=>`<section class="history-day-group">
    <div class="history-day-heading">
      <div><span class="history-day-icon">📅</span><strong>${escapeHtml(thaiFullDate(key))}</strong></div>
      <span>${grouped[key].length} รายการ</span>
    </div>
    <div class="history-list">${grouped[key].map(renderLog).join('')}</div>
  </section>`).join('');

  const today=toDateStr(new Date());
  const yesterday=shiftDateStr(today,-1);
  const isToday=startDate===today&&endDate===today;
  const isYesterday=startDate===yesterday&&endDate===yesterday;
  const is7Days=startDate===shiftDateStr(today,-6)&&endDate===today;
  const periodText=startDate===endDate ? thaiFullDate(startDate) : `${thaiShortDate(startDate)} – ${thaiShortDate(endDate)}`;

  view.innerHTML=`<div class="history-page">
    <div class="history-page-head">
      <div>
        <div class="history-eyebrow">บันทึกการเคลื่อนไหว</div>
        <h1>📋 ประวัติการใช้งาน</h1>
      </div>
      <button class="btn small light" onclick="window.goToPage('home')">← กลับ</button>
    </div>

    <section class="history-control-card">
      <div class="history-quick-range">
        <button class="history-range-btn ${isToday?'active':''}" onclick="window.setHistoryToday()">วันนี้</button>
        <button class="history-range-btn ${isYesterday?'active':''}" onclick="window.setHistoryPreset('yesterday')">เมื่อวาน</button>
        <button class="history-range-btn ${is7Days?'active':''}" onclick="window.setHistoryPreset('7days')">7 วันล่าสุด</button>
      </div>

      <div class="history-date-box">
        <label><span>ตั้งแต่</span><input type="date" value="${escapeHtml(startDate)}" onchange="window.setHistoryDateRange(this.value,null)"></label>
        <span class="history-date-arrow">→</span>
        <label><span>ถึง</span><input type="date" value="${escapeHtml(endDate)}" onchange="window.setHistoryDateRange(null,this.value)"></label>
      </div>

      <div class="history-summary-strip">
        <div><span>ช่วงที่เลือก</span><strong>${escapeHtml(periodText)}</strong></div>
        <div><span>พบทั้งหมด</span><strong>${logs.length} รายการ</strong></div>
      </div>

      <div class="history-search-wrap">
        <span>🔍</span>
        <input id="historySearchInput" value="${escapeHtml(state.historySearch||'')}" placeholder="ค้นหาสินค้า ผู้ใช้งาน หรือสถานที่" oninput="window.setHistorySearch(this.value)">
      </div>

      <div class="history-filter-scroll">
        <button class="history-filter-btn ${filter==='all'?'active':''}" onclick="window.setHistoryFilter('all')">ทั้งหมด</button>
        <button class="history-filter-btn ${filter==='in'?'active':''}" onclick="window.setHistoryFilter('in')">📥 รับเข้า</button>
        <button class="history-filter-btn ${filter==='out'?'active':''}" onclick="window.setHistoryFilter('out')">📤 เบิกออก</button>
        <button class="history-filter-btn ${filter==='adjust'?'active':''}" onclick="window.setHistoryFilter('adjust')">⚖️ ปรับยอด</button>
        <button class="history-filter-btn ${filter==='approve'?'active':''}" onclick="window.setHistoryFilter('approve')">✅ อนุมัติ</button>
        <button class="history-filter-btn ${filter==='reject'?'active':''}" onclick="window.setHistoryFilter('reject')">⛔ ปฏิเสธ</button>
        <button class="history-filter-btn ${filter==='pending'?'active':''}" onclick="window.setHistoryFilter('pending')">⏳ รอตรวจ</button>
      </div>
    </section>

    <div class="history-results">${rows||`<div class="history-empty"><div>🗂️</div><strong>ไม่พบประวัติ</strong><span>ลองเปลี่ยนวันที่ คำค้นหา หรือตัวกรอง</span></div>`}</div>
    ${logsHasMore?`<div style="padding:16px 0 28px;text-align:center"><button class="btn light" onclick="window.loadMoreHistory()">โหลดประวัติเก่าเพิ่ม</button><div class="muted" style="margin-top:8px;font-size:12px">โหลดครั้งละ ${LOG_PAGE_SIZE} รายการ เพื่อลดการใช้หน่วยความจำและ Firestore Reads</div></div>`:`<div class="muted" style="padding:12px 0 24px;text-align:center">โหลดประวัติครบถึงข้อมูลเก่าสุดที่มีแล้ว</div>`}
  </div>`;
}

function rerenderHistoryKeepingScroll(){
  const y=window.scrollY||document.documentElement.scrollTop||0;
  renderHistory();
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo({top:y,behavior:'auto'})));
}

window.setHistorySearch=(value)=>{
  const y=window.scrollY||document.documentElement.scrollTop||0;
  state.historySearch=String(value||'');
  renderHistory();
  requestAnimationFrame(()=>{
    const input=$('historySearchInput');
    if(input){
      input.focus();
      input.setSelectionRange(input.value.length,input.value.length);
    }
    window.scrollTo({top:y,behavior:'auto'});
  });
};

window.setHistoryFilter=(value)=>{
  state.historyFilter=value||'all';
  saveUiState();
  rerenderHistoryKeepingScroll();
};
window.setHistoryDateRange=(start,end)=>{
  if(start) state.historyStart=start;
  if(end) state.historyEnd=end;
  if(state.historyStart>state.historyEnd){
    if(start) state.historyEnd=state.historyStart;
    else state.historyStart=state.historyEnd;
  }
  saveUiState();
  rerenderHistoryKeepingScroll();
};
window.setHistoryToday=()=>{
  const today=toDateStr(new Date());
  state.historyStart=today;
  state.historyEnd=today;
  saveUiState();
  rerenderHistoryKeepingScroll();
};
window.setHistoryPreset=(preset)=>{
  const today=toDateStr(new Date());
  if(preset==='yesterday'){
    const d=shiftDateStr(today,-1);
    state.historyStart=d; state.historyEnd=d;
  }else if(preset==='7days'){
    state.historyStart=shiftDateStr(today,-6); state.historyEnd=today;
  }
  saveUiState();
  rerenderHistoryKeepingScroll();
};
window.shiftHistoryDay=(delta)=>{
  const base=state.historyStart||toDateStr(new Date());
  const next=shiftDateStr(base,Number(delta)||0);
  state.historyStart=next;
  state.historyEnd=next;
  saveUiState();
  rerenderHistoryKeepingScroll();
};

function roleLabel(value='staff'){
  return ({admin:'แอดมิน',manager:'ผู้จัดการ',captain:'กัปตัน / ธุรการ',staff:'พนักงาน'}[value]||value||'พนักงาน');
}
function profileInitials(){
  const first=(state.profile?.firstName||state.profile?.displayName||state.profile?.username||'T').trim();
  const last=(state.profile?.lastName||'').trim();
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

window.viewAuditLog=()=>{
  if(!canManageProducts()) return toast('ไม่มีสิทธิ์ดู Audit Log');
  const rows=state.auditLogs.slice(0,300).map(a=>{const d=getLogDate(a);return `<div class="card" style="box-shadow:none;border:1px solid var(--line);margin:10px 0"><div class="between"><b>${escapeHtml(a.action||'-')}</b><span class="muted">${d?d.toLocaleString('th-TH'):'-'}</span></div><div>${escapeHtml(a.detail||'')}</div><div class="muted">โดย ${escapeHtml(a.actorName||'-')} • ${escapeHtml(a.actorRole||'-')}</div>${a.previousStock!==undefined?`<div><b>${a.previousStock} → ${a.newStock}</b> ${escapeHtml(a.unit||'')}</div>`:''}${a.reason?`<div class="note">เหตุผล: ${escapeHtml(a.reason)}</div>`:''}</div>`}).join('');
  openModal('🛡️ Audit Log',`<p class="note">ประวัติการแก้ไขแบบอ่านอย่างเดียว แสดงล่าสุดไม่เกิน 300 รายการ</p>${rows||'<p class="muted">ยังไม่มี Audit Log</p>'}`);
};

function renderProfile(){
  const p=state.profile||{};
  const trashCount=state.products.filter(x=>x.trashed).length;
  const auditRows = state.logs.slice(0,30).map(l=>{ const {label,cls}=logPillInfo(l); return `<div class="profile-log-row"><div><span class="pill ${cls}">${escapeHtml(label)}</span><div class="profile-log-detail">${escapeHtml(l.detail||'')}</div></div><div class="profile-log-meta">${escapeHtml(l.time||'')}<br>👤 ${escapeHtml(l.actorName||'ไม่ทราบผู้ใช้')}</div></div>`; }).join('') || '<p class="muted">ยังไม่มี Log</p>';
  view.innerHTML = `<div class="profile-page">
    <section class="profile-cover">
      <div class="profile-photo-wrap">
        <div class="profile-photo-avatar" onclick="window.chooseProfilePhoto()" role="button" tabindex="0">
          ${p.photoURL?`<img src="${p.photoURL}" alt="รูปโปรไฟล์">`:escapeHtml(profileInitials())}
        </div>
        <button type="button" class="profile-photo-change" onclick="window.chooseProfilePhoto()" aria-label="เปลี่ยนรูปโปรไฟล์">📷</button>
        <input id="profilePhotoInput" type="file" accept="image/*" class="hidden">
      </div>
      <div class="profile-identity">
        <h1>${escapeHtml(p.displayName||p.username||'สมาชิก')}</h1>
        <div class="profile-badges"><span class="profile-role">${escapeHtml(roleLabel(p.role))}</span><span class="profile-status">● ${p.status==='active'?'Active':'Disabled'}</span></div>
        <p>@${escapeHtml(p.username||'')}</p>
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section-title"><span>📷</span><div><h2>รูปโปรไฟล์</h2><p>ใช้แสดงในหน้าโปรไฟล์และรายการที่คุณส่ง</p></div></div>
      <div class="profile-photo-actions">
        <button type="button" class="btn primary" onclick="window.chooseProfilePhoto()">เลือกรูปโปรไฟล์</button>
        <button type="button" class="btn red" onclick="window.removeProfilePhoto()" ${p.photoURL?'':'disabled'}>ลบรูป</button>
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section-title"><span>👤</span><div><h2>ข้อมูลส่วนตัว</h2><p>แก้ไขข้อมูลที่ใช้แสดงภายในทีม</p></div></div>
      <div class="profile-form-grid">
        <label>ชื่อ<input id="profileFirstName" value="${escapeHtml(p.firstName||'')}" placeholder="ชื่อ"></label>
        <label>นามสกุล<input id="profileLastName" value="${escapeHtml(p.lastName||'')}" placeholder="นามสกุล"></label>
        <label>ตำแหน่ง<input id="profilePosition" value="${escapeHtml(p.position||roleLabel(p.role))}" placeholder="เช่น Staff"></label>
        <label>แผนก / ฝ่าย<input id="profileDepartment" value="${escapeHtml(p.department||'')}" placeholder="เช่น Food & Beverage"></label>
        <label class="profile-wide">เบอร์โทรศัพท์ติดต่อ<input id="profilePhone" type="tel" value="${escapeHtml(p.phone||'')}" placeholder="เบอร์โทรหรือเบอร์ต่อภายใน"></label>
      </div>
      <button id="saveProfileBtn" class="profile-save-btn" onclick="window.saveProfileDetails()">💾 บันทึกการแก้ไขโปรไฟล์</button>
    </section>

    <section class="profile-section">
      <div class="profile-section-title"><span>🛡️</span><div><h2>เปลี่ยนรหัสผ่าน</h2><p>รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร</p></div></div>
      <label>รหัสผ่านปัจจุบัน<input id="currentPass" type="password" autocomplete="current-password"></label>
      <label>รหัสผ่านใหม่<input id="newPass" type="password" autocomplete="new-password"></label>
      <label>ยืนยันรหัสผ่านใหม่<input id="confirmPass" type="password" autocomplete="new-password"></label>
      <button id="savePasswordBtn" class="profile-password-btn" onclick="window.saveNewPassword(false)">🔒 เปลี่ยนรหัสผ่าน</button>
    </section>

    ${canAssignApprovers()?`<section class="profile-section">
      <div class="profile-section-title"><span>✅</span><div><h2>การอนุมัติ</h2><p>เปิด/ปิดสิทธิ์เพิ่มเติมให้พนักงานเป็นรายบุคคล</p></div></div>
      <button class="profile-action primary full" onclick="window.manageApprovalAssistants()">🔐 จัดการสิทธิ์พนักงาน</button>
    </section>`:''}
    ${canManageProducts()?`<section class="profile-section"><div class="profile-section-title"><span>🛡️</span><div><h2>ตรวจสอบระบบ</h2><p>ดูประวัติการแก้ไขและปรับยอดย้อนหลัง</p></div></div><button class="profile-action primary full" onclick="window.viewAuditLog()">🛡️ เปิด Audit Log</button></section>`:''}
    ${isAdmin()?`<section class="profile-section">
      <div class="profile-section-title"><span>👥</span><div><h2>ผู้ดูแลระบบ</h2><p>จัดการสมาชิกและข้อมูลสำรอง</p></div></div>
      <div class="profile-action-grid">
        <button class="profile-action primary" onclick="window.manageMembers()">👥 จัดการสมาชิกและตำแหน่ง</button>
        <button class="profile-action" onclick="window.exportBackup()">⬇️ Export Backup</button>
        <button class="profile-action" onclick="window.chooseBackupFile()">⬆️ Import Backup</button>
        <button class="profile-action" onclick="window.viewTrash()">🗑️ ถังขยะ${trashCount?` (${trashCount})`:''}</button>
      </div>
    </section>
    <section class="profile-section profile-danger">
      <div class="profile-section-title"><span>⚠️</span><div><h2>พื้นที่อันตราย</h2><p>คำสั่งนี้กระทบข้อมูลส่วนกลางของทีม</p></div></div>
      <button class="profile-danger-btn" onclick="window.resetAccount()">ล้างข้อมูลส่วนกลาง</button>
    </section>`:(canManageProducts()?`<section class="profile-section"><button class="profile-action full" onclick="window.viewTrash()">🗑️ ถังขยะ${trashCount?` (${trashCount})`:''}</button></section>`:'')}
  </div>`;
  refreshPasswordEyes(view);
  const profilePhotoInput=$('profilePhotoInput');
  if(profilePhotoInput){
    profilePhotoInput.onchange=e=>window.saveProfilePhoto(e.target.files?.[0]);
  }
}

window.chooseProfilePhoto=()=>{
  const input=$('profilePhotoInput');
  if(!input) return;
  input.value='';
  input.click();
};

function compressProfilePhoto(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('เปิดรูปไม่สำเร็จ'));
      img.onload=()=>{
        const size=360;
        const canvas=document.createElement('canvas');
        canvas.width=size;
        canvas.height=size;
        const ctx=canvas.getContext('2d');
        const scale=Math.max(size/img.width,size/img.height);
        const w=img.width*scale;
        const h=img.height*scale;
        const x=(size-w)/2;
        const y=(size-h)/2;
        ctx.fillStyle='#ffffff';
        ctx.fillRect(0,0,size,size);
        ctx.drawImage(img,x,y,w,h);
        resolve(canvas.toDataURL('image/jpeg',0.76));
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}

window.saveProfilePhoto=async(file)=>{
  if(!file) return;
  if(!file.type?.startsWith('image/')) return toast('กรุณาเลือกไฟล์รูปภาพ');
  try{
    toast('กำลังบันทึกรูป...');
    const photoURL=await compressProfilePhoto(file);
    await updateDoc(memberRef(),{
      photoURL,
      profileUpdatedAt:serverTimestamp()
    });
    state.profile={...state.profile,photoURL};
    toast('บันทึกรูปโปรไฟล์แล้ว');
    renderProfile();
  }catch(error){
    console.error(error);
    toast(error?.code==='permission-denied'
      ? 'บันทึกรูปไม่ได้ กรุณา Publish Firestore Rules ชุดใหม่'
      : 'บันทึกรูปโปรไฟล์ไม่สำเร็จ');
  }
};

window.removeProfilePhoto=async()=>{
  if(!state.profile?.photoURL) return;
  if(!confirm('ต้องการลบรูปโปรไฟล์ใช่ไหม?')) return;
  try{
    await updateDoc(memberRef(),{
      photoURL:'',
      profileUpdatedAt:serverTimestamp()
    });
    state.profile={...state.profile,photoURL:''};
    toast('ลบรูปโปรไฟล์แล้ว');
    renderProfile();
  }catch(error){
    console.error(error);
    toast('ลบรูปโปรไฟล์ไม่สำเร็จ');
  }
};

window.saveProfileDetails=async()=>{
  const btn=$('saveProfileBtn');
  const firstName=($('profileFirstName')?.value||'').trim();
  const lastName=($('profileLastName')?.value||'').trim();
  const position=($('profilePosition')?.value||'').trim();
  const department=($('profileDepartment')?.value||'').trim();
  const phone=($('profilePhone')?.value||'').trim();
  if(!firstName) return toast('กรุณากรอกชื่อ');
  if(!lastName) return toast('กรุณากรอกนามสกุล');
  const displayName=`${firstName} ${lastName}`.trim();
  if(btn){btn.disabled=true;btn.textContent='กำลังบันทึก...';}
  try{
    await updateDoc(memberRef(),{firstName,lastName,displayName,position,department,phone,profileUpdatedAt:serverTimestamp()});
    Object.assign(state.profile,{firstName,lastName,displayName,position,department,phone});
    await addLog('แก้ไขโปรไฟล์',displayName);
    toast('บันทึกโปรไฟล์เรียบร้อย');
    renderProfile();
  }catch(e){
    console.error(e);
    toast(e?.code==='permission-denied'
      ? 'บันทึกโปรไฟล์ไม่ได้ กรุณา Publish Firestore Rules ชุดใหม่'
      : `บันทึกโปรไฟล์ไม่สำเร็จ (${e?.code||'unknown'})`);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='💾 บันทึกการแก้ไขโปรไฟล์';}
  }
};
window.openChangePassword=()=>openModal('เปลี่ยนรหัสผ่าน',`<input id="currentPass" type="password" placeholder="รหัสผ่านปัจจุบัน"><input id="newPass" type="password" placeholder="รหัสผ่านใหม่ อย่างน้อย 6 ตัว"><input id="confirmPass" type="password" placeholder="ยืนยันรหัสผ่านใหม่"><button id="savePasswordBtn" class="btn primary full" onclick="window.saveNewPassword(false)">บันทึก</button>`);
window.openFirstPasswordChange=showFirstPasswordGate;
window.saveNewPassword=async(first)=>{
  const user=auth.currentUser;
  const a=(first ? $('firstNewPass') : $('newPass'))?.value||'';
  const b=(first ? $('firstConfirmPass') : $('confirmPass'))?.value||'';
  const current=first ? '' : ($('currentPass')?.value||'');

  if(!user) return toast('ไม่พบการเข้าสู่ระบบ กรุณาออกแล้วเข้าใหม่');
  if(!first && !current) return toast('กรอกรหัสผ่านปัจจุบัน');
  if(a.length<6) return toast('รหัสผ่านอย่างน้อย 6 ตัว');
  if(a!==b) return toast('รหัสผ่านไม่ตรงกัน');
  if(a===DEFAULT_PASSWORD) return toast('กรุณาตั้งรหัสผ่านอื่น');

  const btn=first ? $('firstPasswordBtn') : $('savePasswordBtn');
  if(btn){ btn.disabled=true; btn.textContent='กำลังเปลี่ยนรหัสผ่าน...'; }

  let gateUnlocked=false;
  try{
    // เปลี่ยนรหัสจากหน้าโปรไฟล์ต้องยืนยันรหัสเดิม
    // แต่การตั้งรหัสครั้งแรก ผู้ใช้เพิ่งล็อกอินมาแล้ว จึงไม่ใช้ chartered ยืนยันซ้ำ
    if(!first){
      const credential=EmailAuthProvider.credential(user.email,current);
      await reauthenticateWithCredential(user,credential);
    }

    if(first){
      // v34.9 Security Hardening:
      // เปลี่ยนรหัสใน Firebase Authentication ให้สำเร็จก่อน จึงค่อยปลดสิทธิ์เข้าแอปใน Firestore
      // ลดช่วงเวลาที่บัญชียังใช้รหัสเริ่มต้นแต่ถูกปลด mustChangePassword แล้ว
      await updateDoc(memberRef(user.uid),{
        passwordChangePending:true,
        passwordChangeStartedAt:serverTimestamp()
      });
    }

    await updatePassword(user,a);

    await updateDoc(memberRef(user.uid),{
      mustChangePassword:false,
      passwordChangePending:false,
      passwordChangedAt:serverTimestamp()
    });
    if(first) gateUnlocked=true;

    state.profile={
      ...(state.profile||{}),
      mustChangePassword:false,
      passwordChangePending:false
    };

    if(first){
      await enterMainApp();
      toast('ตั้งรหัสผ่านสำเร็จ เข้าสู่ระบบแล้ว');
    }else{
      $('modalCloseBtn')?.classList.remove('hidden');
      hideModal();
      toast('เปลี่ยนรหัสผ่านแล้ว');
    }
  }catch(e){
    console.error('เปลี่ยนรหัสผ่านไม่สำเร็จ',e);

    // ถ้าตั้งรหัสครั้งแรกล้มเหลว ให้คงประตูบังคับเปลี่ยนรหัสไว้ และยกเลิก pending
    if(first){
      try{
        await updateDoc(memberRef(user.uid),{
          mustChangePassword:true,
          passwordChangePending:false
        });
      }catch(rollbackError){
        console.error('ย้อนสถานะตั้งรหัสครั้งแรกไม่สำเร็จ',rollbackError);
      }
    }

    const msg = e?.code==='auth/wrong-password' || e?.code==='auth/invalid-credential'
      ? 'รหัสผ่านปัจจุบันไม่ถูกต้อง'
      : e?.code==='auth/weak-password'
        ? 'รหัสผ่านใหม่ยังไม่ปลอดภัยพอ'
        : e?.code==='auth/requires-recent-login'
          ? 'กรุณาออกจากระบบ แล้วเข้าสู่ระบบใหม่ก่อนเปลี่ยนรหัสผ่าน'
          : e?.code==='permission-denied'
            ? 'Firestore ไม่อนุญาตให้อัปเดตสถานะรหัสผ่าน กรุณาตรวจสอบ Rules'
            : `เปลี่ยนรหัสผ่านไม่สำเร็จ (${e?.code||'unknown'})`;
    toast(msg);
  }finally{
    if(btn){
      btn.disabled=false;
      btn.textContent=first?'ตั้งรหัสผ่านและเข้าระบบ':'บันทึก';
    }
  }
};

window.manageMembers=async()=>{ if(!requireAdmin()) return;
  const snap=await getDocs(collection(fs,'members'));
  state.members=snap.docs.map(d=>({uid:d.id,...d.data()}));
  const rows=state.members.map(m=>`<div class="card" style="box-shadow:none;border:1px solid var(--line);margin:8px 0">
    <b>${escapeHtml(m.displayName||m.username)}</b>
    <div class="muted">@${escapeHtml(m.username||'')} • ${escapeHtml(roleLabel(m.role))}</div>
    <label class="field-label">ตำแหน่ง</label>
    <select id="memberRole_${m.uid}">
      <option value="staff" ${m.role==='staff'?'selected':''}>พนักงาน</option>
      <option value="captain" ${m.role==='captain'?'selected':''}>กัปตัน / ธุรการ</option>
      <option value="manager" ${m.role==='manager'?'selected':''}>ผู้จัดการ</option>
      <option value="admin" ${m.role==='admin'?'selected':''}>แอดมิน</option>
    </select>
    <label class="field-label">สถานะ</label>
    <select id="memberStatus_${m.uid}">
      <option value="active" ${m.status!=='disabled'?'selected':''}>ใช้งาน</option>
      <option value="disabled" ${m.status==='disabled'?'selected':''}>ปิดใช้งาน</option>
    </select>
    <button class="btn primary full" onclick="window.saveMemberRole('${m.uid}')">บันทึกสมาชิกคนนี้</button>
  </div>`).join('');
  openModal('จัดการสมาชิกและตำแหน่ง',`<p class="note">ตำแหน่งมี 4 ระดับ: พนักงาน, กัปตัน/ธุรการ, ผู้จัดการ และแอดมิน</p>${rows||'<p class="muted">ยังไม่มีสมาชิก</p>'}`);
};
window.saveMemberRole=async(uid)=>{ if(!requireAdmin()) return;
  const newRole=$(`memberRole_${uid}`)?.value||'staff';
  const status=$(`memberStatus_${uid}`)?.value||'active';
  if(uid===state.user?.uid && (newRole!=='admin' || status!=='active')) return toast('ไม่สามารถลดสิทธิ์หรือปิดบัญชีแอดมินที่กำลังใช้งานอยู่');
  try{
    await updateDoc(memberRef(uid),{role:newRole,status,roleUpdatedAt:serverTimestamp(),roleUpdatedBy:state.user.uid});
    await addLog('แก้ไขตำแหน่งสมาชิก',`${state.members.find(m=>m.uid===uid)?.displayName||uid} → ${roleLabel(newRole)}`);
    toast('บันทึกตำแหน่งแล้ว');
    await window.manageMembers();
  }catch(e){ console.error(e); toast(`บันทึกไม่สำเร็จ (${e?.code||'unknown'})`); }
};
window.manageApprovalAssistants=async()=>{ if(!canAssignApprovers()) return toast('เฉพาะกัปตัน/ธุรการ ผู้จัดการ หรือแอดมินเท่านั้น');
  const snap=await getDocs(collection(fs,'members'));
  state.members=snap.docs.map(d=>({uid:d.id,...d.data()}));
  const staff=state.members.filter(m=>m.role==='staff' && m.status!=='disabled');
  const permissionRow=(id,checked,title,desc,icon)=>`<label class="permission-row" for="${id}">
      <input class="permission-checkbox" type="checkbox" id="${id}" ${checked?'checked':''}>
      <span class="permission-icon" aria-hidden="true">${icon}</span>
      <span class="permission-copy"><span class="permission-title">${title}</span><span class="permission-desc">${desc}</span></span>
    </label>`;
  const rows=staff.map(m=>`<section class="permission-card">
    <div class="permission-person">
      <div class="permission-avatar">${escapeHtml((m.displayName||m.username||'?').trim().charAt(0).toUpperCase())}</div>
      <div class="permission-person-copy"><b>${escapeHtml(m.displayName||m.username)}</b><div class="muted permission-username">@${escapeHtml(m.username||'')} • พนักงาน</div></div>
    </div>
    <div class="permission-list">
      ${permissionRow(`permApprove_${m.uid}`,m.permissions?.canApprove,'อนุมัติ / ปฏิเสธรายการ','ตรวจสอบและตัดสินใจรายการรับเข้า–เบิกออก','✅')}
      ${permissionRow(`permAdjust_${m.uid}`,m.permissions?.canAdjustStock,'ปรับยอดสต๊อก','แก้ยอดคงเหลือพร้อมเหตุผลและบันทึกประวัติ','⚖️')}
      ${permissionRow(`permProducts_${m.uid}`,m.permissions?.canManageProducts,'จัดการสินค้า','เพิ่ม แก้ไข และลบข้อมูลสินค้า','📦')}
      ${permissionRow(`permReports_${m.uid}`,m.permissions?.canViewReports,'ดูรายงานทั้งหมด','เข้าดูรายงานและส่งออกข้อมูล','📊')}
    </div>
  </section>`).join('');
  openModal('จัดการสิทธิ์พนักงาน',`<div class="permission-manager"><p class="note permission-note">มอบสิทธิ์เพิ่มเติมเป็นรายบุคคล โดยไม่ต้องเปลี่ยนตำแหน่งจากพนักงาน ระบบจะบันทึกผู้ที่แก้ไขสิทธิ์และเวลาไว้</p>${rows||'<p class="muted">ยังไม่มีพนักงานที่พร้อมกำหนดสิทธิ์</p>'}<div class="permission-save-wrap"><button class="btn primary full permission-save" onclick="window.saveApprovalAssistants()">บันทึกสิทธิ์</button></div></div>`);
};
window.saveApprovalAssistants=async()=>{ if(!canAssignApprovers()) return;
  const staff=state.members.filter(m=>m.role==='staff'&&m.status!=='disabled');
  const LABELS={canApprove:'อนุมัติ / ปฏิเสธรายการ',canAdjustStock:'ปรับยอดสต๊อก',canManageProducts:'จัดการสินค้า',canViewReports:'ดูรายงานทั้งหมด'};
  const changed=[];
  staff.forEach(m=>{
    const before={canApprove:!!m.permissions?.canApprove,canAdjustStock:!!m.permissions?.canAdjustStock,canManageProducts:!!m.permissions?.canManageProducts,canViewReports:!!m.permissions?.canViewReports};
    const after={canApprove:!!$(`permApprove_${m.uid}`)?.checked,canAdjustStock:!!$(`permAdjust_${m.uid}`)?.checked,canManageProducts:!!$(`permProducts_${m.uid}`)?.checked,canViewReports:!!$(`permReports_${m.uid}`)?.checked};
    const keys=Object.keys(after).filter(k=>before[k]!==after[k]);
    if(keys.length) changed.push({m,after,keys});
  });
  if(!changed.length) return toast('ไม่มีการเปลี่ยนแปลงสิทธิ์');
  try{
    const batch=writeBatch(fs),eventId=makeEventId('PERM'),summary=[];
    changed.forEach(({m,after,keys})=>{
      batch.update(memberRef(m.uid),{permissions:after,approvalAssignedBy:state.user.uid,approvalAssignedAt:serverTimestamp()});
      const granted=keys.filter(k=>after[k]).map(k=>`✅ ${LABELS[k]}`);
      const revoked=keys.filter(k=>!after[k]).map(k=>`❌ ${LABELS[k]}`);
      summary.push(`${m.displayName||m.username}: ${[...granted,...revoked].join(', ')}`);
    });
    const detail=summary.join(' | '),logDoc=doc(logRef()),auditDoc=doc(auditRef());
    batch.set(logDoc,logPayload('แก้ไขสิทธิ์พนักงาน',detail,{eventId,changes:summary}));
    batch.set(auditDoc,auditPayload('แก้ไขสิทธิ์พนักงาน',detail,{eventId,changes:summary,logId:logDoc.id}));
    await batch.commit();
    hideModal(); toast(`บันทึกสิทธิ์แล้ว ${changed.length} คน`);
  }catch(e){ console.error(e); toast(`บันทึกไม่สำเร็จ (${e?.code||'unknown'})`); }
};
window.exportBackup=()=>{
  const clean=(items)=>items.map(({id,...data})=>({id,...data}));
  const data={version:'32.8',workspace:'main',products:clean(state.products),approvals:clean(state.approvals),logs:clean(state.logs),auditLogs:clean(state.auditLogs),exportedAt:new Date().toISOString(),exportedBy:state.profile?.displayName||state.profile?.username||''};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); const url=URL.createObjectURL(blob); a.href=url; a.download=`theview-backup-${toDateStr(new Date())}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.chooseBackupFile=()=>{ if(!requireAdmin()) return; $('backupInput').value=''; $('backupInput').click(); };
async function commitInChunks(ops){
  for(let i=0;i<ops.length;i+=400){ const batch=writeBatch(fs); ops.slice(i,i+400).forEach(op=>batch.set(op.ref,op.data,{merge:true})); await batch.commit(); }
}
$('backupInput')?.addEventListener('change',async e=>{
  const file=e.target.files?.[0]; if(!file||!requireAdmin()) return;
  if(!confirm('นำเข้าข้อมูล Backup และรวมกับข้อมูลปัจจุบันใช่หรือไม่? รายการ ID เดิมจะถูกอัปเดต')) return;
  try{
    const data=JSON.parse(await file.text());
    const groups=['products','approvals','logs','auditLogs']; const ops=[];
    for(const group of groups){
      if(!Array.isArray(data[group])) continue;
      for(const item of data[group]){ const {id,...rest}=item||{}; if(!id) continue; delete rest.createdAt; ops.push({ref:doc(fs,'theviewWorkspaces','main',group,id),data:{...rest,createdAt:serverTimestamp(),importedAt:serverTimestamp(),importedBy:state.user.uid}}); }
    }
    if(!ops.length) throw new Error('ไม่พบข้อมูลที่รองรับในไฟล์');
    await commitInChunks(ops); await addLog('นำเข้า Backup',`${ops.length} รายการ`); toast(`นำเข้าสำเร็จ ${ops.length} รายการ`);
  }catch(err){ console.error(err); toast(err?.message||'นำเข้า Backup ไม่สำเร็จ'); }
});
window.resetAccount=async()=>{ if(!requireAdmin()) return; const typed=prompt('การล้างข้อมูลจะลบสินค้า รายการอนุมัติ ประวัติการทำรายการ และทะเบียน SKU ถาวร\nAudit Log จะถูกเก็บไว้เพื่อการตรวจสอบย้อนหลัง\nควร Export Backup ก่อน\n\nพิมพ์คำว่า "ลบทั้งหมด" เพื่อยืนยัน'); if(typed===null) return; if(typed.trim()!=='ลบทั้งหมด'){ toast('ยกเลิก: ข้อความไม่ตรง'); return; } try{ for(const c of ['products','approvals','logs','skuRegistry']){ const snap=await getDocs(userPath(c)); for(let i=0;i<snap.docs.length;i+=400){ const batch=writeBatch(fs); snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref)); await batch.commit(); } } try{ await addAudit('ล้างข้อมูลส่วนกลาง','ล้างสินค้า รายการอนุมัติ ประวัติ และทะเบียน SKU โดยคง Audit Log ไว้'); }catch(_){ } toast('ล้างข้อมูลส่วนกลางแล้ว • เก็บ Audit Log ไว้เพื่อการตรวจสอบ'); }catch(e){ console.error('ล้างข้อมูลส่วนกลางไม่สำเร็จ',e); toast(e?.code==='permission-denied'?'ล้างข้อมูลไม่ได้: สิทธิ์ Firebase ไม่อนุญาตบางรายการ':'ล้างข้อมูลไม่สำเร็จ'); } };
let modalScrollY=0;
function openModal(t,b){
  const modal=$('modal');
  modalScrollY=window.scrollY||document.documentElement.scrollTop||0;
  $('modalTitle').textContent=t;
  $('modalBody').innerHTML=b;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  const sheet=modal.querySelector('.sheet');
  if(sheet){ sheet.scrollTop=0; sheet.style.pointerEvents='auto'; }
  // ให้ Safari คำนวณตำแหน่ง hitbox ใหม่หลัง modal แสดงจริง
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    modal.style.pointerEvents='auto';
    const first=$('modalBody').querySelector('select,input,textarea,button');
    if(first) first.style.pointerEvents='auto';
  }));
  refreshPasswordEyes($('modalBody'));
}
function hideModal(){
  if(state.profile?.mustChangePassword) return;
  $('modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  normalizeMobilePageScrollV329();
  requestAnimationFrame(()=>window.scrollTo(0,modalScrollY));
}
window.hideModal=hideModal;


// ---------- Modal controls: หลีกเลี่ยงชื่อชนกับ element id บน Safari ----------
$('modal').addEventListener('click',e=>{ if(e.target===$('modal')) hideModal(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && !$('modal').classList.contains('hidden')) hideModal(); });

// ---------- จำตำแหน่งหน้าและ scroll หลังรีเฟรช ----------
let scrollSaveTimer=null;
['touchstart','wheel','pointerdown'].forEach(type=>window.addEventListener(type,()=>{ if(scrollRestoreJob.active) cancelScrollRestore(); },{passive:true,capture:true}));
window.addEventListener('scroll',()=>{
  if($('app').classList.contains('hidden')) return;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer=setTimeout(saveCurrentPageScroll,80);
},{passive:true});
window.addEventListener('pagehide',()=>{ saveCurrentPageScroll(); saveUiState(); if(state.page==='scan') saveNewItemDraft(); });
window.addEventListener('beforeunload',()=>{ saveCurrentPageScroll(); saveUiState(); if(state.page==='scan') saveNewItemDraft(); });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden'){ saveCurrentPageScroll(); saveUiState(); if(state.page==='scan') saveNewItemDraft(); } });

window.addEventListener('error', (event) => {
  if(state.user && view) showLoadError('เกิดข้อผิดพลาดในหน้าเว็บ', event.error || new Error(event.message));
});
window.addEventListener('unhandledrejection', (event) => {
  if(state.user && view) showLoadError('คำสั่งทำงานไม่สำเร็จ', event.reason || new Error('Unhandled promise rejection'));
});


document.addEventListener('click',e=>{
  const wrap=e.target.closest?.('.scan-product-search-wrap');
  if(!wrap){ const box=$('scanProductResults'); if(box) box.classList.add('hidden'); }
});


// ---------- v34.6: Network Online / Offline Indicator ----------
let __networkStatusInitialized=false;
function ensureNetworkStatusIndicator(){
  let el=document.getElementById('networkStatusIndicator');
  if(el) return el;
  const hero=document.querySelector('.hero');
  if(!hero) return null;
  el=document.createElement('div');
  el.id='networkStatusIndicator';
  el.className='network-status-pill';
  el.setAttribute('role','status');
  el.setAttribute('aria-live','polite');
  const textWrap=hero.querySelector(':scope > div');
  if(textWrap) textWrap.appendChild(el); else hero.appendChild(el);
  return el;
}
function updateNetworkStatusIndicator(showMessage=false){
  const online=navigator.onLine!==false;
  const el=ensureNetworkStatusIndicator();
  if(el){
    el.classList.toggle('is-online',online);
    el.classList.toggle('is-offline',!online);
    el.innerHTML=online
      ? '<span class="network-dot" aria-hidden="true"></span><span>ออนไลน์</span>'
      : '<span class="network-dot" aria-hidden="true"></span><span>ออฟไลน์</span>';
    el.title=online?'อุปกรณ์เชื่อมต่อเครือข่ายอยู่':'อุปกรณ์ขาดการเชื่อมต่อเครือข่าย';
  }
  if(showMessage && __networkStatusInitialized){
    toast(online?'✅ กลับมาออนไลน์แล้ว ระบบพร้อมซิงก์ข้อมูล':'⚠️ ออฟไลน์อยู่ กรุณาตรวจสอบอินเทอร์เน็ตก่อนทำรายการสำคัญ');
  }
  __networkStatusInitialized=true;
}
window.addEventListener('online',()=>{
  updateNetworkStatusIndicator(true);
  // หากหน้าปัจจุบันเป็น Error State จากตอนออฟไลน์ ให้ลองเชื่อมข้อมูลใหม่อัตโนมัติ
  if(__lastLoadError && document.getElementById('appRetryButton')){
    setTimeout(()=>retryLastLoad(),350);
  }
});
window.addEventListener('offline',()=>updateNetworkStatusIndicator(true));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') updateNetworkStatusIndicator(false); });
window.addEventListener('pageshow',()=>updateNetworkStatusIndicator(false));
setTimeout(()=>updateNetworkStatusIndicator(false),0);

// ลงทะเบียน Service Worker เพื่อให้ใช้งาน offline ได้ (ฟรี ไม่มีค่าใช้จ่าย)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
  });
}
