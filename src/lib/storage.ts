// Node-only: imported by server routes and the explicit CLI, never client components.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BundleSchema, MachineSchema, MAX_RECORDS, emptyBundle, type Bundle, type Machine } from "./schema";
import { MachineDisplayNamesSchema, type MachineDisplayNames } from "./display-names";

// On Vercel the deployment directory is read-only; only /tmp is writable (and ephemeral), so the
// hosted demo keeps its local ledger there. Locally nothing changes: data/token-atlas.sqlite.
export function defaultDatabasePath(): string {
  if (process.env.TOKEN_ATLAS_DB) return process.env.TOKEN_ATLAS_DB;
  if (process.env.VERCEL) return "/tmp/token-atlas.sqlite";
  return resolve("data", "token-atlas.sqlite");
}

export class ImportConflictError extends Error {
  constructor() { super("This file conflicts with existing data. Keep machine attribution consistent and export again."); }
}
export class DatasetLimitError extends Error {
  constructor() { super("The local dataset limit is 100 machines and 20,000 records of each kind."); }
}
export interface MergeResult { addedMachines: number; addedUsage: number; addedPrompts: number; duplicates: number }

export class Ledger {
  private db: DatabaseSync;

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 1) { this.db.close(); throw new Error("Unsupported database version."); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS machine_display_names (
        machine_id TEXT PRIMARY KEY REFERENCES machines(id), member TEXT NOT NULL, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        machine_id TEXT NOT NULL REFERENCES machines(id), provider TEXT NOT NULL,
        id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (machine_id, provider, id)
      );
      CREATE TABLE IF NOT EXISTS prompts (
        machine_id TEXT NOT NULL REFERENCES machines(id), provider TEXT NOT NULL,
        id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (machine_id, provider, id)
      );
      PRAGMA user_version = 1;
    `);
  }

  readDisplayNames(): Map<string, MachineDisplayNames> {
    return new Map(this.db.prepare("SELECT machine_id, member, label FROM machine_display_names").all()
      .map((row) => [String(row.machine_id), MachineDisplayNamesSchema.parse({ member: row.member, label: row.label })]));
  }

  setDisplayNames(machineId: string, names: MachineDisplayNames): boolean {
    const machine = MachineSchema.parse({ id: machineId, ...names });
    const result = this.db.prepare(`
      INSERT INTO machine_display_names (machine_id, member, label)
      SELECT id, ?, ? FROM machines WHERE id = ?
      ON CONFLICT(machine_id) DO UPDATE SET member = excluded.member, label = excluded.label
    `).run(machine.member, machine.label, machine.id);
    return result.changes > 0;
  }

  resetDisplayNames(machineId: string): boolean {
    if (!this.db.prepare("SELECT id FROM machines WHERE id = ?").get(machineId)) return false;
    this.db.prepare("DELETE FROM machine_display_names WHERE machine_id = ?").run(machineId);
    return true;
  }

  read(includePrompts = true): Bundle {
    this.db.exec("BEGIN");
    try {
      const result = emptyBundle();
      result.machines = this.db.prepare("SELECT payload FROM machines ORDER BY id").all().map(parsePayload);
      result.usage = this.db.prepare("SELECT payload FROM usage ORDER BY machine_id, provider, id").all().map(parsePayload);
      if (includePrompts) result.prompts = this.db.prepare("SELECT payload FROM prompts ORDER BY machine_id, provider, id").all().map(parsePayload);
      const bundle = BundleSchema.parse(result);
      this.db.exec("COMMIT");
      return bundle;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  merge(input: unknown): MergeResult {
    const bundle = BundleSchema.parse(input);
    const result: MergeResult = { addedMachines: 0, addedUsage: 0, addedPrompts: 0, duplicates: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const findMachine = this.db.prepare("SELECT payload FROM machines WHERE id = ?");
      const addMachine = this.db.prepare("INSERT INTO machines VALUES (?, ?)");
      for (const machine of bundle.machines) {
        const payload = JSON.stringify(machine);
        const existing = findMachine.get(machine.id);
        if (existing) { if (existing.payload !== payload) throw new ImportConflictError(); }
        else { addMachine.run(machine.id, payload); result.addedMachines++; }
      }
      for (const table of ["usage", "prompts"] as const) {
        const find = this.db.prepare(`SELECT payload FROM ${table} WHERE machine_id = ? AND provider = ? AND id = ?`);
        const insert = this.db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
        for (const record of bundle[table]) {
          const payload = JSON.stringify(record);
          const existing = find.get(record.machineId, record.provider, record.id);
          if (existing) {
            if (existing.payload !== payload) throw new ImportConflictError();
            result.duplicates++;
          } else {
            insert.run(record.machineId, record.provider, record.id, payload);
            if (table === "usage") result.addedUsage++; else result.addedPrompts++;
          }
        }
      }
      for (const table of ["machines", "usage", "prompts"]) {
        const row = this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        if (row.n > (table === "machines" ? 100 : MAX_RECORDS)) throw new DatasetLimitError();
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { this.db.close(); }
}

function parsePayload(row: Record<string, unknown>) { return JSON.parse(String(row.payload)); }

export function withLedger<T>(action: (ledger: Ledger) => T): T {
  const ledger = new Ledger();
  try { return action(ledger); } finally { ledger.close(); }
}

/** Read existing attribution without creating a ledger or scanning provider folders. */
export function findImportedMachine(machineId: string): Machine | undefined {
  const path = defaultDatabasePath();
  // The ledger is runtime user data, never a build asset to include in tracing.
  if (path === ":memory:" || !existsSync(/* turbopackIgnore: true */ path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload FROM machines WHERE id = ?").get(machineId);
    return row ? MachineSchema.parse(parsePayload(row)) : undefined;
  } finally { db.close(); }
}
