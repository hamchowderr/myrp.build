/**
 * import_schema tool (fivem-studio-h5k) — runs a resource's SQL schema against the
 * server's database so the agent finishes the job instead of telling the user to
 * "import sql/install.sql manually".
 *
 * Why this is needed: FiveM/oxmysql does NOT auto-run a resource's install.sql —
 * tables must be created out-of-band. Previously the agent wrote the file and left
 * a manual-import note in the README. This tool reads the connection string the
 * server already uses (`set mysql_connection_string` in server.cfg), connects with
 * mysql2, and executes the schema.
 *
 * Safety / scope:
 *   - APPROVAL-GATED (requireApproval: true) — it mutates the user's database, so it
 *     always pauses for approve/decline (the chat.ts approval pump drives it).
 *   - Reads the connection string from server.cfg only — never takes credentials as
 *     input, never logs the password.
 *   - Idempotent by convention: generated schemas use CREATE TABLE IF NOT EXISTS, so
 *     re-running is safe. multipleStatements is enabled to run a full install.sql.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { createConnection } from "mysql2/promise";
import { z } from "zod";
import log from "../log";

export interface ImportSchemaToolConfig {
  /** resources/[local] dir where generated resources live (to resolve the sql file). */
  localPath: string;
  /** Path to the server's server.cfg — source of the mysql_connection_string. */
  serverCfgPath: string;
}

/** mysql2 connection input — a URI string (passed through) or parsed key-value options. */
type ConnInput =
  | string
  | { host: string; port?: number; user?: string; password?: string; database?: string };

/**
 * Extract the oxmysql connection string from server.cfg. Matches both
 * `set mysql_connection_string "..."` and `setr ... '...'` (single or double quoted).
 */
function extractConnectionString(cfg: string): string | null {
  const m = cfg.match(/mysql_connection_string\s+["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

/**
 * Parse an oxmysql connection string into mysql2 input. oxmysql accepts two forms:
 *   1. URI:        mysql://user:pass@host:port/database
 *   2. Key-value:  server=127.0.0.1;uid=root;password=;database=fivem;port=3306
 * URIs are handed to mysql2 verbatim; key-value is parsed (keys are case-insensitive
 * and oxmysql-flavoured: server/host, uid/user, password/pwd, database/db, port).
 */
function parseConnectionString(conn: string): ConnInput {
  if (/^mysql:\/\//i.test(conn)) return conn;

  const opts: { host: string; port?: number; user?: string; password?: string; database?: string } =
    {
      host: "localhost",
    };
  for (const pair of conn.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const val = pair.slice(idx + 1).trim();
    switch (key) {
      case "server":
      case "host":
        opts.host = val;
        break;
      case "uid":
      case "user":
      case "userid":
      case "user id":
        opts.user = val;
        break;
      case "password":
      case "pwd":
        opts.password = val;
        break;
      case "database":
      case "db":
        opts.database = val;
        break;
      case "port":
        opts.port = Number.parseInt(val, 10) || undefined;
        break;
      default:
        break;
    }
  }
  return opts;
}

/** Pull created table names out of the schema so we can report what was made. */
function tableNamesFromSql(sql: string): string[] {
  const names: string[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)[`"]?/gi;
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    names.push(m[1]);
    m = re.exec(sql);
  }
  return [...new Set(names)];
}

export function createImportSchemaTool(cfg: ImportSchemaToolConfig) {
  return createTool({
    id: "import_schema",
    description:
      "Run a resource's SQL schema against the server's database so its tables actually exist. FiveM/oxmysql does NOT auto-run install.sql — call this after writing a resource's sql file (e.g. sql/install.sql) so the user does not have to import it by hand. Reads the connection string from server.cfg automatically. Requires user approval (it writes to the database). Returns the tables it created; if the connection string is missing or the import fails, it says so — then (and only then) tell the user to import the file manually.",
    inputSchema: z.object({
      resource: z
        .string()
        .describe(
          "The resource folder name under [local]/ whose schema to import, e.g. 'paleto-mdt'.",
        ),
      sqlFile: z
        .string()
        .default("sql/install.sql")
        .describe(
          "Path to the SQL file, relative to the resource folder. Defaults to sql/install.sql.",
        ),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      imported: z.boolean(),
      tables: z.array(z.string()),
      message: z.string(),
    }),
    requireApproval: true,
    execute: async (input) => {
      const { resource } = input;
      // Defaulted in the schema, but Mastra types it from the input shape (optional).
      const sqlFile = input.sqlFile ?? "sql/install.sql";

      // 1. Resolve + read the schema file.
      const sqlPath = isAbsolute(sqlFile) ? sqlFile : join(cfg.localPath, resource, sqlFile);
      let sql: string;
      try {
        sql = await readFile(sqlPath, "utf-8");
      } catch {
        return {
          ok: false,
          imported: false,
          tables: [],
          message: `Could not read the SQL file at ${sqlPath}. Make sure the resource wrote its schema there.`,
        };
      }
      if (!sql.trim()) {
        return {
          ok: false,
          imported: false,
          tables: [],
          message: `${sqlPath} is empty — nothing to import.`,
        };
      }

      // 2. Read the connection string from server.cfg.
      let connString: string | null = null;
      try {
        connString = extractConnectionString(await readFile(cfg.serverCfgPath, "utf-8"));
      } catch {
        // fall through to the not-found message below
      }
      if (!connString) {
        return {
          ok: false,
          imported: false,
          tables: [],
          message:
            "No mysql_connection_string found in server.cfg — can't connect to import the schema. Tell the user to import the SQL file manually (or set the connection string and retry).",
        };
      }

      // 3. Connect and run the schema (multi-statement). Never log the password.
      const tables = tableNamesFromSql(sql);
      const connInput = parseConnectionString(connString);
      let conn: Awaited<ReturnType<typeof createConnection>> | undefined;
      try {
        conn =
          typeof connInput === "string"
            ? await createConnection({ uri: connInput, multipleStatements: true })
            : await createConnection({ ...connInput, multipleStatements: true });
        await conn.query(sql);
        log.info(`[import-schema] ${resource}: imported ${tables.length} table(s)`);
        return {
          ok: true,
          imported: true,
          tables,
          message:
            tables.length > 0
              ? `Imported ${resource}'s schema — created/verified table(s): ${tables.join(", ")}.`
              : `Ran ${resource}'s SQL successfully.`,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`[import-schema] ${resource} failed: ${reason}`);
        return {
          ok: false,
          imported: false,
          tables,
          message: `Failed to import ${resource}'s schema: ${reason}. The user may need to import ${sqlFile} manually.`,
        };
      } finally {
        await conn?.end().catch(() => {});
      }
    },
  });
}
