/**
 * SqliteStore — Persistent LangGraph BaseStore backed by better-sqlite3
 *
 * Drop-in replacement for InMemoryStore. Implements only the abstract
 * `batch()` method; all convenience methods (get, put, search, delete,
 * listNamespaces) are inherited from BaseStore and delegate to batch().
 *
 * Search is an exact prefix match on namespaces (no wildcards, case-sensitive) and supports
 * value filters; semantic `query` search is not supported. Items older than the store
 * retention period are deleted by the retention job (retention.ts).
 */

import type Database from "better-sqlite3";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
  Item,
  SearchItem,
  Operation,
  OperationResults,
  GetOperation,
  PutOperation,
  SearchOperation,
  ListNamespacesOperation,
  MatchCondition,
} from "@langchain/langgraph-checkpoint";

// =============================================================================
// Type Guards
// =============================================================================

function isGetOp(op: Operation): op is GetOperation {
  return "namespace" in op && "key" in op && !("value" in op) && !("namespacePrefix" in op);
}

function isPutOp(op: Operation): op is PutOperation {
  return "namespace" in op && "key" in op && "value" in op;
}

function isSearchOp(op: Operation): op is SearchOperation {
  return "namespacePrefix" in op;
}

function isListNamespacesOp(op: Operation): op is ListNamespacesOperation {
  return "matchConditions" in op || ("limit" in op && !("key" in op) && !("namespacePrefix" in op));
}

// =============================================================================
// SqliteStore
// =============================================================================

interface StoreRow {
  namespace: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_SEARCH_LIMIT = 10;

function prepareStatements(db: Database.Database) {
  const columns = "namespace, key, value, created_at, updated_at";
  return {
    get: db.prepare<[string, string], StoreRow>(
      `SELECT ${columns} FROM store_items WHERE namespace = ? AND key = ?`,
    ),
    put: db.prepare(
      `INSERT INTO store_items (namespace, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ),
    delete: db.prepare("DELETE FROM store_items WHERE namespace = ? AND key = ?"),
    searchAll: db.prepare<[], StoreRow>(
      `SELECT ${columns} FROM store_items ORDER BY namespace, key`,
    ),
    searchAllPage: db.prepare<[number, number], StoreRow>(
      `SELECT ${columns} FROM store_items ORDER BY namespace, key LIMIT ? OFFSET ?`,
    ),
    // Exact, case-sensitive prefix match on the JSON-encoded namespace: the namespace itself, or
    // one that starts with the prefix followed by another segment. substr() compares text
    // exactly, so `_`, `%` and letter case in namespaces carry no special meaning.
    searchPrefix: db.prepare<{ ns: string; child: string }, StoreRow>(
      `SELECT ${columns} FROM store_items
       WHERE namespace = :ns OR substr(namespace, 1, length(:child)) = :child
       ORDER BY namespace, key`,
    ),
    searchPrefixPage: db.prepare<
      { ns: string; child: string; limit: number; offset: number },
      StoreRow
    >(
      `SELECT ${columns} FROM store_items
       WHERE namespace = :ns OR substr(namespace, 1, length(:child)) = :child
       ORDER BY namespace, key
       LIMIT :limit OFFSET :offset`,
    ),
    namespaces: db.prepare<[], { namespace: string }>(
      "SELECT DISTINCT namespace FROM store_items ORDER BY namespace",
    ),
  };
}

function toItem(row: StoreRow): Item {
  return {
    value: JSON.parse(row.value),
    key: row.key,
    namespace: JSON.parse(row.namespace),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SqliteStore extends BaseStore {
  private readonly stmt: ReturnType<typeof prepareStatements>;

  constructor(db: Database.Database) {
    super();
    this.stmt = prepareStatements(db);
  }

  /**
   * Runs each operation in order. A failed write (put or delete) rejects the batch so the caller
   * sees it; a failed read is logged and returns null (get) or an empty list (search, list).
   */
  async batch<Op extends readonly Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];

    for (const op of operations) {
      if (isPutOp(op)) {
        this.handlePut(op);
        results.push(undefined);
        continue;
      }
      try {
        if (isGetOp(op)) {
          results.push(this.handleGet(op));
        } else if (isSearchOp(op)) {
          results.push(this.handleSearch(op));
        } else if (isListNamespacesOp(op)) {
          results.push(this.handleListNamespaces(op));
        } else {
          results.push(null);
        }
      } catch (err) {
        console.error("[SqliteStore] Read error:", err);
        results.push(isSearchOp(op) || isListNamespacesOp(op) ? [] : null);
      }
    }

    return results as OperationResults<Op>;
  }

  // ---------------------------------------------------------------------------
  // Operation Handlers
  // ---------------------------------------------------------------------------

  private handleGet(op: GetOperation): Item | null {
    const row = this.stmt.get.get(JSON.stringify(op.namespace), op.key);
    return row ? toItem(row) : null;
  }

  private handlePut(op: PutOperation): void {
    const nsKey = JSON.stringify(op.namespace);
    if (op.value === null) {
      this.stmt.delete.run(nsKey, op.key);
      return;
    }
    const now = new Date().toISOString();
    this.stmt.put.run(nsKey, op.key, JSON.stringify(op.value), now, now);
  }

  /** Prefix search. A filter is applied before offset and limit, so it sees every match. */
  private handleSearch(op: SearchOperation): SearchItem[] {
    const limit = op.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = op.offset ?? 0;
    const filter = op.filter;

    const ns = JSON.stringify(op.namespacePrefix);
    // '["a","b"]' -> '["a","b",' : the start of every namespace below ["a","b"].
    const child = `${ns.slice(0, -1)},`;
    const all = op.namespacePrefix.length === 0;

    if (!filter || Object.keys(filter).length === 0) {
      const rows = all
        ? this.stmt.searchAllPage.all(limit, offset)
        : this.stmt.searchPrefixPage.all({ ns, child, limit, offset });
      return rows.map(toItem);
    }

    const rows = all ? this.stmt.searchAll.all() : this.stmt.searchPrefix.all({ ns, child });
    return rows
      .map(toItem)
      .filter((item) => matchesFilter(item.value, filter))
      .slice(offset, offset + limit);
  }

  private handleListNamespaces(op: ListNamespacesOperation): string[][] {
    let namespaces: string[][] = this.stmt.namespaces
      .all()
      .map((r) => JSON.parse(r.namespace) as string[]);

    // Apply match conditions
    if (op.matchConditions && op.matchConditions.length > 0) {
      for (const condition of op.matchConditions) {
        namespaces = namespaces.filter((ns) => matchesCondition(ns, condition));
      }
    }

    // Apply maxDepth
    if (op.maxDepth != null) {
      const depth = op.maxDepth;
      namespaces = namespaces
        .map((ns) => ns.slice(0, depth))
        .filter(
          (ns, i, arr) =>
            arr.findIndex((other) => JSON.stringify(other) === JSON.stringify(ns)) === i,
        );
    }

    // Apply offset and limit
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 100;
    return namespaces.slice(offset, offset + limit);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function matchesCondition(ns: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;

  if (matchType === "prefix") {
    if (path.length > ns.length) return false;
    return path.every((seg, i) => seg === "*" || seg === ns[i]);
  }

  if (matchType === "suffix") {
    if (path.length > ns.length) return false;
    const offset = ns.length - path.length;
    return path.every((seg, i) => seg === "*" || seg === ns[offset + i]);
  }

  return true;
}

/**
 * Simple filter matching: check if the value object matches all filter conditions.
 * Supports direct equality and operator objects ($eq, $ne, $gt, $gte, $lt, $lte).
 */
function matchesFilter(value: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const actual = value[key];

    if (condition != null && typeof condition === "object" && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      if ("$eq" in ops && actual !== ops.$eq) return false;
      if ("$ne" in ops && actual === ops.$ne) return false;
      if ("$gt" in ops && !(typeof actual === "number" && actual > (ops.$gt as number)))
        return false;
      if ("$gte" in ops && !(typeof actual === "number" && actual >= (ops.$gte as number)))
        return false;
      if ("$lt" in ops && !(typeof actual === "number" && actual < (ops.$lt as number)))
        return false;
      if ("$lte" in ops && !(typeof actual === "number" && actual <= (ops.$lte as number)))
        return false;
    } else {
      // Direct equality
      if (actual !== condition) return false;
    }
  }
  return true;
}
