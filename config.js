// ═══════════════════════════════════════════════════════════
//  AMELI RENTAL — КОНФИГУРАЦИЯ
//  Когда получите новый URL из Google Apps Script —
//  вставьте его ТОЛЬКО ЗДЕСЬ и сохраните файл.
//  Оба файла (staff и dashboard) подхватят автоматически.
// ═══════════════════════════════════════════════════════════

const SCRIPT_URL = 'YOUR_SCRIPT_URL'; // боевые страницы → Supabase через api.js

// URL Apps Script ТОЛЬКО для синхронизации заказов Google Sheets → Supabase
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbxD4y2U6bG_IwcppaNaoEfEpOTGwVpnVONBy1PEptzsv3G63TzZxJDtmnHISn9B-PQ/exec';

// ── Supabase (новый бэкенд) ──────────────────────────────────────
// Publishable key — публичный, для фронтенда. Secret key сюда НЕ кладём.
const SUPABASE_URL = 'https://xkqaipggklmgussjphkp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_h7zhxKris7gY8i-dxOvx4w__cxxPIRX';
