import * as vscode from 'vscode';

/**
 * Accesso ai metadati reali delle colonne (VARCHAR vs NVARCHAR) su SQL Server
 * tramite driver `tedious` (protocollo TDS, nessuna dipendenza nativa).
 *
 * La connessione è configurata via settings `vs-sqlview.db.*` e i risultati
 * sono cachati in memoria per non colpire il DB a ogni digitazione.
 */

export interface DbConnectionOptions {
  server: string;
  database: string;
  user: string;
  password: string;
  port: number;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectTimeoutMs: number;
}

export function readDbOptions(): { enabled: boolean; options: DbConnectionOptions } {
  const cfg = vscode.workspace.getConfiguration('vs-sqlview');
  const db = cfg.get<Record<string, unknown>>('db', {});
  const get = <T>(key: string, fallback: T): T => {
    const v = (db as Record<string, unknown>)[key];
    return (v === undefined || v === null ? fallback : v) as T;
  };
  return {
    enabled: get<boolean>('enabled', false),
    options: {
      server: get<string>('server', ''),
      database: get<string>('database', ''),
      user: get<string>('user', ''),
      password: get<string>('password', ''),
      port: get<number>('port', 1433),
      encrypt: get<boolean>('encrypt', true),
      trustServerCertificate: get<boolean>('trustServerCertificate', true),
      connectTimeoutMs: get<number>('connectTimeoutMs', 8000),
    },
  };
}

/** Mappa tabella-lowercase -> (colonna-lowercase -> tipo normalizzato). */
export type DbColumnTypeMap = Record<string, Record<string, string>>;

const cache = new Map<string, { at: number; types: DbColumnTypeMap }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(o: DbConnectionOptions, tables: string[]): string {
  return `${o.server}:${o.port}/${o.database}@${o.user}::${tables.map((t) => t.toLowerCase()).sort().join(',')}`;
}

export function clearDbSchemaCache(): void {
  cache.clear();
}

async function loadTedious(): Promise<typeof import('tedious')> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('tedious');
  } catch {
    throw new Error(
      'Driver "tedious" non trovato. Eseguire `npm install tedious` nella cartella dell\'estensione e ricompilare.'
    );
  }
}

/**
 * Legge DATA_TYPE di INFORMATION_SCHEMA.COLUMNS per le tabelle indicate.
 * Ritorna una mappa parziale: solo le tabelle/colonne trovate sul DB.
 */
export async function fetchDbColumnTypes(
  tables: string[],
  override?: DbConnectionOptions
): Promise<DbColumnTypeMap> {
  const all = readDbOptions();
  const options: DbConnectionOptions = override ?? all.options;
  const enabled = override ? true : all.enabled;
  if (!enabled) return {};
  if (!options.server || !options.database) {
    throw new Error('Connessione DB incompleta: impostare vs-sqlview.db.server e vs-sqlview.db.database.');
  }
  const uniq = [...new Set(tables.map((t) => t.trim()).filter(Boolean))];
  if (uniq.length === 0) return {};

  const key = cacheKey(options, uniq);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.types;

  const tedious = await loadTedious();
  const { Connection, Request } = tedious;

  const connection = new Connection({
    server: options.server,
    options: {
      port: options.port,
      database: options.database,
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      connectTimeout: options.connectTimeoutMs,
      rowCollectionOnRequestCompletion: true,
    },
    authentication: options.user
      ? { type: 'default', options: { userName: options.user, password: options.password } }
      : { type: 'default', options: { userName: '', password: '' } },
  });

  await new Promise<void>((resolve, reject) => {
    connection.on('connect', (err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
    connection.connect();
  });

  try {
    const names = uniq.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    const sql = `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${names})`;
    const rows: Array<Record<string, { value: unknown }>> = await new Promise((resolve, reject) => {
      const req = new Request(sql, (err: Error | undefined | null, _rowCount: number | undefined, rowsResult: unknown) => {
        if (err) reject(err);
        else resolve((rowsResult as Array<Record<string, { value: unknown }>>) ?? []);
      });
      connection.execSql(req);
    });

    const out: DbColumnTypeMap = {};
    for (const r of rows) {
      const table = String(r['TABLE_NAME']?.value ?? '');
      const col = String(r['COLUMN_NAME']?.value ?? '');
      const type = String(r['DATA_TYPE']?.value ?? '').toUpperCase();
      if (!table || !col || !type) continue;
      const tk = table.toLowerCase();
      out[tk] = out[tk] ?? {};
      // Conserva il nome reale, chiave lowercase per lookup case-insensitive
      (out[tk] as Record<string, string>)[col] = type;
      // Normalizza anche la chiave per i lookup
      const lowerEntries: Record<string, string> = {};
      for (const [k, v] of Object.entries(out[tk] as Record<string, string>)) {
        lowerEntries[k.toLowerCase()] = v;
      }
      // Mantiene entrambe le chiavi: originale e lowercase
      for (const [k, v] of Object.entries(lowerEntries)) {
        (out[tk] as Record<string, string>)[k] = v;
      }
    }
    cache.set(key, { at: Date.now(), types: out });
    return out;
  } finally {
    connection.close();
  }
}

/** Test di connettività: esegue SELECT 1 sul DB configurato. */
export async function testDbConnection(override?: DbConnectionOptions): Promise<string> {
  const options: DbConnectionOptions = override ?? readDbOptions().options;
  const tedious = await loadTedious();
  const { Connection, Request } = tedious;
  const connection = new Connection({
    server: options.server,
    options: {
      port: options.port,
      database: options.database,
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      connectTimeout: options.connectTimeoutMs,
      rowCollectionOnRequestCompletion: true,
    },
    authentication: {
      type: 'default',
      options: { userName: options.user, password: options.password },
    },
  });
  await new Promise<void>((resolve, reject) => {
    connection.on('connect', (err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
    connection.connect();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = new Request('SELECT 1', (err: Error | undefined | null) => {
        if (err) reject(err);
        else resolve();
      });
      connection.execSql(req);
    });
    return `${options.server}:${options.port}/${options.database}`;
  } finally {
    connection.close();
  }
}
