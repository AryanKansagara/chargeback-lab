// Names that come from data (teams, users, warehouses, services) are used as object keys. On a plain object
// "constructor", "toString" and "hasOwnProperty" read back inherited functions, and assigning "__proto__"
// changes the prototype instead of storing the value. These helpers keep every name an ordinary key.

/** An empty record with no prototype: any string, "__proto__" included, is just a key. */
export const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

/** Reads an own key only; undefined for names that merely exist on Object.prototype. */
export const own = <T>(o: Record<string, T> | null | undefined, k: string): T | undefined =>
  o != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined

/** Stores a key on a record that may have a normal prototype, even when the key is "__proto__". */
export function put<T>(o: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
}
