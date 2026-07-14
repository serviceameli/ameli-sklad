// ═══════════════════════════════════════════════════════════
//  AMELI RENTAL — КОНФИГУРАЦИЯ
//  Когда получите новый URL из Google Apps Script —
//  вставьте его ТОЛЬКО ЗДЕСЬ и сохраните файл.
//  Оба файла (staff и dashboard) подхватят автоматически.
// ═══════════════════════════════════════════════════════════

const SCRIPT_URL = 'YOUR_SCRIPT_URL'; // боевые страницы → Supabase через api.js

// URL Apps Script ТОЛЬКО для синхронизации заказов Google Sheets → Supabase
const SYNC_URL = 'https://script.google.com/macros/s/AKfycby9afDG1NPl2U9n-7pEV4rSfqoyWoXCHBM1LesH2zRXfOZ4mtly8yCB0prAx6Twcnc/exec';

// ── Supabase (новый бэкенд) ──────────────────────────────────────
// Publishable key — публичный, для фронтенда. Secret key сюда НЕ кладём.
const SUPABASE_URL = 'https://xkqaipggklmgussjphkp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_h7zhxKris7gY8i-dxOvx4w__cxxPIRX';
