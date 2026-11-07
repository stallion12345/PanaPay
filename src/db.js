import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const defaultDbPath = './data/panapay.db';
const configuredDbPath = process.env.DB_PATH || process.env.PANAPAY_DB_PATH || defaultDbPath;
const isTestRun = process.execArgv.some((arg) => arg.includes('--test'))
  || process.env.npm_lifecycle_event === 'test'
  || process.env.NODE_ENV === 'test'
  || String(process.env.NODE_TEST_CONTEXT || '').toLowerCase() === 'true'
  || process.env.NODE_TEST_CONTEXT === '1';
const resolvedDbPath = configuredDbPath === ':memory:' ? ':memory:' : path.resolve(process.cwd(), configuredDbPath);
const defaultResolvedDbPath = path.resolve(process.cwd(), defaultDbPath);

if (isTestRun && configuredDbPath !== ':memory:' && resolvedDbPath === defaultResolvedDbPath) {
  throw new Error('Refusing to open ./data/panapay.db while running under node --test. Set DB_PATH to :memory: or a temp file instead.');
}

export const db = new DatabaseSync(resolvedDbPath);

let dbInitialized = false;

export function initializeDb() {
  if (dbInitialized) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      weekly_spend_limit INTEGER NOT NULL,
      currency TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS party (
      id TEXT PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      type TEXT CHECK (type IN ('customer', 'supplier')) NOT NULL,
      name TEXT NOT NULL,
      paypal_email TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id)
    );

    CREATE TABLE IF NOT EXISTS ledger_entry (
      id TEXT PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      party_id TEXT,
      direction TEXT CHECK (direction IN ('in', 'out')) NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT CHECK (status IN ('pending', 'completed', 'failed', 'refunded')) NOT NULL,
      paypal_ref TEXT,
      category TEXT,
      category_confidence REAL,
      category_reason TEXT,
      description TEXT,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (party_id) REFERENCES party(id)
    );

    CREATE TABLE IF NOT EXISTS payout (
      id TEXT PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      party_id TEXT,
      amount_cents INTEGER NOT NULL,
      batch_id TEXT UNIQUE,
      item_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (party_id) REFERENCES party(id)
    );

    CREATE TABLE IF NOT EXISTS webhook_event (
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE,
      event_type TEXT,
      payload TEXT,
      signature_status TEXT,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      merchant_id INTEGER NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id)
    );

    CREATE TABLE IF NOT EXISTS support_thread (
      id TEXT PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      escalated INTEGER NOT NULL DEFAULT 0,
      escalation_reason TEXT,
      severity TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id)
    );

    CREATE TABLE IF NOT EXISTS support_message (
      id TEXT PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT CHECK (role IN ('user', 'assistant', 'system')) NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (thread_id) REFERENCES support_thread(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_payment (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      payment_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      UNIQUE (merchant_id, invoice_id, payment_id),
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (invoice_id) REFERENCES invoice(id)
    );

    CREATE TABLE IF NOT EXISTS customer (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      paypal_email TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id)
    );

    CREATE TABLE IF NOT EXISTS invoice (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      paypal_invoice_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      paid_cents INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT,
      source TEXT CHECK (source IN ('live', 'seeded')) NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (customer_id) REFERENCES customer(id)
    );

    CREATE TABLE IF NOT EXISTS customer_note (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      invoice_id INTEGER,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (customer_id) REFERENCES customer(id),
      FOREIGN KEY (invoice_id) REFERENCES invoice(id)
    );

    CREATE TABLE IF NOT EXISTS promise (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      invoice_id INTEGER,
      note_id INTEGER,
      reason TEXT,
      promised_date TEXT,
      promised_cents INTEGER,
      method TEXT,
      confidence REAL,
      status TEXT CHECK (status IN ('open', 'kept', 'broken', 'unconfirmed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (customer_id) REFERENCES customer(id),
      FOREIGN KEY (invoice_id) REFERENCES invoice(id),
      FOREIGN KEY (note_id) REFERENCES customer_note(id)
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id INTEGER PRIMARY KEY,
      merchant_id INTEGER NOT NULL,
      invoice_id INTEGER,
      action TEXT NOT NULL,
      reason_code TEXT,
      drafted_message TEXT,
      approved INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchant(id),
      FOREIGN KEY (invoice_id) REFERENCES invoice(id)
    );
  `);

  dbInitialized = true;
}

initializeDb();
ensureDefaultMerchant();

export function ensureDefaultMerchant() {
  const row = db.prepare('SELECT id FROM merchant WHERE id = 1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO merchant (id, name, weekly_spend_limit, currency)
      VALUES (?, ?, ?, ?)
    `).run(1, 'Default Merchant', 0, 'USD');
  }
}

export function getMerchantById(id) {
  return db.prepare('SELECT * FROM merchant WHERE id = ?').get(id);
}

export function upsertMerchant({ id, name, weekly_spend_limit, currency }) {
  return db.prepare(`
    INSERT INTO merchant (id, name, weekly_spend_limit, currency)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      weekly_spend_limit = excluded.weekly_spend_limit,
      currency = excluded.currency
  `).run(id, name, weekly_spend_limit, currency);
}

export function insertParty({ id, merchant_id, type, name, paypal_email }) {
  return db.prepare(`
    INSERT OR IGNORE INTO party (id, merchant_id, type, name, paypal_email)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, merchant_id, type, name, paypal_email ?? null);
}

export function insertWebhookEvent({ id, event_id, event_type, payload, signature_status, merchant_id }) {
  return db.prepare(`
    INSERT INTO webhook_event (id, event_id, event_type, payload, signature_status, merchant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, event_id, event_type, payload, signature_status, merchant_id);
}
